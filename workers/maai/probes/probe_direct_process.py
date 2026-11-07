#!/usr/bin/env python
"""start() を使わず process(x1, x2) を 1 スレッドで呼ぶ方式の検証。

確かめること:
- 結果が出るサンプル番号（Mimi の最初の出力の破棄を含む）
- result["x1"] / ["x2"] と入力の対応（内容の一致で確認）
- 20ms（320 サンプル）送信と frame 周期の関係、約数でない送信単位の挙動
- start() + Chunk 経由と値が一致するか、決定性、reset の効果
- 因果性: k サンプル目以降を変えたとき、最初に値が変わる結果はどれか
- 誤用（チャネル長の不一致、int16 のまま）の挙動
"""
from __future__ import annotations

import threading
import time

import numpy as np

from probe_common import CHUNK_20MS, DirectRunner, SR, arr, load_wav, save_result

CFGS = [
    dict(lang="jp_kyoto", model_type="normal-ver2", frame_rate=12.5),
    dict(lang="jp_kyoto", model_type="normal", frame_rate=10),
]


def run_chunks(r: DirectRunner, a: np.ndarray, chunk: int):
    r.reset()
    try:
        return r.run(a, chunk=chunk), None
    except Exception as e:  # noqa: BLE001 - 挙動の記録が目的
        return None, f"{type(e).__name__}: {str(e)[:200]}"


