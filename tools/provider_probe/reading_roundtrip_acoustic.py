"""Compares word spans of the ElevenLabs clips without any STT or network call.

A word synthesised from kanji is compared with the same word synthesised from hiragana (MFCC + DTW), with the spans
taken from the alignment times. el_ja vs el_nolang is the yardstick for how far two takes of one text differ anyway.
A large distance means the two takes sound different there. It does not say which language the sound belongs to.
  ../../.venv/bin/python reading_roundtrip_acoustic.py
"""
import json
import statistics
import sys
import wave
from pathlib import Path

import numpy as np
from scipy.fft import dct

OUT = Path(__file__).parent / "out" / "reading_roundtrip"
# (sentence, kanji form, kana form, role). suspect: STT broke here only with kanji input. control: STT was right in all.
WORDS = [
    ("s01", "東京駅", "とうきょうえき", "suspect"),
    ("s02", "大阪", "おおさか", "suspect"),
    ("s03", "金閣寺", "きんかくじ", "suspect"),
    ("s07", "生ビール", "なまびーる", "suspect"),
    ("s10", "手紙", "てがみ", "suspect"),
    ("s10", "切手", "きって", "suspect"),
    ("s13", "三百円", "さんびゃくえん", "suspect"),
    ("s04", "田中", "たなか", "control"),
    ("s04", "山田先生", "やまだせんせい", "control"),
    ("s04", "生徒", "せいと", "control"),
    ("s05", "鈴木", "すずき", "control"),
    ("s05", "散歩", "さんぽ", "control"),
    ("s06", "明日", "あした", "control"),
    ("s06", "予定", "よてい", "control"),
    ("s06", "確認", "かくにん", "control"),
    ("s08", "上手", "じょうず", "control"),
    ("s09", "大人", "おとな", "control"),
    ("s09", "子供", "こども", "control"),
    ("s11", "大丈夫", "だいじょうぶ", "control"),
    ("s11", "勉強", "べんきょう", "control"),
    ("s12", "新聞", "しんぶん", "control"),
    ("s12", "料理", "りょうり", "control"),
]


def mfcc(pcm, rate, n=13):
    win, hop = int(0.025 * rate), int(0.01 * rate)
    frames = np.lib.stride_tricks.sliding_window_view(pcm, win)[::hop] * np.hamming(win)
    power = np.abs(np.fft.rfft(frames, 512)) ** 2
    mel = lambda f: 2595 * np.log10(1 + f / 700)
    points = 700 * (10 ** (np.linspace(0, mel(rate / 2), 28) / 2595) - 1)
    bins = np.floor(256 * points / (rate / 2)).astype(int).clip(0, 256)
    bank = np.zeros((26, 257))
    for i in range(26):
        a, b, c = bins[i], bins[i + 1], bins[i + 2]
        bank[i, a:b] = (np.arange(a, b) - a) / max(1, b - a)
        bank[i, b:c] = (c - np.arange(b, c)) / max(1, c - b)
    return dct(np.log(power @ bank.T + 1e-6), type=2, norm="ortho")[:, 1:n]


def load(cond, sid):
    # el_ja s01 came from the pilot, before times were kept. Its late_close take is the same text and settings.
    meta = json.loads((OUT / f"{cond}__{sid}.tts.json").read_text())
    if "timing" not in meta:
        cond = f"{cond}_late_close"
        meta = json.loads((OUT / f"{cond}__{sid}.tts.json").read_text())
    with wave.open(str(OUT / f"{cond}__{sid}.wav")) as w:
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(float)
    feats = mfcc(pcm, rate)
    feats = (feats - feats.mean(0)) / (feats.std(0) + 1e-6)
    return meta["timing"], feats


def span(timing, word, feats):
    # The alignment sometimes holds a space inside a word (子 供). Spans are looked up with spaces removed.
    timing = [t for t in timing if t[0].strip()]
    chars = "".join(t[0] for t in timing)
    at = chars.find(word)
    if at < 0:
        raise KeyError(f"{word} not in {chars}")
    start, end = timing[at][1], timing[at + len(word) - 1][1] + timing[at + len(word) - 1][2]
    return feats[int(start / 10) : max(int(start / 10) + 3, int(end / 10))], end - start


def dtw(a, b):
    cost = np.linalg.norm(a[:, None] - b[None, :], axis=2)
    d = np.full((len(a) + 1, len(b) + 1), np.inf)
    d[0, 0] = 0
    for i in range(len(a)):
        for j in range(len(b)):
            d[i + 1, j + 1] = cost[i, j] + min(d[i, j], d[i, j + 1], d[i + 1, j])
    return d[-1, -1] / (len(a) + len(b))


rows = []
for sid, kanji, kana, role in WORDS:
    t_a, f_a = load("el_ja", sid)
    t_b, f_b = load("el_nolang", sid) if (OUT / f"el_nolang__{sid}.tts.json").exists() and "timing" in json.loads((OUT / f"el_nolang__{sid}.tts.json").read_text()) else (None, None)
    t_c, f_c = load("el_hira_ja", sid)
    a, ms_a = span(t_a, kanji, f_a)
    c, ms_c = span(t_c, kana, f_c)
    row = {"id": sid, "word": kanji, "role": role, "ja_vs_hira": dtw(a, c), "ms_kanji": ms_a, "ms_kana": ms_c}
    if t_b:
        b, _ = span(t_b, kanji, f_b)
        row["ja_vs_nolang"] = dtw(a, b)
    rows.append(row)

print("| 文 | 語 | 種類 | 漢字ja↔ひらがな | 漢字ja↔言語なし | 長さms 漢字/かな |\n|---|---|---|---|---|---|")
for r in sorted(rows, key=lambda r: -r["ja_vs_hira"]):
    nolang = f"{r['ja_vs_nolang']:.1f}" if "ja_vs_nolang" in r else "-"
    print(f"| {r['id']} | {r['word']} | {r['role']} | {r['ja_vs_hira']:.1f} | {nolang} | {r['ms_kanji']:.0f}/{r['ms_kana']:.0f} |")
for role in ("suspect", "control"):
    v = [r["ja_vs_hira"] for r in rows if r["role"] == role]
    w = [r["ja_vs_nolang"] for r in rows if r["role"] == role and "ja_vs_nolang" in r]
    print(f"{role}: 漢字↔ひらがな 中央値 {statistics.median(v):.2f}, 漢字↔言語なし 中央値 {statistics.median(w):.2f}, n={len(v)}", file=sys.stdout)
(OUT / "report_acoustic.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2, default=float))
