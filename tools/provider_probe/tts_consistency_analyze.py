"""tts_consistency.mjs の WAV から声のばらつきを測る（docs/tts_consistency.md）。

指標（1 発話ごと）:
  f0_med_st   基本周波数の中央値（100Hz を基準にした半音）。Praat の自己相関、10ms 刻み。
              1 回目 75〜500Hz の四分位から範囲を決めて 2 回目（floor=Q1×0.75、ceiling=Q3×1.5。オクターブ誤りを減らす常套の手順）
  f0_range_st 同じく 95 パーセンタイル − 5 パーセンタイル（半音）
  rms_db      有音フレームの RMS（dBFS）
  rate_mps    モーラ／秒（手で数えたモーラ数 ÷ 有音の始まりから終わりまで）
  centroid_hz 有音フレームのスペクトル重心
  dur_ms      有音の始まりから終わりまで

要約: 同じ文の繰り返しのばらつき（文ごとの分散をプールした SD）と、文の間のばらつき（文ごとの平均の SD）を分ける。
repeat の 95% 区間は、文の中で繰り返しを復元抽出した bootstrap。人の聞こえ方は測っていない。

実行には praat-parselmouth が必要（pip install --target <scratch> praat-parselmouth し、PYTHONPATH に足す）。
  PYTHONPATH=<scratch>/pydeps ../../.venv/bin/python tts_consistency_analyze.py --raw <DIR> --out <JSON>
"""
import argparse
import hashlib
import json
import math
import wave
from pathlib import Path

import numpy as np
import parselmouth

METRICS = ["f0_med_st", "f0_range_st", "rms_db", "rate_mps", "centroid_hz", "dur_ms"]
FLOOR, CEIL = 75.0, 500.0


def read_wav(path):
    with wave.open(str(path), "rb") as w:
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768.0
    return pcm, rate


def analyze(path, mora):
    samples, rate = read_wav(path)
    snd = parselmouth.Sound(samples, sampling_frequency=rate)
    first = snd.to_pitch(time_step=0.01, pitch_floor=FLOOR, pitch_ceiling=CEIL).selected_array["frequency"]
    first = first[first > 0]
    if len(first) < 5:
        return None
    floor = max(FLOOR, float(np.percentile(first, 25)) * 0.75)
    ceil = min(CEIL, float(np.percentile(first, 75)) * 1.5)
    f0 = snd.to_pitch(time_step=0.01, pitch_floor=floor, pitch_ceiling=ceil).selected_array["frequency"]
    voiced = f0[f0 > 0]
    hop = int(0.010 * rate)
    win = int(0.025 * rate)
    frames = max(0, (len(samples) - win) // hop + 1)
    rms = np.array([np.sqrt(np.mean(samples[i * hop : i * hop + win] ** 2)) for i in range(frames)])
    peak = rms.max() if len(rms) else 0.0
    active = rms > peak * (10 ** (-35 / 20)) if peak > 0 else np.zeros_like(rms, dtype=bool)
    idx = np.flatnonzero(active)
    if len(idx) == 0 or len(voiced) < 5:
        return None
    start, end = idx[0], idx[-1] + 1
    dur_ms = (end - start) * 10.0
    active_rms = rms[active]
    hann = np.hanning(win)
    freqs = np.fft.rfftfreq(win, 1 / rate)
    centroids = []
    for i in idx:
        frame = samples[i * hop : i * hop + win]
        mag = np.abs(np.fft.rfft(frame * hann))
        total = mag.sum()
        if total > 0:
            centroids.append((freqs * mag).sum() / total)
    st = 12 * np.log2(voiced / 100.0)
    return {
        "f0_med_st": float(np.median(st)),
        "f0_range_st": float(np.percentile(st, 95) - np.percentile(st, 5)),
        "rms_db": float(20 * np.log10(np.sqrt(np.mean(active_rms**2)))),
        "rate_mps": float(mora / (dur_ms / 1000.0)),
        "centroid_hz": float(np.mean(centroids)),
        "dur_ms": float(dur_ms),
        "f0_med_hz": float(np.median(voiced)),
        "voiced_frames": int(len(voiced)),
        "sha": hashlib.sha256(samples.tobytes()).hexdigest()[:16],
    }


def pooled_sd(groups):
    """groups: 文ごとの値の配列。各文の分散を自由度でプールした SD。"""
    dfs = [len(g) - 1 for g in groups if len(g) > 1]
    if not dfs:
        return float("nan")
    ss = sum(((g - g.mean()) ** 2).sum() for g in groups if len(g) > 1)
    return math.sqrt(ss / sum(dfs))


def bootstrap_within_ci(groups, rng, n=2000):
    out = []
    for _ in range(n):
        resampled = [g[rng.integers(0, len(g), len(g))] for g in groups if len(g) > 1]
        out.append(pooled_sd(resampled))
    return float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))


