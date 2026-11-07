#!/usr/bin/env python
"""AI チャネルがゼロ（AI は黙っている）とき、話者の「ターンの終わり」と「発話内のポーズ」で
p_now[1], p_future[1] がどう違うかを重みごとに見る。本番の待機中に近い入力の参考測定。

正解の代理: 元の 2ch 素材で、ポーズ中に相手が 0.5 秒以上話したら turn_end、相手が話さず本人が
再開したら internal_pause。**素材は公式 sample の 1 会話のみで、事象数も少ない。性能の評価ではない。**
"""
from __future__ import annotations

import json
import sys

import numpy as np

from probe_common import DirectRunner, SR, arr, frame_times, load_wav, save_result
from probe_direction import frame_activity

SAMPLE_AFTER_S = (0.2, 0.4, 0.8)
MIN_PAUSE_S = 0.3


def find_pauses(t, a, b):
    dt = float(np.median(np.diff(t)))
    ev = {"turn_end": [], "internal_pause": []}
    i, n = 1, len(t)
    while i < n:
        if a[i - 1] and not a[i]:
            j = i
            while j < n and not a[j]:
                j += 1
            dur = (j - i) * dt
            other = b[i:j].sum() * dt
            resumes = j < n
            if dur >= MIN_PAUSE_S:
                if other >= 0.5:
                    ev["turn_end"].append((i, j))
                elif other < 0.1 and resumes:
                    ev["internal_pause"].append((i, j))
            i = j
        else:
            i += 1
    return ev, dt


def auc(pos, neg):
    if not pos or not neg:
        return None
    pos, neg = np.asarray(pos)[:, None], np.asarray(neg)[None, :]
    return float(((pos > neg).mean() + 0.5 * (pos == neg).mean()))


def main():
    mix = load_wav("jpn_mix_16k.wav")
    out = []
    for cfg in (
        dict(lang="jp_kyoto", mc=True),
        dict(lang="jp_kyoto", mc=False),
        dict(lang="jp", mc=True),
        dict(lang="jp", mc=False),
    ):
        r = DirectRunner(model_type="normal-ver2", frame_rate=12.5, torch_threads=4, **cfg)
        pooled = {f"{k}_{h}": {"turn_end": [], "internal_pause": []} for k in ("p_now", "p_future") for h in SAMPLE_AFTER_S}
        counts = {}
        speaking_fp = []
        for u, v, label in ((0, 1, "inoue_on_ch1"), (1, 0, "sumida_on_ch1")):
            x = np.zeros_like(mix)
            x[:, 0] = mix[:, u]
            r.reset()
            fs = r.run(x)
            t, pn, pf = frame_times(fs), arr(fs, "p_now"), arr(fs, "p_future")
            act = frame_activity(mix, t)
            a, b = act[:, u], act[:, v]
            ev, dt = find_pauses(t, a, b)
            counts[label] = {k: len(vv) for k, vv in ev.items()}
            speaking_fp.append(float((pn[a, 1] > 0.5).mean()))
            for cls, items in ev.items():
                for i, j in items:
                    for h in SAMPLE_AFTER_S:
                        k = i + int(round(h / dt))
                        if k < j:
                            pooled[f"p_now_{h}"][cls].append(float(pn[k, 1]))
                            pooled[f"p_future_{h}"][cls].append(float(pf[k, 1]))
        summ = {"config": cfg, "variant": r.m.variant, "events": counts, "p_now_ch2_gt_0.5_while_user_active": [round(v, 4) for v in speaking_fp]}
        for key, d in pooled.items():
            te, ip = d["turn_end"], d["internal_pause"]
            summ[key] = {
                "n_turn_end": len(te),
                "n_internal": len(ip),
                "mean_turn_end": round(float(np.mean(te)), 3) if te else None,
                "mean_internal": round(float(np.mean(ip)), 3) if ip else None,
                "frac_gt_0.5_turn_end": round(float(np.mean(np.asarray(te) > 0.5)), 3) if te else None,
                "frac_gt_0.5_internal": round(float(np.mean(np.asarray(ip) > 0.5)), 3) if ip else None,
                "auc": round(auc(te, ip), 3) if te and ip else None,
            }
        out.append(summ)
        print(json.dumps(summ, ensure_ascii=False), flush=True)
        save_result("turn_end.json", out)
        del r


if __name__ == "__main__":
    main()
    sys.exit(0)
