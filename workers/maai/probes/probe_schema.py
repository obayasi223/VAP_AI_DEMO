#!/usr/bin/env python
"""実際の get_result 相当の出力を variant ごとに取得し、docs/maai_output_schema.json を生成する。

`process()` の結果は `Maai.result_dict_queue` に入るものそのまま（get_result() はこのキューの get）。
ndarray は JSON で表せないので `describe_result()` で dtype と shape の記述に変換してから検証する。
スキーマは手書きせず、観測した型からここで組み立てる（嘘の固定を避けるため）。
"""
from __future__ import annotations

import json
from datetime import date
from importlib.metadata import version

import numpy as np

from probe_common import DirectRunner, SCHEMA_PATH, SR, load_wav

V2 = dict(model_type="normal-ver2", frame_rate=12.5)
CPC = dict(model_type="normal", frame_rate=10)
# (要求, 期待する型の定義名)
CAPTURES = [
    (dict(lang="jp_kyoto", mc=True, **V2), "vap_2ch"),
    (dict(lang="jp_kyoto", mc=False, **V2), "vap_2ch"),
    (dict(lang="jp", mc=True, **V2), "vap_2ch"),
    (dict(lang="jp", mc=False, **V2), "vap_2ch"),
    (dict(lang="jp_kyoto", mc=True, **CPC), "vap_2ch"),
    (dict(lang="jp_kyoto", mc=False, **CPC), "vap_2ch"),
    (dict(lang="jp", mc=True, **CPC), "vap_2ch"),
    (dict(lang="jp", mc=False, **CPC), "vap_2ch"),
    (dict(lang="jp", mc=True, mono=True, **V2), "vap_1ch"),
    (dict(lang="jp", mc=False, mono=True, **V2), "vap_1ch"),
    (dict(lang="jp", mc=False, mono=True, **CPC), "vap_1ch"),
    (dict(lang="jp_kyoto", mc=True, return_p_bins=True, **V2), "vap_2ch_bins"),
    (dict(lang="jp", mc=True, mono=True, return_p_bins=True, **V2), "vap_1ch_bins"),
]


def describe_result(r: dict) -> dict:
    """結果の dict を JSON で検証できる形へ。ndarray は dtype と shape に置き換える。"""

    def conv(v):
        if isinstance(v, np.ndarray):
            return {"ndarray": True, "dtype": str(v.dtype), "shape": list(v.shape)}
        if isinstance(v, (list, tuple)):
            return [conv(x) for x in v]
        if isinstance(v, np.generic):
            return v.item()
        return v

    return {k: conv(v) for k, v in r.items()}


def signature(v) -> object:
    """値を除いた型の形。"""
    if isinstance(v, dict):
        if v.get("ndarray"):
            return f"ndarray[{v['dtype']},{'x'.join(map(str, v['shape']))}]"
        return {k: signature(x) for k, x in sorted(v.items())}
    if isinstance(v, list):
        return [signature(x) for x in v]
    return type(v).__name__


def capture(cfg: dict, seconds=12) -> tuple[DirectRunner, list[dict]]:
    r = DirectRunner(keep_raw=True, **cfg)
    a = load_wav("jpn_mix_16k.wav")[: seconds * SR]
    frames = r.run(a)
    return r, [describe_result(f.raw) for f in frames]


