#!/usr/bin/env python
"""p_now / p_future / vad の添字と話者の対応を、2ch 実音声の既知区間で実測する。

合成タイムライン（素材は公式 sample の各話者トラック。他方のチャネルはゼロ）:
  0-5 無音 / 5-25 ch1 のみ / 25-30 無音 / 30-50 ch2 のみ / 50-55 無音 /
  55-95 4 秒ごとに ch1, ch2 を交互 / 95-100 無音
話者の入れ替え（voice に依存していないことの確認）と、素材そのまま・左右反転の実行を行う。

使い方: python probe_direction.py [--lang jp_kyoto] [--model-type normal-ver2] [--frame-rate 12.5] [--no-mc]
"""
from __future__ import annotations

import argparse

import numpy as np

from probe_common import DirectRunner, SR, arr, frame_times, load_wav, rms_db, save_result

ACTIVE_DB = -50.0  # 素材は近接分離でノイズ床が約 -88 dB。-50 dB を「発話あり」の目安にする。
SEGMENTS = [
    ("silence_0", 0, 5),
    ("ch1_only", 5, 25),
    ("silence_1", 25, 30),
    ("ch2_only", 30, 50),
    ("silence_2", 50, 55),
    ("alternating", 55, 95),
    ("silence_3", 95, 100),
]


def densest_window(track: np.ndarray, dur_s: float) -> tuple[int, float]:
    """発話の割合が最大の窓の開始サンプルと割合を返す（連続した実音声のまま使う）。"""
    hop = int(0.05 * SR)
    active = (rms_db(track, hop) > ACTIVE_DB).astype(float)
    w = int(dur_s / 0.05)
    c = np.convolve(active, np.ones(w), "valid")
    i = int(np.argmax(c))
    return i * hop, float(c[i] / w)


