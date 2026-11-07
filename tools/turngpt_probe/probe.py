#!/usr/bin/env python3
"""Score eval_ja.jsonl with TurnGPT-jp weights and report <ts> probabilities.

Own reimplementation of the inference in osaka-dialogue/TurnGPT-jp (commit 6f1a1ec,
src/turngpt_jp/predictor.py): softmax over the next-token logits at the end of the text,
read at the <ts> id. Loads local safetensors only; never unpickles and runs no remote code.

Acceptance criteria below were fixed before the first inference run.
"""
from __future__ import annotations

import argparse
import json
import resource
import statistics
import time
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, T5Tokenizer

HERE = Path(__file__).resolve().parent
CRITERIA = {
    "auc_question_vs_continues_min": 0.85,
    "fire_rate_question_min": 0.70,
    "fire_rate_continues_max": 0.30,
    "median_order": "continues < complete_with_continuation",
    "latency_p95_ms_max_4turn": 200,
}
PUNCT = {"question_end": "？"}
LATENCY_TEXTS = {
    "1turn": "明日の会議は何時からですか",
    "4turn": "<ts>".join(
        [
            "週末はどうでしたか",
            "京都へ行ってお寺をいくつか回ってきました",
            "いいですねどのお寺がいちばんよかったですか",
            "清水寺も良かったんですけど人が多くて静かな苔寺のほうが好きでした",
            "苔寺は予約が必要なんですよね前から行ってみたいと思っていて",
        ]
    ),
}


def auc(pos: list[float], neg: list[float]) -> float:
    pairs = [(p > n) + 0.5 * (p == n) for p in pos for n in neg]
    return sum(pairs) / len(pairs)


class Scorer:
    def __init__(self, model_dir: str, dtype: torch.dtype):
        self.tok = T5Tokenizer.from_pretrained(model_dir, use_fast=False, local_files_only=True)
        self.model, info = AutoModelForCausalLM.from_pretrained(
            model_dir,
            torch_dtype=dtype,
            use_safetensors=True,
            trust_remote_code=False,
            local_files_only=True,
            output_loading_info=True,
        )
        self.model.eval()
        self.load_info = {k: list(v) for k, v in info.items() if k in ("missing_keys", "unexpected_keys")}
        self.ts_id = self.tok.convert_tokens_to_ids("<ts>")

    def ids(self, text: str) -> list[int]:
        return self.tok.encode(text, add_special_tokens=False)

    @torch.inference_mode()
    def score(self, text: str) -> float:
        x = torch.tensor([self.ids(text)])
        logits = self.model(input_ids=x, attention_mask=torch.ones_like(x)).logits[0, -1]
        return torch.softmax(logits.float(), dim=-1)[self.ts_id].item()


def summarize(rows: list[dict], threshold: float, key: str) -> dict:
    by: dict[str, list[float]] = {}
    for r in rows:
        if r.get(key) is not None:
            by.setdefault(r["category"], []).append(r[key])
    out = {
        c: {
            "n": len(v),
            "median": round(statistics.median(v), 4),
            "min": round(min(v), 4),
            "max": round(max(v), 4),
            "fire_rate": round(sum(p > threshold for p in v) / len(v), 3),
        }
        for c, v in by.items()
    }
    if "question_end" in by and "continues" in by:
        out["auc_question_vs_continues"] = round(auc(by["question_end"], by["continues"]), 3)
    if "statement_end" in by and "continues" in by:
        out["auc_statement_vs_continues"] = round(auc(by["statement_end"], by["continues"]), 3)
    if "complete_with_continuation" in by and "continues" in by:
        out["auc_cwc_vs_continues"] = round(auc(by["complete_with_continuation"], by["continues"]), 3)
    if "question_end" in by and "complete_with_continuation" in by:
        out["auc_question_vs_cwc"] = round(auc(by["question_end"], by["complete_with_continuation"]), 3)
    return out


def latency(s: Scorer, reps: int) -> dict:
    out = {}
    for threads in (4, 8):
        torch.set_num_threads(threads)
        for name, text in LATENCY_TEXTS.items():
            s.score(text)
            ms = []
            for _ in range(reps):
                t = time.perf_counter()
                s.score(text)
                ms.append((time.perf_counter() - t) * 1000)
            ms.sort()
            out[f"threads{threads}_{name}"] = {
                "tokens": len(s.ids(text)),
                "p50_ms": round(ms[len(ms) // 2], 1),
                "p95_ms": round(ms[min(len(ms) - 1, int(len(ms) * 0.95))], 1),
            }
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--threshold", type=float, required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--eval", default=str(HERE / "eval_ja.jsonl"))
    ap.add_argument("--out", default=None)
    ap.add_argument("--dtype", choices=["float32", "bfloat16"], default="float32")
    ap.add_argument("--reps", type=int, default=20)
    args = ap.parse_args()

    t0 = time.time()
    s = Scorer(args.model_dir, getattr(torch, args.dtype))
    load_s = round(time.time() - t0, 1)
    assert s.ts_id == 44877 and s.ids("あ<ts>い").count(s.ts_id) == 1, "literal <ts> must map to its token"
    torch.set_num_threads(8)

    rows = [json.loads(l) for l in open(args.eval, encoding="utf-8")]
    for r in rows:
        r["p_plain"] = round(s.score(r["partial"]), 5)
        r["p_punct"] = round(s.score(r["partial"] + PUNCT.get(r["category"], "。")), 5)
        r["p_ctx"] = round(s.score("<ts>".join(r["history"] + [r["partial"]])), 5) if r["history"] else None

    traj = {}
    for text in ["昨日駅前の新しいカフェに行ったんだけどすごく混んでて入れませんでした", "明日の会議は何時からですか"]:
        pieces = s.tok.tokenize(text)
        traj[text] = [
            [s.tok.convert_tokens_to_string(pieces[: i + 1]), round(s.score(s.tok.convert_tokens_to_string(pieces[: i + 1])), 4)]
            for i in range(len(pieces))
        ]

    result = {
        "name": args.name,
        "model_dir": args.model_dir,
        "dtype": args.dtype,
        "threshold": args.threshold,
        "criteria": CRITERIA,
        "load_seconds": load_s,
        "load_info": s.load_info,
        "summary": {k: summarize(rows, args.threshold, k) for k in ("p_plain", "p_punct", "p_ctx")},
        "latency": latency(s, args.reps),
        "peak_rss_gb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024**2, 2),
        "trajectories": traj,
        "rows": rows,
    }
    out = args.out or str(HERE / f"results_{args.name}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: result[k] for k in ("name", "load_seconds", "load_info", "summary", "latency", "peak_rss_gb")}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