def between_sd(groups):
    means = np.array([g.mean() for g in groups])
    return float(means.std(ddof=1)) if len(means) > 1 else float("nan")


def ratio_ci(a, b, rng, n=2000):
    """pooled SD の比 a/b の 95% 区間（各群を独立に bootstrap）。"""
    vals = []
    for _ in range(n):
        ra = pooled_sd([g[rng.integers(0, len(g), len(g))] for g in a if len(g) > 1])
        rb = pooled_sd([g[rng.integers(0, len(g), len(g))] for g in b if len(g) > 1])
        if rb > 0:
            vals.append(ra / rb)
    if not vals:
        return (float("nan"), float("nan"))
    return float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))


def between_ci(groups, rng, n=2000):
    """文を復元抽出した、文の間の SD の 95% 区間。"""
    if len(groups) < 3:
        return (float("nan"), float("nan"))
    means = np.array([g.mean() for g in groups])
    vals = [np.std(means[rng.integers(0, len(means), len(means))], ddof=1) for _ in range(n)]
    return float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))


def between_ratio_ci(a, b, rng, n=2000):
    """同じ文の組で文を復元抽出した SD の比の 95% 区間（対応あり）。文の順序は sentences の並びで揃っている前提。"""
    ma, mb = np.array([g.mean() for g in a]), np.array([g.mean() for g in b])
    if len(ma) != len(mb) or len(ma) < 3:
        return (float("nan"), float("nan"))
    vals = []
    for _ in range(n):
        idx = rng.integers(0, len(ma), len(ma))
        sb = np.std(mb[idx], ddof=1)
        if sb > 0:
            vals.append(np.std(ma[idx], ddof=1) / sb)
    return float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))