def build_timeline(spk_a: np.ndarray, spk_b: np.ndarray) -> tuple[np.ndarray, dict]:
    """spk_a を ch1、spk_b を ch2 に置いた既知区間つきの 2ch を作る。"""
    n = 100 * SR
    x = np.zeros((n, 2), dtype=np.float32)
    sa, ra = densest_window(spk_a, 40.0)
    sb, rb = densest_window(spk_b, 40.0)
    a, b = spk_a[sa : sa + 40 * SR], spk_b[sb : sb + 40 * SR]
    x[5 * SR : 25 * SR, 0] = a[: 20 * SR]
    x[30 * SR : 50 * SR, 1] = b[: 20 * SR]
    for k in range(10):
        t0, t1 = (55 + 4 * k) * SR, (59 + 4 * k) * SR
        src = (20 + 2 * (k // 2) * 2) * SR  # 20 秒以降の未使用部分
        if k % 2 == 0:
            x[t0:t1, 0] = a[src : src + 4 * SR]
        else:
            x[t0:t1, 1] = b[src : src + 4 * SR]
    return x, {"start_s": [sa / SR, sb / SR], "active_ratio": [ra, rb]}


def series(frames) -> dict:
    return {
        "t": frame_times(frames),
        "p_now": arr(frames, "p_now"),
        "p_future": arr(frames, "p_future"),
        "vad": arr(frames, "vad"),
    }


def frame_activity(x: np.ndarray, t: np.ndarray, win_s=0.08) -> np.ndarray:
    """各結果の直前 win_s の RMS が閾値を超えるか。(frames, 2)"""
    w = int(win_s * SR)
    out = np.zeros((len(t), 2), dtype=bool)
    for i, tt in enumerate(t):
        e = int(round(tt * SR))
        seg = x[max(0, e - w) : e]
        out[i] = np.sqrt((seg**2).mean(0) + 1e-18) > 10 ** (ACTIVE_DB / 20)
    return out


def seg_stats(s: dict, t0: float, t1: float, mask=None) -> dict:
    m = (s["t"] > t0) & (s["t"] <= t1)
    if mask is not None:
        m &= mask
    out = {"n": int(m.sum())}
    if not m.any():
        return out
    for k in ("p_now", "p_future", "vad"):
        v = s[k][m]
        out[k] = {
            "mean": v.mean(0).round(4).tolist(),
            "frac_idx0_gt_idx1": round(float((v[:, 0] > v[:, 1]).mean()), 4),
        }
    return out


def alternation_lags(s: dict) -> dict:
    """交互区間の切替後、各量の優勢な添字が新しい話者に移るまでの時間。"""
    lags = {k: [] for k in ("p_now", "p_future", "vad")}
    for k in range(1, 10):
        sw = 55 + 4 * k
        new = k % 2  # 0: ch1, 1: ch2
        m = (s["t"] > sw) & (s["t"] <= sw + 4)
        for name in lags:
            v = s[name][m]
            ok = v[:, new] > v[:, 1 - new]
            # 区間末まで連続して優勢になる最初の時点
            idx = next((i for i in range(len(ok)) if ok[i:].mean() >= 0.8 and ok[i]), None)
            lags[name].append(None if idx is None else round(float(s["t"][m][idx] - sw), 3))
    return lags


def run_timeline(r: DirectRunner, x: np.ndarray) -> dict:
    r.reset()
    s = series(r.run(x))
    act = frame_activity(x, s["t"])
    stats = {}
    for name, t0, t1 in SEGMENTS:
        stats[name] = seg_stats(s, t0, t1)
    # 発話フレームに限定した値（素材のポーズの影響を除く）
    stats["ch1_only_active"] = seg_stats(s, 5, 25, act[:, 0])
    stats["ch2_only_active"] = seg_stats(s, 30, 50, act[:, 1])
    alt_ch1 = np.zeros_like(act[:, 0])
    alt_ch2 = np.zeros_like(act[:, 0])
    for k in range(10):
        m = (s["t"] > 55 + 4 * k) & (s["t"] <= 59 + 4 * k)
        (alt_ch1 if k % 2 == 0 else alt_ch2)[m] = True
    stats["alternating_ch1_turn"] = seg_stats(s, 55, 95, alt_ch1)
    stats["alternating_ch2_turn"] = seg_stats(s, 55, 95, alt_ch2)
    return {"series": s, "stats": stats, "lags_s": alternation_lags(s)}


def transitions(s: dict, act: np.ndarray) -> dict:
    """素材そのままの「話者交替」周辺の平均（ch1→ch2 と ch2→ch1）。"""
    dt = float(np.median(np.diff(s["t"])))
    # 短い途切れを埋めて発話区間にする
    fill = int(0.3 / dt)
    a = act.copy()
    for c in (0, 1):
        v = np.convolve(a[:, c].astype(float), np.ones(fill), "same") > 0
        a[:, c] = v
    out = {}
    for frm, to in ((0, 1), (1, 0)):
        ev = []
        for i in range(int(1.0 / dt), len(a) - int(2.0 / dt)):
            # to の開始。直前 1 秒は frm のみ話していた、開始後 0.5 秒は to が続く
            if a[i, to] and not a[i - 1, to]:
                prev = a[i - int(1.0 / dt) : i]
                nxt = a[i : i + int(0.5 / dt)]
                if prev[:, frm].mean() > 0.5 and not prev[:, to].any() and nxt[:, to].all():
                    ev.append(i)
        rel = np.arange(-int(1.2 / dt), int(1.2 / dt) + 1)
        rows = {"n_events": len(ev), "rel_t": (rel * dt).round(3).tolist()}
        ev = [i for i in ev if i + rel[0] >= 0 and i + rel[-1] < len(a)]
        for k in ("p_now", "p_future", "vad"):
            if ev:
                rows[f"{k}_to_speaker"] = (
                    np.mean([s[k][i + rel, to] for i in ev], 0).round(3).tolist()
                )
        out[f"ch{frm+1}_to_ch{to+1}"] = rows
    return out


def turn_end_tail(s: dict, end_t: float, horizon=4.0) -> dict:
    m = (s["t"] > end_t - 0.5) & (s["t"] <= end_t + horizon)
    return {
        "t_rel": (s["t"][m] - end_t).round(2).tolist(),
        "p_now": s["p_now"][m].round(3).tolist(),
        "p_future": s["p_future"][m].round(3).tolist(),
        "vad": s["vad"][m].round(3).tolist(),
    }


def next_speaker_scores(s: dict, act: np.ndarray) -> dict:
    """エネルギーから作った活動を正解の代理にした 2 話者の予測スコア（素材 1 本の参考値）。"""
    t, dt = s["t"], float(np.median(np.diff(s["t"])))
    res = {}
    for name, key, lo, hi in (("now_0_600", "p_now", 0.0, 0.6), ("future_600_2000", "p_future", 0.6, 2.0)):
        i0, i1 = int(lo / dt), int(hi / dt)
        labels, preds, persist, switch = [], [], [], []
        for i in range(len(t) - i1 - 1):
            win = act[i + 1 + i0 : i + 1 + i1].mean(0)
            if abs(win[0] - win[1]) < 0.2:
                continue
            lab = int(win[1] > win[0])
            labels.append(lab)
            preds.append(int(s[key][i, 1] > s[key][i, 0]))
            cur = act[i]
            pers = int(cur[1]) if cur[0] != cur[1] else -1
            persist.append(pers)
            switch.append(pers != -1 and pers != lab)
        labels, preds, persist, switch = map(np.array, (labels, preds, persist, switch))
        known = persist != -1
        res[name] = {
            "n": int(len(labels)),
            "accuracy": round(float((labels == preds).mean()), 4),
            "baseline_current_speaker_persists": round(float((persist[known] == labels[known]).mean()), 4),
            "switch_n": int(switch.sum()),
            "accuracy_on_switch": round(float((labels[switch] == preds[switch]).mean()), 4) if switch.any() else None,
        }
    res["vad_vs_energy"] = {}
    for c in (0, 1):
        v = s["vad"][:, c] > 0.5
        res["vad_vs_energy"][f"ch{c+1}"] = round(float((v == act[:, c]).mean()), 4)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", default="jp_kyoto")
    ap.add_argument("--model-type", default="normal-ver2")
    ap.add_argument("--frame-rate", type=float, default=12.5)
    ap.add_argument("--no-mc", action="store_true")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    r = DirectRunner(lang=a.lang, model_type=a.model_type, frame_rate=a.frame_rate, mc=not a.no_mc)
    print(r.config)
    inoue, sumida = load_wav("jpn_inoue_16k.wav"), load_wav("jpn_sumida_16k.wav")
    mix = load_wav("jpn_mix_16k.wav")
    assert np.array_equal(mix[:, 0], inoue) and np.array_equal(mix[:, 1], sumida)

    out = {"config": r.config, "material": "MaAI example/wav_sample jpn_* (commit 113efb7)", "active_db": ACTIVE_DB}
    x, meta = build_timeline(inoue, sumida)
    out["timeline_inoue_on_ch1"] = run_timeline(r, x) | {"meta": meta}
    x2, meta2 = build_timeline(sumida, inoue)
    out["timeline_sumida_on_ch1"] = run_timeline(r, x2) | {"meta": meta2}
    tail = out["timeline_inoue_on_ch1"]["series"]
    out["after_ch1_turn_end"] = turn_end_tail(tail, 25.0)
    out["after_ch2_turn_end"] = turn_end_tail(tail, 50.0)

    r.reset()
    s = series(r.run(mix))
    act = frame_activity(mix, s["t"])
    tot = {}
    for c in (0, 1):
        for k in ("p_now", "p_future", "vad"):
            tot[f"corr_{k}[{c}]_vs_ch{c+1}_active"] = round(float(np.corrcoef(s[k][:, c], act[:, c])[0, 1]), 4)
            tot[f"corr_{k}[{c}]_vs_ch{2-c}_active"] = round(float(np.corrcoef(s[k][:, c], act[:, 1 - c])[0, 1]), 4)
    only1, only2 = act[:, 0] & ~act[:, 1], act[:, 1] & ~act[:, 0]
    both, neither = act[:, 0] & act[:, 1], ~act[:, 0] & ~act[:, 1]
    out["real_mix"] = {
        "dur_s": len(mix) / SR,
        "correlation": tot,
        "only_ch1": seg_stats(s, 0, 1e9, only1),
        "only_ch2": seg_stats(s, 0, 1e9, only2),
        "both": seg_stats(s, 0, 1e9, both),
        "neither": seg_stats(s, 0, 1e9, neither),
        "transitions": transitions(s, act),
        "scores": next_speaker_scores(s, act),
    }
    r.reset()
    sw = series(r.run(mix[:, ::-1].copy()))
    out["real_mix_swapped"] = {
        "only_ch1_original": seg_stats(sw, 0, 1e9, only1),
        "only_ch2_original": seg_stats(sw, 0, 1e9, only2),
        "mirror_abs_diff_p_now": round(float(np.abs(s["p_now"][:, 0] - sw["p_now"][:, 1]).mean()), 4),
        "mirror_abs_diff_vad": round(float(np.abs(s["vad"][:, 0] - sw["vad"][:, 1]).mean()), 4),
    }
    out["timeline_inoue_on_ch1"]["series"] = {k: np.round(v, 4) for k, v in out["timeline_inoue_on_ch1"]["series"].items()}
    out["timeline_sumida_on_ch1"]["series"] = {k: np.round(v, 4) for k, v in out["timeline_sumida_on_ch1"]["series"].items()}
    name = a.out or f"direction_{a.lang}_{a.model_type}_{a.frame_rate:g}hz_{'nomc' if a.no_mc else 'mc'}.json"
    path = save_result(name, out)
    print("saved", path)
    for seg in ("ch1_only_active", "ch2_only_active", "alternating_ch1_turn", "alternating_ch2_turn", "silence_3"):
        print(seg, out["timeline_inoue_on_ch1"]["stats"][seg])
    print(out["real_mix"]["correlation"])


if __name__ == "__main__":
    main()
