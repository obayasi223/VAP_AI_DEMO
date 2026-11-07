#!/usr/bin/env python
"""direction_*.json の既知区間タイムラインの時系列を PNG にする。"""
import json
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from matplotlib import font_manager
from pathlib import Path

_jp = Path.home() / ".fonts/NotoSansCJKjp-Regular.otf"
if _jp.exists():
    font_manager.fontManager.addfont(str(_jp))
    plt.rcParams["font.family"] = "Noto Sans CJK JP"

src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))["timeline_inoue_on_ch1"]["series"]
t = np.asarray(d["t"])
SURFACE, INK, MUTED, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
C0, C1 = "#2a78d6", "#eb6834"  # dataviz 既定の slot 1, 2（validate_palette.js で確認）
fig, axes = plt.subplots(3, 1, figsize=(11, 6.4), sharex=True, facecolor=SURFACE)
for ax, key, title in zip(
    axes,
    ("p_now", "p_future", "vad"),
    ("p_now（0-600 ms 先）", "p_future（600-2000 ms 先）", "vad（現在フレーム）"),
):
    v = np.asarray(d[key])
    ax.set_facecolor(SURFACE)
    for a, b in ((5, 25),):
        ax.axvspan(a, b, color=C0, alpha=0.07, lw=0)
    ax.axvspan(30, 50, color=C1, alpha=0.07, lw=0)
    for k in range(10):
        ax.axvspan(55 + 4 * k, 59 + 4 * k, color=C0 if k % 2 == 0 else C1, alpha=0.07, lw=0)
    ax.plot(t, v[:, 0], color=C0, lw=1.4, label="添字 0")
    ax.plot(t, v[:, 1], color=C1, lw=1.4, label="添字 1")
    ax.set_ylim(-0.03, 1.03)
    ax.set_yticks([0, 0.5, 1])
    ax.set_title(title, loc="left", fontsize=10, color=INK)
    ax.grid(axis="y", color=GRID, lw=0.7)
    ax.tick_params(colors=MUTED, length=0, labelsize=9)
    for s in ax.spines.values():
        s.set_visible(False)
axes[0].legend(loc="lower right", bbox_to_anchor=(1, 1.0), frameon=False, ncols=2, fontsize=9, labelcolor=INK)
for x, s, c in ((15, "ch1 のみ", C0), (40, "ch2 のみ", C1), (75, "交互（4 秒ごと）", MUTED)):
    axes[2].text(x, -0.28, s, ha="center", color=MUTED, fontsize=9)
axes[2].set_xlabel("音声時刻 [s]（素材: 公式 sample の話者トラックから構成。実会話の性能ではない）", color=MUTED, fontsize=9, labelpad=18)
fig.tight_layout()
fig.savefig(dst, dpi=110, facecolor=SURFACE)
