"""TS と同じ固定サンプルを、生成された JSON Schema で検証する。"""

import json
from pathlib import Path

import pytest

from contract import (
    ContractViolation,
    FrameError,
    SCHEMA_NAMES,
    decode_audio_frame,
    decode_pcm_frame,
    encode_audio_frame,
    encode_pcm_frame,
    is_valid,
    validate,
)

REPO = Path(__file__).resolve().parents[3]
FIXTURES = json.loads((REPO / "packages/contracts/fixtures/contract_fixtures.json").read_text("utf-8"))

VALID = [(schema, f["name"], f["value"]) for schema, items in FIXTURES["valid"].items() for f in items]
REMOVALS = [
    (schema, name, key, value)
    for schema, name, value in VALID
    for key in value
]
INVALID = [(name, c["schema"], c["value"]) for name, c in FIXTURES["invalid"].items()]


def test_all_schemas_are_generated():
    assert set(FIXTURES["valid"]) == set(SCHEMA_NAMES)


@pytest.mark.parametrize("schema,name,value", VALID, ids=[f"{s}/{n}" for s, n, _ in VALID])
def test_valid_fixture(schema, name, value):
    validate(schema, value)
    validate(schema, json.loads(json.dumps(value)))


@pytest.mark.parametrize(
    "schema,name,key,value", REMOVALS, ids=[f"{s}/{n}-{k}" for s, n, k, _ in REMOVALS]
)
def test_missing_required_field_is_detected(schema, name, key, value):
    copy = dict(value)
    del copy[key]
    assert not is_valid(schema, copy)


@pytest.mark.parametrize("schema,name,value", VALID, ids=[f"{s}/{n}" for s, n, _ in VALID])
def test_unknown_field_is_rejected(schema, name, value):
    assert not is_valid(schema, {**value, "typo_field": 1})


def test_step_state_allows_e1_extension_only_inside_state():
    value = FIXTURES["valid"]["turn.step_output"][0]["value"]
    assert "e1_extension" in value["state"]
    validate("turn.step_output", value)


@pytest.mark.parametrize("name,schema,value", INVALID, ids=[n for n, _, _ in INVALID])
def test_invalid_fixture(name, schema, value):
    with pytest.raises(ContractViolation):
        validate(schema, value)


@pytest.mark.parametrize("policy", ["hri2025", "ja"])
def test_policy_files_validate(policy):
    data = json.loads((REPO / f"config/policy.{policy}.json").read_text("utf-8"))
    validate(f"policy.{policy}", data)


def test_unknown_schema_name():
    with pytest.raises(KeyError):
        is_valid("nope", {})


# ---- バイナリ枠: TS と同じバイト列 ------------------------------------------


def test_audio_frame_matches_ts():
    fixture = FIXTURES["binary"]["audio"]
    raw = bytes.fromhex(fixture["hex"])
    frame = decode_audio_frame(raw)
    assert frame.audio_frame == fixture["audio_frame"]
    assert list(frame.mic) == fixture["mic"]
    assert list(frame.sys) == fixture["sys"]
    assert encode_audio_frame(fixture["audio_frame"], fixture["mic"], fixture["sys"]) == raw


@pytest.mark.parametrize("key", ["pcm", "pcm_end"])
def test_pcm_frame_matches_ts(key):
    fixture = FIXTURES["binary"][key]
    raw = bytes.fromhex(fixture["hex"])
    frame = decode_pcm_frame(raw)
    assert frame.audio_playback_id == fixture["audio_playback_id"]
    assert frame.generation == fixture["generation"]
    assert frame.seq == fixture["seq"]
    assert frame.sample_rate_hz == fixture["sample_rate_hz"]
    assert frame.end_of_stream == fixture["end_of_stream"]
    assert list(frame.pcm) == fixture["pcm"]
    assert (
        encode_pcm_frame(
            fixture["audio_playback_id"],
            fixture["generation"],
            fixture["seq"],
            fixture["sample_rate_hz"],
            fixture["pcm"],
            fixture["end_of_stream"],
        )
        == raw
    )


@pytest.mark.parametrize(
    "mutate,code",
    [
        (lambda b: b[:2], "too_short"),
        (lambda b: b[:-1], "bad_length"),
        (lambda b: b + b"\x00\x00", "bad_length"),
        (lambda b: bytes([9]) + b[1:], "bad_version"),
        (lambda b: b[:1] + bytes([2]) + b[2:], "bad_kind"),
        (lambda b: b[:2] + bytes([2]) + b[3:], "bad_format"),
    ],
)
def test_audio_frame_rejects_malformed(mutate, code):
    raw = bytes.fromhex(FIXTURES["binary"]["audio"]["hex"])
    with pytest.raises(FrameError) as err:
        decode_audio_frame(mutate(raw))
    assert err.value.code == code


def test_encode_rejects_mismatched_channels():
    with pytest.raises(FrameError):
        encode_audio_frame(0, [1, 2], [1])


# ---- スタブ ----------------------------------------------------------------


def test_pyaudio_stub_refuses_to_open_devices():
    import pyaudio

    assert "compat" in pyaudio.__file__
    with pytest.raises(RuntimeError, match="stub"):
        pyaudio.PyAudio()
