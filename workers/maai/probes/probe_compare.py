#!/usr/bin/env python
"""重み・model_type・mc の比較。構成ごとに別プロセスで 1 本ずつ実行する（メモリを分けて測るため）。

指標: ロード時間（2 回目以降のキャッシュ済み）、RTF の p50/p95（as-fast-as-possible で 1 スレッド呼び出し）、
RSS、無音チャネルでの挙動、既知区間での向き、素材に対する参考スコア。

  python probe_compare.py            # 全構成
  python probe_compare.py --one '{"lang":"jp_kyoto",...}'
  python probe_compare.py --threads  # 既定候補のスレッド数の掃引
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time

import numpy as np

from probe_common import (
    CHUNK_20MS,
    SR,
    arr,
    load_wav,
    pct,
    peak_rss_mb,
    rss_mb,
    save_result,
    system_busy_cores,
    system_cpu,
)

V2 = dict(model_type="normal-ver2", frame_rate=12.5)
CPC = dict(model_type="normal", frame_rate=10)
CONFIGS = [
    dict(lang=l, mc=mc, **t)
    for t in (V2, CPC)
    for l in ("jp_kyoto", "jp")
    for mc in (True, False)
] + [
    dict(lang="jp", mc=True, mono=True, **V2),
    dict(lang="jp", mc=False, mono=True, **V2),
    dict(lang="jp", mc=False, mono=True, **CPC),
    # Mimi の int8（CPU 向け。fp32 との差は参照実行で確認）
    dict(lang="jp_kyoto", mc=True, mimi_onnx_precision="int8", **V2),
    dict(lang="jp", mc=True, mimi_onnx_precision="int8", **V2),
]
# スレッド掃引（thread_sweep.json）で最も良かった torch=4, onnx intra=4 に揃える
for _c in CONFIGS:
    _c["torch_threads"] = 4


def timed_run(r, a):
    """呼び出しごとの時間を測りつつ流す。"""
    frames, times = [], []
    for i in range(0, len(a) - CHUNK_20MS + 1, CHUNK_20MS):
        t = time.perf_counter()
        fs = r.feed(a[i : i + CHUNK_20MS, 0], a[i : i + CHUNK_20MS, 1])
        dt = time.perf_counter() - t
        if fs:
            times.append(dt)
            frames.extend(fs)
    return frames, np.asarray(times)


def one(cfg: dict) -> dict:
    t_all = time.perf_counter()
    from probe_common import DirectRunner, import_maai

    import_maai()
    t_import = time.perf_counter() - t_all
    rss0 = rss_mb()
    r = DirectRunner(**cfg)
    out = {
        "config": cfg,
        "variant": r.m.variant,
        "is_mono": r.m.is_mono,
        "import_s": round(t_import, 2),
        "load_s": round(r.load_s, 2),
        "rss_before_load_mb": round(rss0),
        "rss_after_load_mb": round(rss_mb()),
        "loadavg_start": open("/proc/loadavg").read().split()[:3],
    }
    budget = r.samples_per_frame / SR
    mix = load_wav("jpn_mix_16k.wav")

    sys0 = system_cpu()
    t_run = time.perf_counter()
    frames, times = timed_run(r, mix)
    run_wall = time.perf_counter() - t_run
    wt = times[10:]
    out["rtf"] = {
        "run_wall_s": round(run_wall, 1),
        "system_busy_cores_all_processes": system_busy_cores(sys0, system_cpu()),
        "audio_s": round(len(mix) / SR, 1),
        "n": len(wt),
        "frame_budget_ms": budget * 1000,
        "proc_ms_p50": round(pct(wt, 50) * 1000, 1),
        "proc_ms_p95": round(pct(wt, 95) * 1000, 1),
        "proc_ms_max": round(float(wt.max()) * 1000, 1),
        "rtf_p50": round(pct(wt, 50) / budget, 3),
        "rtf_p95": round(pct(wt, 95) / budget, 3),
        "rtf_p99": round(pct(wt, 99) / budget, 3),
        "rtf_mean": round(float(wt.mean()) / budget, 3),
    }
    out["rss_after_run_mb"] = round(rss_mb())

    if not r.m.is_mono:
        from probe_direction import build_timeline, frame_activity, next_speaker_scores, run_timeline, series

        s = series(frames)
        act = frame_activity(mix, s["t"])
        out["scores_on_material"] = next_speaker_scores(s, act)
        # 無音チャネル 2 種（2ch モデル）
        n = 40 * SR
        one_ch = np.zeros((n, 2), dtype=np.float32)
        one_ch[:, 0] = mix[: n, 0]
        r.reset()
        fs = r.run(one_ch)
        for_active = frame_activity(one_ch, np.asarray([f.end_sample / SR for f in fs]))
        pn, pf, vd = arr(fs, "p_now"), arr(fs, "p_future"), arr(fs, "vad")
        out["ch2_zero"] = {
            "p_now_mean": pn.mean(0).round(4).tolist(),
            "p_future_mean": pf.mean(0).round(4).tolist(),
            "vad_mean": vd.mean(0).round(4).tolist(),
            "vad_ch2_p95": round(pct(vd[:, 1], 95), 4),
            "p_now_ch2_max": round(float(pn[:, 1].max()), 4),
            "p_future_ch2_max": round(float(pf[:, 1].max()), 4),
            "p_now_ch2_gt_0.5_frac_ch1_silent": round(float((pn[~for_active[:, 0], 1] > 0.5).mean()), 4),
            "p_future_ch2_gt_0.5_frac_ch1_silent": round(float((pf[~for_active[:, 0], 1] > 0.5).mean()), 4),
        }
        r.reset()
        fs = r.run(np.zeros((20 * SR, 2), dtype=np.float32))
        pn, pf, vd = arr(fs, "p_now"), arr(fs, "p_future"), arr(fs, "vad")
        out["both_zero"] = {
            "any_nan": bool(np.isnan(pn).any() or np.isnan(vd).any()),
            "p_now_mean": pn.mean(0).round(4).tolist(),
            "p_future_mean": pf.mean(0).round(4).tolist(),
            "vad_mean": vd.mean(0).round(4).tolist(),
        }
        x, _ = build_timeline(mix[:, 0], mix[:, 1])
        tl = run_timeline(r, x)
        out["direction"] = {
            k: tl["stats"][k]
            for k in ("ch1_only_active", "ch2_only_active", "alternating_ch1_turn", "alternating_ch2_turn")
        }
        lg = {k: [v for v in vs if v is not None] for k, vs in tl["lags_s"].items()}
        out["switch_lag_median_s"] = {k: (float(np.median(v)) if v else None) for k, v in lg.items()}
    else:
        # 1ch: スカラー。ch1 の活動との関係
        from probe_direction import frame_activity

        t = np.asarray([f.end_sample / SR for f in frames])
        act = frame_activity(mix, t)[:, 0]
        pn, pf, vd = arr(frames, "p_now"), arr(frames, "p_future"), arr(frames, "vad")
        out["mono_on_material"] = {
            "p_now_when_active": round(float(pn[act].mean()), 4),
            "p_now_when_inactive": round(float(pn[~act].mean()), 4),
            "p_future_when_active": round(float(pf[act].mean()), 4),
            "p_future_when_inactive": round(float(pf[~act].mean()), 4),
            "vad_vs_energy_agreement": round(float(((vd > 0.5) == act).mean()), 4),
        }
        r.reset()
        fs = r.run(np.zeros((20 * SR, 2), dtype=np.float32))
        out["both_zero"] = {
            "any_nan": bool(np.isnan(arr(fs, "p_now")).any()),
            "p_now_mean": round(float(arr(fs, "p_now").mean()), 4),
            "p_future_mean": round(float(arr(fs, "p_future").mean()), 4),
            "vad_mean": round(float(arr(fs, "vad").mean()), 4),
        }
    out["peak_rss_mb"] = round(peak_rss_mb())
    out["loadavg_end"] = open("/proc/loadavg").read().split()[:3]
    return out


def thread_sweep_one(cfg: dict) -> dict:
    from probe_common import DirectRunner

    r = DirectRunner(**cfg)
    mix = load_wav("jpn_mix_16k.wav")[: 90 * SR]
    sys0 = system_cpu()
    _, times = timed_run(r, mix)
    busy = system_busy_cores(sys0, system_cpu())
    wt, budget = times[10:], r.samples_per_frame / SR
    return {
        "config": cfg,
        "rtf_p50": round(pct(wt, 50) / budget, 3),
        "rtf_p95": round(pct(wt, 95) / budget, 3),
        "rtf_p99": round(pct(wt, 99) / budget, 3),
        "system_busy_cores_all_processes": busy,
        "loadavg_end": open("/proc/loadavg").read().split()[:3],
    }


def spawn(flag: str, cfg: dict) -> dict:
    p = subprocess.run(
        [sys.executable, __file__, flag, json.dumps(cfg)],
        capture_output=True,
        text=True,
    )
    for line in reversed(p.stdout.splitlines()):
        if line.startswith("RESULT "):
            return json.loads(line[7:])
    return {"config": cfg, "error": (p.stderr or p.stdout)[-800:]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--one")
    ap.add_argument("--sweep-one")
    ap.add_argument("--threads", action="store_true")
    ap.add_argument("--lang", default="jp_kyoto")
    a = ap.parse_args()
    if a.one:
        print("RESULT " + json.dumps(one(json.loads(a.one))))
        return
    if a.sweep_one:
        print("RESULT " + json.dumps(thread_sweep_one(json.loads(a.sweep_one))))
        return
    if a.threads:
        res = []
        for tt, ort in ((8, 4), (4, 4), (2, 2), (4, 2), (2, 4), (1, 1)):
            cfg = dict(lang=a.lang, mc=True, torch_threads=tt, mimi_onnx_cpu_intra_threads=ort, **V2)
            x = spawn("--sweep-one", cfg)
            print(x, flush=True)
            res.append(x)
        save_result("thread_sweep.json", res)
        return

    results = []
    for cfg in CONFIGS:
        # 取得（初回のみダウンロードが走る）をロード時間から除くための予備ロード
        pre = subprocess.run(
            [
                sys.executable,
                "-c",
                "import sys,json;sys.path.insert(0,%r);from probe_common import DirectRunner;"
                "DirectRunner(**json.loads(sys.argv[1]))" % str(__file__.rsplit("/", 1)[0]),
                json.dumps(cfg),
            ],
            capture_output=True,
            text=True,
        )
        if pre.returncode:
            print("PREFETCH FAILED", cfg, pre.stderr[-300:], flush=True)
        x = spawn("--one", cfg)
        print(json.dumps(x, ensure_ascii=False), flush=True)
        results.append(x)
        save_result("compare.json", results)


if __name__ == "__main__":
    main()