def via_start(cfg: dict, a: np.ndarray) -> np.ndarray:
    """公式の start() + Chunk 経路。同じ音声で p_now を返す。"""
    from probe_common import import_maai

    maai = import_maai()
    c1, c2 = maai.MaaiInput.Chunk(), maai.MaaiInput.Chunk()
    m = maai.Maai(mode="vap", audio_ch1=c1, audio_ch2=c2, device="cpu", mc=True, **cfg)
    m.start()
    n = (len(a) // CHUNK_20MS) * CHUNK_20MS
    expected = None
    # worker は qsize>100 でチャネルごとにキューを消すので、背圧をかけて消されないようにする。
    # （背圧なしで一気に入れると実際に消える。1 回目の実行で結果 0〜1 件になった。）
    for i in range(0, n, CHUNK_20MS):
        while m._mic1_queue.qsize() > 50:
            time.sleep(0.005)
        c1.put_chunk(a[i : i + CHUNK_20MS, 0])
        c2.put_chunk(a[i : i + CHUNK_20MS, 1])
    spf = m.audio_samples_per_frame
    skip = 1 if m.encoder_type == "mimi" else 0
    expected = n // spf - skip
    out = []
    t0 = time.time()
    while len(out) < expected and time.time() - t0 < 120:
        try:
            out.append(m.result_dict_queue.get(timeout=5)["p_now"])
        except Exception:  # noqa: BLE001
            break
    m.stop(wait=True)
    return np.asarray(out, dtype=float)


def main():
    full = load_wav("jpn_mix_16k.wav")
    a = full[: 30 * SR]
    report = {"material": "jpn_mix_16k.wav 先頭 30 秒（公式 sample、MaAI commit 113efb7）"}
    for cfg in CFGS:
        key = f"{cfg['lang']}_{cfg['model_type']}_{cfg['frame_rate']:g}hz"
        print("==", key, flush=True)
        r = DirectRunner(keep_raw=True, **cfg)
        spf = r.samples_per_frame
        rep: dict = {
            "variant": r.m.variant,
            "samples_per_frame": spf,
            "audio_frame_size_threshold": r.m.audio_frame_size,
            "feeds_per_frame_at_320": spf / CHUNK_20MS,
        }
        # 1. サンプル番号
        frames, _ = run_chunks(r, a, CHUNK_20MS)
        ends = [f.end_sample for f in frames]
        rep["first_end_samples"] = ends[:4]
        rep["n_results"] = len(ends)
        rep["all_intervals_equal_frame"] = bool(np.all(np.diff(ends) == spf))
        rep["ends_are_multiples_of_frame"] = bool(np.all(np.asarray(ends) % spf == 0))
        rep["x_echo_matches_input"] = bool(
            all(
                np.array_equal(f.raw["x1"], a[f.end_sample - spf : f.end_sample, 0])
                and np.array_equal(f.raw["x2"], a[f.end_sample - spf : f.end_sample, 1])
                for f in frames
            )
        )
        base = arr(frames, "p_now")

        # 2. 決定性と reset
        again, _ = run_chunks(r, a, CHUNK_20MS)
        rep["rerun_after_reset_max_abs_diff_p_now"] = float(np.abs(arr(again, "p_now") - base).max())

        # 3. 送信単位
        chunks = {}
        for c in (160, 320, 640, spf, 480, 512, 1000):
            fs, err = run_chunks(r, a, c)
            if err:
                chunks[c] = {"error": err}
                continue
            e = [f.end_sample for f in fs]
            info = {
                "divides_frame": spf % c == 0,
                "n_results": len(fs),
                "first_end_samples": e[:3],
                "x1_lengths": sorted({len(f.raw["x1"]) for f in fs}),
            }
            if len(fs) == len(frames) and e == ends:
                info["max_abs_diff_p_now_vs_320"] = float(np.abs(arr(fs, "p_now") - base).max())
            chunks[c] = info
        rep["chunk_sizes"] = chunks

        # 4. 別スレッドから呼ぶ（ワーカースレッド 1 本の想定）
        box = {}

        def worker():
            box["frames"], box["err"] = run_chunks(r, a, CHUNK_20MS)

        th = threading.Thread(target=worker)
        th.start()
        th.join()
        rep["from_other_thread_max_abs_diff_p_now"] = (
            float(np.abs(arr(box["frames"], "p_now") - base).max()) if box["frames"] else box["err"]
        )

        # 5. 因果性: k 以降をゼロにしたとき、最初に値が変わる結果
        causal = []
        for k_s in (10.0, 15.03, 20.07):
            k = int(k_s * SR)
            b = a.copy()
            b[k:, :] = 0
            fs, _ = run_chunks(r, b, CHUNK_20MS)
            v = arr(fs, "p_now")
            diff = np.abs(v - base).max(1)
            i = int(np.argmax(diff > 1e-6))
            causal.append(
                {
                    "changed_from_sample": k,
                    "first_changed_result_end_sample": ends[i],
                    "previous_result_end_sample": ends[i - 1],
                    "unchanged_before": bool(diff[:i].max() <= 1e-6),
                }
            )
        rep["causality"] = causal

        # 6. 誤用
        misuse = {}
        r.reset()
        try:
            r.feed(a[:320, 0], a[:300, 1])
            res = []
            for i in range(1, 40):
                res += r.feed(a[i * 320 : (i + 1) * 320, 0], a[i * 320 : (i + 1) * 320, 1])
            misuse["ch2_short_by_20_samples_once"] = {
                "raised": False,
                "n_results": len(res),
                "x_len_ch1_ch2": [len(r.m.current_x1_audio), len(r.m.current_x2_audio)],
                "note": "バッファ長は ch1 だけで判定し、ch2 は末尾 320 を残すので例外にならない",
            }
        except Exception as e:  # noqa: BLE001
            misuse["ch2_short_by_20_samples_once"] = {"raised": True, "error": f"{type(e).__name__}: {str(e)[:200]}"}
        # 例外の後の状態: バッファが残るので次の呼び出しも失敗するか。reset で戻るか。
        after = {}
        try:
            r.reset()
            r.feed(a[:320, 0], a[:300, 1])
            for i in range(1, 40):
                r.feed(a[i * 320 : (i + 1) * 320, 0], a[i * 320 : (i + 1) * 320, 1])
        except Exception:  # noqa: BLE001
            try:
                r.feed(a[:320, 0], a[:320, 1])
                after["next_call_after_error"] = "ok"
            except Exception as e:  # noqa: BLE001
                after["next_call_after_error"] = f"{type(e).__name__}"
            frames_r, err = run_chunks(r, a, CHUNK_20MS)
            after["after_reset_max_abs_diff_p_now"] = float(np.abs(arr(frames_r, "p_now") - base).max()) if frames_r else err
        misuse["recovery"] = after
        r.reset()
        i16 = (a[: 5 * SR] * 32767).astype(np.int16)
        try:
            fs = r.run(i16)
            misuse["int16_without_conversion"] = {
                "raised": False,
                "vad_mean": arr(fs, "vad").mean(0).round(4).tolist(),
                "any_nan": bool(np.isnan(arr(fs, "p_now")).any()),
            }
        except Exception as e:  # noqa: BLE001
            misuse["int16_without_conversion"] = {"raised": True, "error": f"{type(e).__name__}: {str(e)[:200]}"}
        rep["misuse"] = misuse

        # 7. start() 経路との一致（直接呼び出しが別物でないことの確認）
        del r
        pn = via_start(cfg, a)
        rep["start_path"] = {"n_results": len(pn)}
        if len(pn) == len(base):
            rep["start_path"]["max_abs_diff_p_now"] = float(np.abs(pn - base).max())
        report[key] = rep
        print({k: v for k, v in rep.items() if k != "chunk_sizes"}, flush=True)
        print(rep["chunk_sizes"], flush=True)
    print("saved", save_result("direct_process.json", report))


if __name__ == "__main__":
    main()
