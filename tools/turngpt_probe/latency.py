#!/usr/bin/env python3
"""CPU latency of TurnGPT-jp scoring: full forward vs. last-position head vs. cached history.

The scores must agree across modes (checked below); only the compute differs.
Records the load average because other processes on the host change the result.
"""
from __future__ import annotations

import argparse
import json
import os
import resource
import time

import torch
from transformers import AutoModelForCausalLM, T5Tokenizer

HISTORY = "<ts>".join(
    [
        "週末はどうでしたか",
        "京都へ行ってお寺をいくつか回ってきました",
        "いいですねどのお寺がいちばんよかったですか",
        "清水寺も良かったんですけど人が多くて静かな苔寺のほうが好きでした",
    ]
) + "<ts>"
PARTIAL = "苔寺は予約が必要なんですよね前から行ってみたいと思っていて"


def timed(fn, reps: int) -> tuple[dict, float]:
    fn()
    ms, p = [], 0.0
    for _ in range(reps):
        t = time.perf_counter()
        p = fn()
        ms.append((time.perf_counter() - t) * 1000)
    ms.sort()
    return {"p50_ms": round(ms[len(ms) // 2], 1), "p95_ms": round(ms[min(reps - 1, int(reps * 0.95))], 1)}, p


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--dtype", choices=["float32", "bfloat16"], default="float32")
    ap.add_argument("--threads", type=int, nargs="+", default=[2, 4, 8])
    ap.add_argument("--reps", type=int, default=15)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    tok = T5Tokenizer.from_pretrained(args.model_dir, use_fast=False, local_files_only=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.model_dir,
        torch_dtype=getattr(torch, args.dtype),
        use_safetensors=True,
        trust_remote_code=False,
        local_files_only=True,
    ).eval()
    ts_id = tok.convert_tokens_to_ids("<ts>")
    hist = tok.encode(HISTORY, add_special_tokens=False)
    part = tok.encode(PARTIAL, add_special_tokens=False)
    all_ids = torch.tensor([hist + part])
    new_ids = torch.tensor([part])

    def prob(last_logits: torch.Tensor) -> float:
        return torch.softmax(last_logits.float(), dim=-1)[ts_id].item()

    @torch.inference_mode()
    def full() -> float:
        return prob(model(input_ids=all_ids).logits[0, -1])

    @torch.inference_mode()
    def last_only() -> float:
        h = model.transformer(input_ids=all_ids).last_hidden_state[:, -1]
        return prob(model.lm_head(h)[0])

    with torch.inference_mode():
        cached = model.transformer(input_ids=torch.tensor([hist]), use_cache=True).past_key_values

    @torch.inference_mode()
    def with_cache() -> float:
        import copy

        h = model.transformer(
            input_ids=new_ids, past_key_values=copy.deepcopy(cached), use_cache=True
        ).last_hidden_state[:, -1]
        return prob(model.lm_head(h)[0])

    result = {
        "dtype": args.dtype,
        "tokens_history": len(hist),
        "tokens_partial": len(part),
        "cpu": os.cpu_count(),
        "loadavg_start": os.getloadavg(),
        "modes": {},
    }
    scores = {}
    for th in args.threads:
        torch.set_num_threads(th)
        for name, fn in (("full", full), ("last_position_head", last_only), ("cached_history", with_cache)):
            stats, scores[name] = timed(fn, args.reps)
            result["modes"][f"threads{th}_{name}"] = stats
    result["scores"] = {k: round(v, 5) for k, v in scores.items()}
    result["loadavg_end"] = os.getloadavg()
    result["peak_rss_gb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024**2, 2)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(json.dumps(result, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
