#!/usr/bin/env python
"""G0 の負荷試験: 2ch 実音声を実時間で流す（単独、またはブラウザ描画と同時）。

1 スレッドで 20ms ごとの期限に合わせて process() を呼ぶ。入力の到着を期限で模擬するので、
`backlog_ms = 現在時刻 - そのチャンクの到着期限` が受信キューの滞留に相当する。

素材は jpn_mix（265.7 秒）→ eng_mix（186.8 秒）の順に連結し、必要なら繰り返す（5 分以上にするため）。
**同じ会話の繰り返しや別言語の連結であり、連続した 1 会話ではない。**

  python probe_soak.py --minutes 5.5 --out soak_alone.json --tag alone
"""
from __future__ import annotations

import argparse
import os
import time

import numpy as np

from probe_common import (
    CHUNK_20MS,
    DirectRunner,
    SR,
    load_wav,
    pct,
    peak_rss_mb,
    rss_mb,
    save_result,
    system_busy_cores,
    system_cpu,
)


def cpu_times():
    t = os.times()
    return t.user + t.system


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=5.5)
    ap.add_argument("--lang", default="jp_kyoto")
    ap.add_argument("--model-type", default="normal-ver2")
    ap.add_argument("--frame-rate", type=float, default=12.5)
    ap.add_argument("--no-mc", action="store_true")
    ap.add_argument("--torch-threads", type=int, default=None)
    ap.add_argument("--ort-threads", type=int, default=None)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tag", default="alone")
    a = ap.parse_args()

    kw = {}
    if a.ort_threads:
        kw["mimi_onnx_cpu_intra_threads"] = a.ort_threads
    r = DirectRunner(
        lang=a.lang,
        model_type=a.model_type,
        frame_rate=a.frame_rate,
        mc=not a.no_mc,
        torch_threads=a.torch_threads,
        **kw,
    )
    spf = r.samples_per_frame
    budget = spf / SR
    jp, en = load_wav("jpn_mix_16k.wav"), load_wav("eng_mix_16k.wav")
    audio = np.concatenate([jp, en])
    total = int(a.minutes * 60 * SR) // CHUNK_20MS
    print(r.config, "load", round(r.load_s, 2), "chunks", total, flush=True)

    proc, emit_proc, backlog, emit_latency = [], [], [], []
    rss_series = []
    n_results = 0
    nan = 0
    psum_err = 0.0
    n_over = 0
    cpu0 = cpu_times()
    sys0 = system_cpu()
    t0 = time.perf_counter()
    for i in range(total):
        due = t0 + (i + 1) * CHUNK_20MS / SR  # このチャンクの全サンプルが揃う時刻
        d = due - time.perf_counter()
        if d > 0:
            time.sleep(d)
        start = time.perf_counter()
        backlog.append(start - due)
        j = (i * CHUNK_20MS) % (len(audio) - CHUNK_20MS)
        fs = r.feed(audio[j : j + CHUNK_20MS, 0], audio[j : j + CHUNK_20MS, 1])
        end = time.perf_counter()
        proc.append(end - start)
        if fs:
            f = fs[0]
            n_results += 1
            emit_proc.append(end - start)
            emit_latency.append(end - due)  # 音声が揃ってから結果が得られるまで
            if end - start > budget:
                n_over += 1
            if np.isnan(f.p_now).any() or np.isnan(f.vad).any():
                nan += 1
            psum_err = max(psum_err, abs(sum(f.p_now) - 1.0))
        if i % (60 * 50) == 0:
            rss_series.append(round(rss_mb(), 1))
    wall = time.perf_counter() - t0
    cpu = cpu_times() - cpu0
    busy = system_busy_cores(sys0, system_cpu())
    rss_series.append(round(rss_mb(), 1))
    ep = np.asarray(emit_proc[10:])
    bl = np.asarray(backlog) * 1000
    half = len(ep) // 2
    out = {
        "tag": a.tag,
        "config": r.config,
        "threads": {
            "torch": a.torch_threads or "default",
            "onnx_intra": getattr(getattr(r.m.vap, "encoder1", None), "_onnx_cpu_intra_threads", None),
        },
        "material": "jpn_mix_16k + eng_mix_16k を連結（公式 sample）。実時間で投入",
        "audio_fed_s": round(total * CHUNK_20MS / SR, 1),
        "wall_s": round(wall, 1),
        "expected_results": total * CHUNK_20MS // spf - (1 if r.m.encoder_type == "mimi" else 0),
        "n_results": n_results,
        "frame_budget_ms": budget * 1000,
        "rtf_p50": round(pct(ep, 50) / budget, 3),
        "rtf_p95": round(pct(ep, 95) / budget, 3),
        "rtf_p99": round(pct(ep, 99) / budget, 3),
        "rtf_max": round(float(ep.max()) / budget, 3),
        "rtf_p95_first_half": round(pct(ep[:half], 95) / budget, 3),
        "rtf_p95_second_half": round(pct(ep[half:], 95) / budget, 3),
        "frames_over_budget": n_over,
        "backlog_ms_p50": round(pct(bl, 50), 2),
        "backlog_ms_p95": round(pct(bl, 95), 2),
        "backlog_ms_p99": round(pct(bl, 99), 2),
        "backlog_ms_max": round(float(bl.max()), 2),
        "backlog_ms_last_10s_max": round(float(bl[-500:].max()), 2),
        "chunks_late_gt_1_frame": int((bl > budget * 1000).sum()),
        "result_latency_ms_p50": round(pct(emit_latency, 50) * 1000, 1),
        "result_latency_ms_p95": round(pct(emit_latency, 95) * 1000, 1),
        "result_latency_ms_max": round(float(np.max(emit_latency)) * 1000, 1),
        "nan_results": nan,
        "p_now_sum_max_abs_err": psum_err,
        "cpu_core_usage": round(cpu / wall, 2),
        "system_busy_cores_all_processes": busy,
        "rss_mb_per_minute": rss_series,
        "peak_rss_mb": round(peak_rss_mb()),
        "loadavg_end": open("/proc/loadavg").read().split()[:3],
    }
    print(out, flush=True)
    print("saved", save_result(a.out, out))


if __name__ == "__main__":
    main()
