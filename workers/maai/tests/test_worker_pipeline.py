"""pipeline と processor。エンジンは test double（tests/support）で、実 MaAI の性質はここでは確かめない。"""

import json
from pathlib import Path

import numpy as np
import pytest

from contract import validate
from maai_worker.engine import EngineRequest, check_model_input
from maai_worker.errors import WorkerFatal
from maai_worker.pipeline import AudioPipeline, Period
from maai_worker.processor import VapProcessor, _peak, input_digest
from maai_worker.replay import run_replay
from maai_worker.settings import DEFAULT_CONFIG_PATH, load_settings
from support.scripted_engine import ScriptedEngine

SPF = 1280
FRAME = 320
REQUEST = EngineRequest("jp_kyoto", "normal-ver2", 12.5, "2ch")


def ramp(start, count, offset=0):
    """位置が分かる音声。mic と sys で値が違い、片方だけのずれが値で分かる。"""
    return ((np.arange(start, start + count) + offset) % 30000).astype(np.int16)


def feed(pipeline, start, count=FRAME):
    return pipeline.ingest(start, ramp(start, count), ramp(start, count, 7))


def drain(pipeline):
    periods = []
    while (p := pipeline.take_period(0)) is not None:
        periods.append(p)
    return periods


def assert_channels_in_step(period):
    assert np.array_equal(period.mic, ramp(period.start, SPF))
    assert np.array_equal(period.sys, ramp(period.start, SPF, 7))


def test_periods_are_cut_at_the_frame_period():
    p = AudioPipeline(SPF, None)
    for i in range(10):
        assert feed(p, i * FRAME) == []
    periods = drain(p)
    assert [x.start for x in periods] == [0, 1280]
    for x in periods:
        assert_channels_in_step(x)
    assert p.snapshot().pending_samples == 2 * FRAME


def test_stream_origin_is_the_first_frame_and_not_a_gap():
    p = AudioPipeline(SPF, None)
    assert feed(p, 64000) == []
    assert p.snapshot().dropped_network == 0
    feed(p, 64320), feed(p, 64640), feed(p, 64960)
    assert drain(p)[0].start == 64000


def test_network_gap_is_zero_filled_on_both_channels_and_reported():
    p = AudioPipeline(SPF, None)
    feed(p, 0)
    messages = feed(p, 960)
    assert messages == [
        {
            "type": "FRAMES_DROPPED",
            "from_audio_frame": 320,
            "sample_count": 640,
            "cause": "network_gap",
            "zero_filled": True,
            "channels": "both",
        }
    ]
    validate("maai_rpc.worker_to_node", messages[0])
    [period] = drain(p)
    assert period.start == 0
    assert np.array_equal(period.mic[320:960], np.zeros(640)) and np.array_equal(period.sys[320:960], np.zeros(640))
    assert np.array_equal(period.mic[960:], ramp(960, 320)) and np.array_equal(period.sys[960:], ramp(960, 320, 7))
    assert p.snapshot().dropped_network == 640


def test_gap_not_multiple_of_frame_keeps_the_period_phase():
    p = AudioPipeline(SPF, None)
    feed(p, 0)
    feed(p, 333, 320)  # 13 サンプルの欠損
    feed(p, 653, 1000)
    period = drain(p)[0]
    assert (period.start, period.end) == (0, 1280)
    assert np.array_equal(period.sys[320:333], np.zeros(13))


def test_overload_drops_both_channels_in_whole_periods_and_stays_in_step():
    p = AudioPipeline(SPF, 5120)
    dropped = []
    for i in range(0, 40):
        dropped += feed(p, i * FRAME)
    assert dropped, "the backlog must have been dropped"
    for m in dropped:
        validate("maai_rpc.worker_to_node", m)
        assert m["cause"] == "overload" and m["channels"] == "both" and m["zero_filled"] is False
        assert m["from_audio_frame"] % SPF == 0 and m["sample_count"] % SPF == 0
    assert p.snapshot().dropped_overload == sum(m["sample_count"] for m in dropped)
    periods = drain(p)
    assert periods
    for x in periods:
        assert x.start % SPF == 0
        assert_channels_in_step(x)
    # 破棄された範囲は process へ渡らない。
    starts = {x.start for x in periods}
    for m in dropped:
        assert not starts & set(range(m["from_audio_frame"], m["from_audio_frame"] + m["sample_count"]))


