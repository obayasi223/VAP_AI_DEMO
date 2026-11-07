"""実 MaAI の試験。重いので MAAI_REAL=1 のときだけ走る（既定では skip と表示される）。

python -m maai_worker を別プロセスで起動し、models/ja.wav を2ch で投入する。
"""

import json
import os
import subprocess
import sys
import time
import zlib
from pathlib import Path

import numpy as np
import pytest
from websockets.sync.client import connect

from contract import encode_audio_frame, validate

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
pytestmark = pytest.mark.skipif(os.environ.get("MAAI_REAL") != "1", reason="set MAAI_REAL=1 to run real MaAI")
ENV = {**os.environ, "HF_HUB_OFFLINE": "1"}


def load_ja():
    import soundfile as sf
    from scipy.signal import resample_poly

    data, rate = sf.read(str(REPO / "models" / "ja.wav"), dtype="float64")
    assert rate == 44100
    return np.round(resample_poly(data, 160, 441) * 32767).astype(np.int16)


def configure():
    policy = json.loads((REPO / "config" / "policy.ja.json").read_text("utf-8"))["vap"]
    settings = json.loads((ROOT / "worker_config.json").read_text("utf-8"))["session_defaults"]
    return {
        "type": "CONFIGURE",
        "protocol_version": 1,
        "session_id": "s_real",
        "lang": settings["lang"],
        "model_type": settings["model_type"],
        "channel_layout": policy["channel_layout"],
        "frame_rate_hz": settings["frame_rate_hz"],
        "sample_rate_hz": 16000,
        "frame_samples": settings["frame_samples"],
        "device": "cpu",
        "speaking_threshold": policy["speaking_threshold"],
    }


def test_real_maai_recovers_from_a_bad_chunk_with_reset_and_matches_a_clean_run():
    """Mimi は長さの合わない入力で例外を出し、次の呼び出しも失敗する。reset で戻ること。"""
    from maai_worker.engine import EngineRequest, load_real_engine
    from maai_worker.pipeline import Period
    from maai_worker.processor import VapProcessor
    from maai_worker.settings import load_settings

    settings = load_settings()
    d = settings.session_defaults
    request = EngineRequest(d.lang, d.model_type, d.frame_rate_hz, "2ch")
    engine = load_real_engine(request, settings.engine)
    assert engine.info.mimi_revision == settings.engine.mimi_onnx_revision
    processor = VapProcessor(engine, request, 0.5, 16, 3)
    speech = load_ja()[: 1280 * 12]
    silence = np.zeros_like(speech)

    def run(start=0):
        out = []
        for i in range(0, len(speech), 1280):
            m = processor.run_period(Period(start + i, speech[i : i + 1280], silence[i : i + 1280]))
            if m:
                out.append(m)
        return out

    clean = run()
    assert all(m["type"] == "VAP_STATE" for m in clean)
    assert clean[0]["raw"]["worker_input"]["x2_digital_zero"] is True
    engine.reset()
    # 周期の約数でない長さ。実 MaAI の例外を起こす。
    bad = processor.run_period(Period(0, speech[:2000], silence[:2000]))
    assert bad["type"] == "ERROR" and bad["code"] == "process_failed_reset"
    assert "Mimi" in bad["message"]
    again = run()
    assert [m["p_now"] for m in again] == [m["p_now"] for m in clean]


def crc(x):
    return zlib.crc32(x.astype("<i2").tobytes())


def test_real_maai_vad_follows_the_channel_that_has_speech():
    speech = load_ja()
    silence = np.zeros_like(speech)
    mic = np.concatenate([speech, silence])
    sys_ = np.concatenate([silence, speech])
    proc = subprocess.Popen(
        [sys.executable, "-m", "maai_worker", "--port", "0"],
        cwd=ROOT, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    try:
        port = json.loads(proc.stdout.readline())["port"]
        ws = connect(f"ws://127.0.0.1:{port}", compression=None).__enter__()
        ws.send(json.dumps(configure()))
        states = []
        ready = None
        deadline = time.monotonic() + 90
        while ready is None and time.monotonic() < deadline:
            m = json.loads(ws.recv(timeout=90))
            validate("maai_rpc.worker_to_node", m)
            if m["type"] == "READY":
                ready = m
        assert ready["is_fake"] is False and ready["maai_version"] == "0.2.25"
        # 速く流すと破棄が起きるので、受信しながら実時間の2倍の速さで送る。
        for i in range(0, len(mic) - 319, 320):
            ws.send(encode_audio_frame(i, mic[i : i + 320].tolist(), sys_[i : i + 320].tolist()))
            time.sleep(0.01)
            while True:
                try:
                    m = json.loads(ws.recv(timeout=0))
                except TimeoutError:
                    break
                validate("maai_rpc.worker_to_node", m)
                if m["type"] == "VAP_STATE":
                    states.append(m)
        end = time.monotonic() + 3
        while time.monotonic() < end:
            try:
                m = json.loads(ws.recv(timeout=0.2))
            except TimeoutError:
                continue
            if m["type"] == "VAP_STATE":
                states.append(m)
        half = len(speech)
        first = [s for s in states if s["audio_frame"] <= half]
        second = [s for s in states if s["audio_frame"] > half]
        assert len(first) > 40 and len(second) > 40
        assert np.mean([s["vad"][0] for s in first]) > np.mean([s["vad"][1] for s in first]) + 0.2
        assert np.mean([s["vad"][1] for s in second]) > np.mean([s["vad"][0] for s in second]) + 0.2
        for s in states:
            e = s["audio_frame"]
            assert s["raw"]["worker_input"]["x1_crc32"] == crc(mic[e - 1280 : e])
            assert s["raw"]["worker_input"]["x2_crc32"] == crc(sys_[e - 1280 : e])
        ws.send(json.dumps({"type": "SHUTDOWN", "reason": "test"}))
        assert proc.wait(10) == 0
        # MaAI の性能の print（約8秒ごと）が RPC の告知の stdout へ出ていない。
        assert proc.stdout.read() == ""
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        proc.stdout.close()
