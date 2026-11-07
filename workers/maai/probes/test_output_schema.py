"""docs/maai_output_schema.json の固定を確かめる。

静的な試験は重みなしで動く。実物の試験は重みと公式 sample が必要（なければ skip）。
重みがキャッシュにない環境でダウンロードしないよう、HF_HUB_OFFLINE=1 で実行する。
"""
import json
import os

import jsonschema
import numpy as np
import pytest

from probe_common import SCHEMA_PATH, SR, sample_dir

os.environ.setdefault("HF_HUB_OFFLINE", "1")
DOC = json.loads(SCHEMA_PATH.read_text())
ECHO = {"ndarray": True, "dtype": "float32", "shape": [1280]}


def validator(name):
    return jsonschema.Draft202012Validator({"$ref": f"#/$defs/{name}", "$defs": DOC["$defs"]})


def good_2ch():
    return {"t": 1.0, "x1": ECHO, "x2": ECHO, "p_now": [0.9, 0.1], "p_future": [0.6, 0.4], "vad": [1.0, 0.0]}


def good_1ch():
    return {"t": 1.0, "x1": ECHO, "x2": ECHO, "p_now": 0.9, "p_future": 0.6, "vad": 1.0}


def test_schema_is_valid():
    jsonschema.Draft202012Validator.check_schema(DOC)
    assert DOC["x-maai"]["version"] == "0.2.25"


def test_2ch_and_1ch_are_not_interchangeable():
    assert validator("vap_2ch").is_valid(good_2ch())
    assert validator("vap_1ch").is_valid(good_1ch())
    assert not validator("vap_2ch").is_valid(good_1ch())
    assert not validator("vap_1ch").is_valid(good_2ch())


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r.pop("vad"),
        lambda r: r.update(extra=1),
        lambda r: r.update(p_now=[0.5]),
        lambda r: r.update(p_now=[0.5, 0.3, 0.2]),
        lambda r: r.update(p_now=[1.5, -0.5]),
        lambda r: r.update(x1={"ndarray": True, "dtype": "int16", "shape": [1280]}),
    ],
)
def test_schema_rejects_changes(mutate):
    r = good_2ch()
    mutate(r)
    assert not validator("vap_2ch").is_valid(r)


def test_all_variants_recorded():
    loaded = {v["loaded_variant"] for v in DOC["x-variants"]}
    assert {"vap", "vap_mc", "vap_mono", "vap_mc_mono"} <= loaded
    fb = DOC["x-maai"]["jp_kyoto_without_ch2"]
    assert fb["is_mono"] is False, "jp_kyoto に 1ch の重みが追加されたら計画を見直す"


@pytest.mark.skipif(not (sample_dir() / "jpn_mix_16k.wav").exists(), reason="公式 sample がない")
@pytest.mark.parametrize("entry", DOC["x-variants"], ids=lambda e: f"{e['request']['lang']}-{e['loaded_variant']}-{e['request']['model_type']}-{'bins' if e['request'].get('return_p_bins') else 'nobins'}")
def test_real_output_matches_schema(entry):
    from probe_common import DirectRunner, load_wav
    from probe_schema import describe_result, signature

    cfg = dict(entry["request"])
    mono = entry["audio_ch2"] == "omitted"
    try:
        r = DirectRunner(keep_raw=True, mono=mono, **cfg)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"重みがキャッシュにない: {e}")
    assert r.m.variant == entry["loaded_variant"]
    a = load_wav("jpn_mix_16k.wav")[: 6 * SR]
    frames = r.run(a)
    assert frames[0].end_sample == entry["first_result_end_sample"]
    assert np.all(np.diff([f.end_sample for f in frames]) == entry["samples_per_frame"])
    v = validator(entry["schema_ref"].rsplit("/", 1)[1])
    for f in frames:
        d = describe_result(f.raw)
        v.validate(d)
        assert signature(d) == entry["observed_signature"]