@pytest.mark.parametrize("backlog", [None, 5120])
def test_frames_that_straddle_periods_keep_both_channels_in_step(backlog):
    """枠の途中で周期が切れる場合。片方のチャネルだけ切り口が進むと、ここで値がずれる。"""
    p = AudioPipeline(SPF, backlog)
    periods = []
    for i in range(30):
        feed(p, i * 1000, 1000)
        if i % 3 == 0:
            periods += drain(p)
    periods += drain(p)
    assert len(periods) > 3
    for x in periods:
        assert_channels_in_step(x)


def test_no_drop_below_the_backlog_limit():
    p = AudioPipeline(SPF, 5120)
    for i in range(16):
        assert feed(p, i * FRAME) == []
    assert p.snapshot().dropped_overload == 0


def test_overload_can_drop_zero_filled_range_without_allocating_it():
    p = AudioPipeline(SPF, 5120)
    feed(p, 0)
    messages = feed(p, 16000 * 3600)
    assert [m["cause"] for m in messages] == ["network_gap", "overload"]
    periods = drain(p)
    assert periods == [] or all(len(x.mic) == SPF for x in periods)


def test_gap_within_the_zero_fill_allowance_is_not_treated_as_overload():
    p = AudioPipeline(SPF, 5120, 32000)
    feed(p, 0)
    messages = feed(p, 8320)  # 0.5 秒の欠損。滞留の上限（5120）は超える
    assert [m["cause"] for m in messages] == ["network_gap"]
    assert p.snapshot().dropped_overload == 0
    periods = drain(p)
    assert np.array_equal(periods[1].mic, np.zeros(SPF)) and np.array_equal(periods[1].sys, np.zeros(SPF))


def test_gap_beyond_the_allowance_drops_only_the_excess():
    p = AudioPipeline(SPF, 5120, 32000)
    feed(p, 0)
    messages = feed(p, 16000 * 10)
    assert [m["cause"] for m in messages] == ["network_gap", "overload"]
    snap = p.snapshot()
    assert snap.dropped_overload % SPF == 0
    assert 32000 <= snap.pending_samples <= 32000 + 5120


def test_real_audio_backlog_is_still_dropped_after_a_zero_filled_gap():
    p = AudioPipeline(SPF, 5120, 32000)
    feed(p, 0)
    feed(p, 8320)
    dropped = []
    for i in range(1, 60):
        dropped += feed(p, 8320 + i * FRAME)
    assert any(m["cause"] == "overload" for m in dropped)


def test_late_frames_never_rewrite_what_was_sent():
    p = AudioPipeline(SPF, None)
    feed(p, 0), feed(p, 320)
    assert feed(p, 0) == []
    assert p.snapshot().late_samples == 320
    feed(p, 480, 320)  # 前半だけ重複
    feed(p, 800, 480)
    assert p.snapshot().late_samples == 480
    [period] = drain(p)
    assert_channels_in_step(period)


def test_mismatched_channels_are_refused():
    p = AudioPipeline(SPF, None)
    with pytest.raises(WorkerFatal) as err:
        p.ingest(0, np.zeros(320, dtype=np.int16), np.zeros(300, dtype=np.int16))
    assert err.value.code == "channel_length_mismatch"


def make_processor(**kw):
    engine = ScriptedEngine(skip_first=False, **kw)
    return VapProcessor(engine, REQUEST, 0.5, 16, 3), engine


