#!/usr/bin/env python
"""無音チャネルのゼロ埋め、片チャネル欠損、両チャネル破棄での出力の変化。

基準は jpn_mix の先頭 90 秒。t=40 秒から各種の欠損を入れ、基準との差と回復時間を測る。
「回復」= 欠損終了後、|p_now[0] の基準との差| < 0.05 が 1 秒続くまでの時間。

  python probe_degradation.py [--lang jp_kyoto] [--model-type normal-ver2] [--frame-rate 12.5]
"""
from __future__ import annotations

import argparse

import numpy as np

from probe_common import CHUNK_20MS, DirectRunner, SR, arr, frame_times, load_wav, save_result

START_S, DUR_S = 40.0, 2.0


def recovery(t, diff, end_s, hold_s=1.0):
    dt = float(np.median(np.diff(t)))
    w = max(1, int(hold_s / dt))
    idx = np.where(t > end_s)[0]
    for i in idx:
        if i + w < len(diff) and diff[i : i + w].max() < 0.05:
            return round(float(t[i] - end_s), 3)
    return None


def evaluate(base_t, base_pn, base_vad, t, pn, vd, end_s):
    assert np.array_equal(base_t, t), "時間軸が一致しない"
    d = np.abs(pn[:, 0] - base_pn[:, 0])
    during = (t > START_S) & (t <= end_s)
    after = (t > end_s) & (t <= end_s + 10)
    return {
        "p_now_abs_diff_during": round(float(d[during].mean()), 4),
        "p_now_abs_diff_0_10s_after": round(float(d[after].mean()), 4),
        "vad_ch1_during": round(float(vd[during, 0].mean()), 4),
        "vad_ch1_baseline_during": round(float(base_vad[during, 0].mean()), 4),
        "vad_ch2_during": round(float(vd[during, 1].mean()), 4),
        "vad_ch2_baseline_during": round(float(base_vad[during, 1].mean()), 4),
        "recovery_s": recovery(t, d, end_s),
        "any_nan": bool(np.isnan(pn).any()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", default="jp_kyoto")
    ap.add_argument("--model-type", default="normal-ver2")
    ap.add_argument("--frame-rate", type=float, default=12.5)
    a = ap.parse_args()
    r = DirectRunner(lang=a.lang, model_type=a.model_type, frame_rate=a.frame_rate)
    mix = load_wav("jpn_mix_16k.wav")[: 90 * SR]
    base = r.run(mix)
    bt, bp, bv = frame_times(base), arr(base, "p_now"), arr(base, "vad")
    s0, s1 = int(START_S * SR), int((START_S + DUR_S) * SR)
    rep = {
        "config": r.config,
        "material": "jpn_mix_16k.wav 先頭 90 秒（公式 sample）",
        "gap": {"start_s": START_S, "dur_s": DUR_S},
        "cases": {},
    }

    def case(name, x, end=START_S + DUR_S):
        r.reset()
        fs = r.run(x)
        rep["cases"][name] = evaluate(bt, bp, bv, frame_times(fs), arr(fs, "p_now"), arr(fs, "vad"), end)
        print(name, rep["cases"][name], flush=True)

    # 同じ長さのゼロ埋め（ネットワーク欠損の方式）
    x = mix.copy(); x[s0:s1, 0] = 0
    case("ch1_zero_fill_2s", x)
    x = mix.copy(); x[s0:s1, 1] = 0
    case("ch2_zero_fill_2s", x)
    x = mix.copy(); x[s0:s1, :] = 0
    case("both_zero_fill_2s", x)

    # 短い欠損の散発（20ms 単位）
    rng = np.random.default_rng(0)
    for rate in (0.01, 0.05):
        x = mix.copy()
        n = len(x) // CHUNK_20MS
        for ch in (0, 1):
            for i in np.where(rng.random(n) < rate)[0]:
                x[i * CHUNK_20MS : (i + 1) * CHUNK_20MS, ch] = 0
        r.reset()
        fs = r.run(x)
        d = np.abs(arr(fs, "p_now")[:, 0] - bp[:, 0])
        v = arr(fs, "vad")
        rep["cases"][f"random_20ms_zero_{int(rate*100)}pct_each_ch"] = {
            "p_now_abs_diff_mean": round(float(d.mean()), 4),
            "p_now_abs_diff_p95": round(float(np.percentile(d, 95)), 4),
            "vad_abs_diff_mean": round(float(np.abs(v - bv).mean()), 4),
        }
        print(rate, rep["cases"][f"random_20ms_zero_{int(rate*100)}pct_each_ch"], flush=True)

    # ch2 全区間ゼロ vs 微小ノイズ（AI が話していない system チャネルの表現）
    x = mix.copy(); x[:, 1] = 0
    r.reset()
    z = r.run(x)
    rep_zero = {
        "vad_ch2_mean": round(float(arr(z, "vad")[:, 1].mean()), 5),
        "p_now_ch2_mean": round(float(arr(z, "p_now")[:, 1].mean()), 4),
        "p_future_ch2_mean": round(float(arr(z, "p_future")[:, 1].mean()), 4),
    }
    out = {"exact_zero": rep_zero}
    for db in (-90, -70, -60):
        x = mix.copy()
        x[:, 1] = rng.normal(0, 10 ** (db / 20), len(x)).astype(np.float32)
        r.reset()
        y = r.run(x)
        out[f"white_noise_{db}dBFS"] = {
            "vad_ch2_mean": round(float(arr(y, "vad")[:, 1].mean()), 5),
            "p_now_ch2_mean": round(float(arr(y, "p_now")[:, 1].mean()), 4),
            "p_future_ch2_mean": round(float(arr(y, "p_future")[:, 1].mean()), 4),
            "p_now_abs_diff_vs_zero": round(float(np.abs(arr(y, "p_now")[:, 1] - arr(z, "p_now")[:, 1]).mean()), 4),
        }
    rep["silent_ch2_representation"] = out
    print(out, flush=True)

    # 両チャネルを同時に捨てる（過負荷の方式）: process を呼ばない。番号は飛ぶ。
    r.reset()
    res_t, res_p = [], []
    frame = r.samples_per_frame
    drop_end = s1
    for i in range(0, len(mix) - CHUNK_20MS + 1, CHUNK_20MS):
        if s0 <= i < drop_end:
            r.fed += CHUNK_20MS  # 音声番号は進むが process を呼ばない
            continue
        for f in r.feed(mix[i : i + CHUNK_20MS, 0], mix[i : i + CHUNK_20MS, 1]):
            res_t.append(f.end_sample / SR)
            res_p.append(f.p_now)
    res_t, res_p = np.asarray(res_t), np.asarray(res_p)
    # 基準との比較は同じ番号のものどうしで行う（フレーム位相がずれれば共通番号は減る）
    common, ib, ir = np.intersect1d(np.round(bt * SR).astype(int), np.round(res_t * SR).astype(int), return_indices=True)
    after = common / SR > START_S + DUR_S
    d = np.abs(bp[ib, 0] - res_p[ir, 0])
    rep["cases"]["both_dropped_2s_no_process"] = {
        "n_results_baseline": len(bt),
        "n_results_dropped": len(res_t),
        "common_frame_numbers_after_gap": int(after.sum()),
        "frame_phase_preserved": bool(after.sum() > 0),
        "p_now_abs_diff_0_10s_after": round(float(d[after & (common / SR <= START_S + DUR_S + 10)].mean()), 4)
        if after.any()
        else None,
        "recovery_s": recovery(common[after] / SR, d[after], START_S + DUR_S) if after.any() else None,
        "note": f"frame={frame} サンプル。process を呼ばない間、モデルの文脈は実時間より短くなる",
    }
    print(rep["cases"]["both_dropped_2s_no_process"], flush=True)

    # 片チャネルだけ捨てて詰める（避けるべき方式。チャネルずれの影響を見る）
    for shift_ms in (20, 100, 500):
        k = shift_ms * SR // 1000
        x = mix.copy()
        x[s0 : len(x) - k, 1] = x[s0 + k :, 1]  # ch2 だけ以後が前に詰まる
        x[len(x) - k :, 1] = 0
        r.reset()
        fs = r.run(x)
        t, p = frame_times(fs), arr(fs, "p_now")
        m = t > START_S + 1
        rep["cases"][f"ch2_only_dropped_{shift_ms}ms_misaligned"] = {
            "p_now_abs_diff_after": round(float(np.abs(p[m, 0] - bp[m, 0]).mean()), 4),
            "p_now_abs_diff_p95_after": round(float(np.percentile(np.abs(p[m, 0] - bp[m, 0]), 95)), 4),
        }
        print(shift_ms, rep["cases"][f"ch2_only_dropped_{shift_ms}ms_misaligned"], flush=True)

    print("saved", save_result("degradation.json", rep))


if __name__ == "__main__":
    main()