def waveform_corr(a, b):
    n = min(len(a), len(b))
    if n == 0:
        return float("nan")
    x, y = a[:n], b[:n]
    return float(np.corrcoef(x, y)[0, 1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tag", action="append", help="runs_<tag>.jsonl（複数可）。省略時はすべて")
    ap.add_argument("--baseline", default="base")
    args = ap.parse_args()
    raw = Path(args.raw)
    files = [raw / f"runs_{t}.jsonl" for t in args.tag] if args.tag else sorted(raw.glob("runs_*.jsonl"))
    runs = []
    for f in files:
        for line in f.read_text().splitlines():
            if line.strip():
                runs.append(json.loads(line))
    takes = []
    errors = 0
    for run in runs:
        if run.get("error"):
            errors += 1
            continue
        res = analyze(raw / "wav" / f"{run['context_id']}.wav", run["mora"])
        if res is None:
            errors += 1
            continue
        takes.append({**run, **res})
    rng = np.random.default_rng(1)
    report = {"errors": errors, "conditions": {}}
    by_cond = {}
    for t in takes:
        by_cond.setdefault(t["condition"], []).append(t)
    groups_of = {}
    for cond, list_ in by_cond.items():
        sentences = sorted({t["sentence"] for t in list_})
        per_sentence = {}
        groups_of[cond] = {}
        for m in METRICS:
            groups = [np.array([t[m] for t in list_ if t["sentence"] == s]) for s in sentences]
            groups_of[cond][m] = groups
        for s in sentences:
            subset = [t for t in list_ if t["sentence"] == s]
            per_sentence[s] = {"n": len(subset), **{m: float(np.mean([t[m] for t in subset])) for m in METRICS}}
        entry = {"n": len(list_), "reps_per_sentence": sorted({v["n"] for v in per_sentence.values()}), "per_sentence": per_sentence, "within_sd": {}, "between_sd": {}}
        for m in METRICS:
            groups = groups_of[cond][m]
            entry["within_sd"][m] = pooled_sd(groups)
            entry["within_sd_ci95"] = entry.get("within_sd_ci95", {})
            entry["within_sd_ci95"][m] = bootstrap_within_ci(groups, rng)
            entry["between_sd"][m] = between_sd(groups)
            entry["between_sd_ci95"] = entry.get("between_sd_ci95", {})
            entry["between_sd_ci95"][m] = between_ci(groups, rng)
        kinds = {}
        for k in ("short", "medium", "long"):
            subset = [t for t in list_ if t["kind"] == k]
            if subset:
                kinds[k] = {m: float(np.mean([t[m] for t in subset])) for m in METRICS}
        if "short" in kinds and "long" in kinds:
            entry["short_minus_long"] = {m: kinds["short"][m] - kinds["long"][m] for m in METRICS}
        warm = [t["first_audio_ms"] for t in list_ if t.get("first_audio_ms") is not None and not t.get("cold")]
        cold = [t["first_audio_ms"] for t in list_ if t.get("first_audio_ms") is not None and t.get("cold")]
        entry["ttfb_ms_warm"] = {
            "n": len(warm),
            "median": float(np.median(warm)) if warm else None,
            "p90": float(np.percentile(warm, 90)) if warm else None,
            "min": float(np.min(warm)) if warm else None,
            "max": float(np.max(warm)) if warm else None,
        }
        entry["ttfb_ms_cold"] = cold
        # 同じ文の 2 テイクの波形が同一か（seed の決定性）。
        same, corrs = 0, []
        pairs = 0
        for s in sentences:
            subset = [t for t in list_ if t["sentence"] == s]
            for i in range(len(subset)):
                for j in range(i + 1, len(subset)):
                    pairs += 1
                    if subset[i]["sha"] == subset[j]["sha"]:
                        same += 1
                    a, _ = read_wav(raw / "wav" / f"{subset[i]['context_id']}.wav")
                    b, _ = read_wav(raw / "wav" / f"{subset[j]['context_id']}.wav")
                    corrs.append(waveform_corr(a, b))
        entry["identical_pairs"] = {"same": same, "pairs": pairs, "waveform_corr_median": float(np.median(corrs)) if corrs else None}
        report["conditions"][cond] = entry
    base = groups_of.get(args.baseline)
    if base:
        for cond, g in groups_of.items():
            if cond == args.baseline:
                continue
            report["conditions"][cond]["within_sd_ratio_vs_baseline"] = {
                m: {
                    "ratio": pooled_sd(g[m]) / pooled_sd(base[m]) if pooled_sd(base[m]) > 0 else None,
                    "ci95": ratio_ci(g[m], base[m], rng),
                }
                for m in METRICS
            }
            report["conditions"][cond]["between_sd_ratio_vs_baseline"] = {
                m: {
                    "ratio": between_sd(g[m]) / between_sd(base[m]) if between_sd(base[m]) > 0 else None,
                    "ci95": between_ratio_ci(g[m], base[m], rng),
                }
                for m in METRICS
            }
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    # 読みやすい表。
    print("condition n | within SD: f0_med st | f0_rng st | rms dB | mora/s | centroid Hz | dur ms | ttfb med/p90 (warm n)")
    for cond, e in report["conditions"].items():
        w = e["within_sd"]
        t = e["ttfb_ms_warm"]
        print(f"{cond:12s} {e['n']:3d} | {w['f0_med_st']:.3f} | {w['f0_range_st']:.3f} | {w['rms_db']:.2f} | {w['rate_mps']:.3f} | {w['centroid_hz']:.0f} | {w['dur_ms']:.0f} | {t['median']:.0f}/{t['p90']:.0f} ({t['n']})")
    print("\nbetween SD: f0_med | f0_rng | rms | mora/s | centroid | short-long f0_med, rate")
    for cond, e in report["conditions"].items():
        b = e["between_sd"]
        sl = e.get("short_minus_long", {})
        print(f"{cond:12s} | {b['f0_med_st']:.3f} | {b['f0_range_st']:.3f} | {b['rms_db']:.2f} | {b['rate_mps']:.3f} | {b['centroid_hz']:.0f} | {sl.get('f0_med_st', float('nan')):.2f} st, {sl.get('rate_mps', float('nan')):.2f}")
    print("\nratio within SD vs baseline (95% CI): f0_med | rate | centroid")
    for cond, e in report["conditions"].items():
        r = e.get("within_sd_ratio_vs_baseline")
        if r:
            fm = lambda k: "n/a" if r[k]["ratio"] is None else f"{r[k]['ratio']:.2f} [{r[k]['ci95'][0]:.2f},{r[k]['ci95'][1]:.2f}]"
            print(f"{cond:12s} | {fm('f0_med_st')} | {fm('rate_mps')} | {fm('centroid_hz')}")
    print("\nratio between SD vs baseline (95% CI, paired by sentence): f0_med | rms | rate | centroid")
    for cond, e in report["conditions"].items():
        r = e.get("between_sd_ratio_vs_baseline")
        if r:
            fm = lambda k: "n/a" if r[k]["ratio"] is None else f"{r[k]['ratio']:.2f} [{r[k]['ci95'][0]:.2f},{r[k]['ci95'][1]:.2f}]"
            print(f"{cond:12s} | {fm('f0_med_st')} | {fm('rms_db')} | {fm('rate_mps')} | {fm('centroid_hz')}")
    print("\nidentical pairs / waveform corr (median):")
    for cond, e in report["conditions"].items():
        p = e["identical_pairs"]
        print(f"{cond:12s} same={p['same']}/{p['pairs']} corr_med={p['waveform_corr_median']}")
    print(f"\nerrors: {errors}")


if __name__ == "__main__":
    main()