def full_period(start=0):
    p = AudioPipeline(SPF, None)
    for i in range(4):
        feed(p, start + i * FRAME)
    return p.take_period(0)


def test_processor_normalizes_to_the_contract_and_converts_to_float32():
    processor, engine = make_processor()
    period = full_period()
    message = processor.run_period(period)
    validate("maai_rpc.worker_to_node", message)
    assert message["audio_frame"] == SPF
    assert message["p_now"] == [0.25, 0.75]
    assert message["user_speaking"] is True and message["system_speaking"] is False
    assert "x1" not in message["raw"] and "x2" not in message["raw"]
    assert message["raw"]["worker_input"] == input_digest(period)
    x1, x2 = engine.calls[0]
    assert x1.dtype == np.float32 and x2.dtype == np.float32
    assert x1[5] == period.mic[5] / 32768 and x2[5] == period.sys[5] / 32768
    assert processor.recent_rtf_p95() is not None


def test_mic_goes_to_x1_and_sys_to_x2():
    processor, engine = make_processor()
    period = full_period()
    processor.run_period(period)
    x1, x2 = engine.calls[0]
    assert np.array_equal(x1, period.mic.astype(np.float32) / 32768)
    assert np.array_equal(x2, period.sys.astype(np.float32) / 32768)


@pytest.mark.parametrize(
    "fault,code",
    [
        ("swap_channels", "channel_misaligned"),
        ("nan", "non_finite_output"),
        ("two_results", "unexpected_result_count"),
    ],
)
def test_processor_refuses_to_emit_on_faults(fault, code):
    processor, _ = make_processor(fault=fault)
    with pytest.raises(WorkerFatal) as err:
        processor.run_period(full_period())
    assert err.value.code == code


def test_first_period_without_result_is_not_an_error():
    processor = VapProcessor(ScriptedEngine(), REQUEST, 0.5, 16, 3)
    assert processor.run_period(full_period()) is None
    assert processor.recent_rtf_p95() is None
    assert processor.run_period(full_period(SPF))["audio_frame"] == 2 * SPF


def test_1ch_output_is_a_different_shape():
    engine = ScriptedEngine(skip_first=False)
    engine.process = lambda x1, x2: [
        {"t": 1.0, "x1": x1.copy(), "x2": x2.copy(), "p_now": 0.3, "p_future": 0.2, "vad": 0.8}
    ]
    request = EngineRequest("jp", "normal-ver2", 12.5, "1ch")
    message = VapProcessor(engine, request, 0.5, 16, 3).run_period(full_period())
    validate("maai_rpc.worker_to_node", message)
    assert message["p_now"] == 0.3
    assert message["system_speaking"]["value"] is None


def test_probability_rounding_is_clamped_but_real_excess_is_fatal():
    processor, engine = make_processor()
    original = engine.process
    def slightly(x1, x2):
        out = original(x1, x2)
        out[0]["p_now"] = [1.000001, 0.0]
        return out
    engine.process = slightly
    assert processor.run_period(full_period())["p_now"][0] == 1.0
    def far(x1, x2):
        out = original(x1, x2)
        out[0]["p_now"] = [1.5, 0.0]
        return out
    engine.process = far
    with pytest.raises(WorkerFatal):
        processor.run_period(full_period())