def main():
    prob = {"type": "number", "minimum": 0.0, "maximum": 1.0}
    pair = {"type": "array", "items": {"$ref": "#/$defs/probability"}, "minItems": 2, "maxItems": 2}
    defs: dict = {
        "probability": prob,
        "probability_pair": pair,
        "audio_echo": {
            "description": "このフレームで process に渡した音声そのもの（先頭の 320 サンプルの文脈は含まない）。"
            "実物は numpy.ndarray。describe_result() で dtype と shape に変換して検証する。",
            "type": "object",
            "properties": {
                "ndarray": {"const": True},
                "dtype": {"const": "float32"},
                "shape": {"type": "array", "items": {"type": "integer"}, "minItems": 1, "maxItems": 1},
            },
            "required": ["ndarray", "dtype", "shape"],
            "additionalProperties": False,
        },
    }
    variants, seen_sig = [], {}
    for cfg, name in CAPTURES:
        r, rows = capture(cfg)
        sig = signature(rows[0])
        assert all(signature(x) == sig for x in rows), f"型が途中で変わった: {cfg}"
        is_2ch = isinstance(rows[0]["p_now"], list)
        assert is_2ch == name.startswith("vap_2ch"), (cfg, sig)
        seen_sig.setdefault(name, sig)
        # 値の範囲も実物で確認する
        vals = [x["p_now"] for x in rows]
        if is_2ch:
            assert max(abs(sum(v) - 1) for v in vals) < 1e-3  # 実測の誤差は x-variants に記録
        variants.append(
            {
                "request": {k: v for k, v in cfg.items() if k != "mono"},
                "audio_ch2": "omitted" if cfg.get("mono") else "MaaiInput.Chunk (2ch)",
                "loaded_variant": r.m.variant,
                "is_mono": r.m.is_mono,
                "single_tower": r.m.single_tower,
                "encoder_type": r.m.encoder_type,
                "samples_per_frame": r.samples_per_frame,
                "first_result_end_sample": (2 if r.m.encoder_type == "mimi" else 1) * r.samples_per_frame,
                "schema_ref": f"#/$defs/{name}",
                "observed_signature": sig,
                "first_frames_p_now_sum_max_abs_err": max(abs(sum(v) - 1) for v in vals) if is_2ch else None,
            }
        )
        print(cfg, r.m.variant, sig, flush=True)

    # jp_kyoto は 1ch の重みがない。ch2 省略時の実際の挙動を記録する。
    r = DirectRunner(lang="jp_kyoto", mono=True, keep_raw=True, **V2)
    a = load_wav("jpn_mix_16k.wav")[: 6 * SR]
    fs = r.run(np.stack([a[:, 0], np.zeros(len(a), dtype=np.float32)], 1))
    fb = describe_result(fs[0].raw)
    fallback = {
        "request": {"lang": "jp_kyoto", "audio_ch2": "omitted", **V2},
        "loaded_variant": r.m.variant,
        "is_mono": r.m.is_mono,
        "p_now_type": signature(fb)["p_now"],
        "note": "1ch モデルは存在せず 2ch モデルへフォールバックする。p は [ch1, ch2] の組のまま",
    }
    print(fallback)

    base = {
        "type": "object",
        "required": ["t", "x1", "x2", "p_now", "p_future", "vad"],
        "additionalProperties": False,
        "properties": {
            "t": {"type": "number", "description": "time.time() の壁時計（秒）。サンプル番号ではない"},
            "x1": {"$ref": "#/$defs/audio_echo"},
            "x2": {"$ref": "#/$defs/audio_echo"},
        },
    }

    def obj(p, desc, extra=None):
        d = json.loads(json.dumps(base))
        d["description"] = desc
        d["properties"].update({k: {"$ref": f"#/$defs/{p}"} for k in ("p_now", "p_future", "vad")})
        if extra:
            d["properties"].update(extra)
            d["required"] = d["required"] + list(extra)
        return d

    defs["vap_2ch"] = obj(
        "probability_pair",
        "2ch モデル。p_now[i], p_future[i], vad[i] の i=0 は x1(audio_ch1)、i=1 は x2(audio_ch2)。"
        "p_now, p_future は話者間で正規化され和がほぼ 1（誤差は x-variants の実測値。厳密な一致を前提にしない）。",
    )
    defs["vap_1ch"] = obj(
        "probability",
        "1ch モデル。スカラーで入力話者のみ。正規化されない。2ch と同じしきい値を流用しないこと。",
    )
    sig_b2, sig_b1 = seen_sig["vap_2ch_bins"], seen_sig["vap_1ch_bins"]
    print("bins signatures", sig_b2["p_bins"], sig_b2["p_bins_now"], sig_b1["p_bins"], sig_b1["p_bins_now"])

    def from_sig(s):
        if isinstance(s, list):
            return {"type": "array", "minItems": len(s), "maxItems": len(s), "prefixItems": [from_sig(x) for x in s], "items": False}
        return {"$ref": "#/$defs/probability"}

    defs["vap_2ch_bins"] = obj(
        "probability_pair",
        "2ch、return_p_bins=True。ビンは話者間で正規化されない。",
        {k: from_sig(sig_b2[k]) for k in ("p_bins", "p_bins_now", "p_bins_future")},
    )
    defs["vap_1ch_bins"] = obj(
        "probability",
        "1ch、return_p_bins=True。",
        {k: from_sig(sig_b1[k]) for k in ("p_bins", "p_bins_now", "p_bins_future")},
    )
    doc = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "docs/maai_output_schema.json",
        "title": "MaAI mode=vap の結果 dict（実物から固定）",
        "description": "scripts: workers/maai/probes/probe_schema.py が生成。検証: workers/maai/probes/test_output_schema.py。"
        "x1,x2 は describe_result() で ndarray を記述へ変換した後の形。",
        "x-maai": {
            "version": version("maai"),
            "captured_on": date.today().isoformat(),
            "material": "jpn_mix_16k.wav（公式 sample）先頭 12 秒",
            "get_result": "Maai.result_dict_queue.get()。process() 直接呼び出しでも同じキューへ入る",
            "jp_kyoto_without_ch2": fallback,
        },
        "x-variants": variants,
        "oneOf": [{"$ref": f"#/$defs/{k}"} for k in ("vap_2ch", "vap_1ch", "vap_2ch_bins", "vap_1ch_bins")],
        "$defs": defs,
    }
    SCHEMA_PATH.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
    print("wrote", SCHEMA_PATH)


if __name__ == "__main__":
    main()