def test_replay_records_valid_messages_with_the_runtime_pipeline():
    settings = load_settings(DEFAULT_CONFIG_PATH)
    engine = ScriptedEngine()
    out = []
    n = 16000
    summary = run_replay(engine, REQUEST, settings, 0.5, ramp(0, n), ramp(0, n, 7), out.append, FRAME, 3200)
    states = [m for m in out if m["type"] == "VAP_STATE"]
    assert summary["vap_states"] == len(states) == n // SPF - 1
    assert summary["frames_dropped_overload"] == 0
    assert summary["tail_samples_unprocessed"] == n - (n // SPF) * SPF
    assert states[0]["audio_frame"] == 3200 + 2 * SPF
    for m in out:
        validate("maai_rpc.worker_to_node", m)
    assert set(summary["contention"]) >= {"contended", "other_process_cores", "busy_cores_all_processes"}


def test_replay_realtime_drops_when_processing_cannot_keep_up():
    settings = load_settings(DEFAULT_CONFIG_PATH)
    engine = ScriptedEngine(delay_s=0.2)  # RTF 2.5
    out = []
    n = 16000
    summary = run_replay(engine, REQUEST, settings, 0.5, ramp(0, n), ramp(0, n, 7), out.append, FRAME, realtime=True)
    assert summary["frames_dropped_overload"] > 0
    assert all(m["channels"] == "both" for m in out if m["type"] == "FRAMES_DROPPED")


def test_process_exception_resets_the_model_and_continues():
    processor, engine = make_processor(fault="raise")
    engine.fault_after = 0
    message = processor.run_period(full_period())
    validate("maai_rpc.worker_to_node", message)
    assert message["type"] == "ERROR" and message["code"] == "process_failed_reset" and message["fatal"] is False
    assert engine.resets == 1 and processor.process_resets == 1
    engine.fault = None
    assert processor.run_period(full_period(SPF))["audio_frame"] == 2 * SPF


def test_repeated_process_exceptions_are_fatal():
    processor, engine = make_processor(fault="raise")
    assert processor.run_period(full_period())["type"] == "ERROR"
    assert processor.run_period(full_period(SPF))["type"] == "ERROR"
    with pytest.raises(WorkerFatal) as err:
        processor.run_period(full_period(2 * SPF))
    assert err.value.code == "process_failed"
    assert engine.resets == 2


def test_int16_never_reaches_the_model():
    processor, engine = make_processor()
    period = full_period()
    bad = Period(period.start, period.mic.astype(np.float32), period.sys.astype(np.float32))
    with pytest.raises(WorkerFatal) as err:
        processor.run_period(bad)
    assert err.value.code == "bad_model_input"
    assert engine.calls == []
    with pytest.raises(WorkerFatal):
        check_model_input(period.mic, period.sys)
    with pytest.raises(WorkerFatal):
        check_model_input(np.zeros(4, dtype=np.float32), np.zeros(3, dtype=np.float32))
    check_model_input(np.zeros(4, dtype=np.float32), np.zeros(4, dtype=np.float32))


def test_digital_zero_stays_zero_and_input_properties_are_logged():
    processor, engine = make_processor()
    p = AudioPipeline(SPF, None)
    silence = np.zeros(SPF, dtype=np.int16)
    noise = np.full(SPF, 3, dtype=np.int16)
    p.ingest(0, noise, silence)
    message = processor.run_period(p.take_period(0))
    digest = message["raw"]["worker_input"]
    assert digest["x1_peak"] == 3 and digest["x1_digital_zero"] is False
    assert digest["x2_peak"] == 0 and digest["x2_digital_zero"] is True
    assert np.array_equal(engine.calls[0][1], np.zeros(SPF, dtype=np.float32))
    assert _peak(np.array([-32768], dtype=np.int16)) == 32768


def test_config_records_decided_values_and_marks_the_provisional_ones():
    data = json.loads(Path(DEFAULT_CONFIG_PATH).read_text("utf-8"))
    assert data["session_defaults"]["lang"] == "jp_kyoto"
    assert data["session_defaults"]["model_type"] == "normal-ver2"
    assert data["session_defaults"]["frame_rate_hz"] == 12.5
    settings = load_settings(DEFAULT_CONFIG_PATH)
    assert settings.engine.torch_threads == 4 and settings.engine.mimi_onnx_cpu_intra_threads == 4
    assert settings.engine.mimi_onnx_revision.startswith("303ef4e")
    assert {"engine.mc", "runtime.max_backlog_ms"} <= set(data["provisional_fields"])
