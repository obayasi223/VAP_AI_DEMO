"""RPC サーバーを別プロセスで起動して試す。エンジンは test double で、実 MaAI は test_real_maai.py。"""

import json
import os
import signal
import subprocess
import sys
import time
import zlib
from pathlib import Path

import numpy as np
import pytest
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

from contract import encode_audio_frame, validate

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tests" / "support" / "run_scripted_worker.py"
CONFIGURE = {
    "type": "CONFIGURE",
    "protocol_version": 1,
    "session_id": "s_test",
    "lang": "jp_kyoto",
    "model_type": "normal-ver2",
    "channel_layout": "2ch",
    "frame_rate_hz": 12.5,
    "sample_rate_hz": 16000,
    "frame_samples": 320,
    "device": "cpu",
    "speaking_threshold": 0.5,
}


class Worker:
    def __init__(self, *args):
        self.proc = subprocess.Popen(
            [sys.executable, str(SCRIPT), *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        line = self.proc.stdout.readline()
        self.port = json.loads(line)["port"]
        self._connection = connect(f"ws://127.0.0.1:{self.port}", compression=None)
        self.ws = self._connection.__enter__()
        self.messages = []

    def recv_until(self, predicate, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                message = json.loads(self.ws.recv(timeout=max(0.01, deadline - time.monotonic())))
            except TimeoutError:
                break
            validate("maai_rpc.worker_to_node", message)
            self.messages.append(message)
            if predicate(message):
                return message
        raise AssertionError(f"timed out; got {[m['type'] for m in self.messages][-20:]}")

    def configure(self, **overrides):
        self.ws.send(json.dumps({**CONFIGURE, **overrides}))
        return self.recv_until(lambda m: m["type"] == "READY")

    def send(self, start, mic, sys_):
        self.ws.send(encode_audio_frame(start, mic.tolist(), sys_.tolist()))

    def close(self):
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait()
        for s in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            s.close()


@pytest.fixture
def spawn():
    workers = []

    def make(*args):
        w = Worker(*args)
        workers.append(w)
        return w

    yield make
    for w in workers:
        w.close()


def noise(seed, n):
    return np.random.default_rng(seed).integers(-20000, 20000, n, dtype=np.int16)


def crc(x):
    return zlib.crc32(x.astype("<i2").tobytes())


def stream(worker, mic, sys_, start=0, pace_s=0.005):
    """pace_s=0 は一気に送る（滞留の試験用）。"""
    for i in range(0, len(mic) - 319, 320):
        worker.send(start + i, mic[i : i + 320], sys_[i : i + 320])
        if pace_s:
            time.sleep(pace_s)


def test_status_on_connect_then_ready_declares_itself(spawn):
    w = spawn()
    first = w.recv_until(lambda m: m["type"] == "WORKER_STATUS")
    assert first["status"] == "loading"
    ready = w.configure()
    assert ready["is_fake"] is True and ready["checkpoint"] == "FAKE_NOT_MAAI"
    ok = w.recv_until(lambda m: m["type"] == "WORKER_STATUS" and m["status"] == "ok")
    assert ok["rtf"]["value"] is None and ok["rtf"]["null_reason"]


def test_vap_state_positions_and_channel_digest(spawn):
    w = spawn()
    w.configure()
    mic, sys_ = noise(1, 12800), noise(2, 12800)
    stream(w, mic, sys_)
    states = []
    while len(states) < 9:
        states.append(w.recv_until(lambda m: m["type"] == "VAP_STATE"))
    for s in states:
        end = s["audio_frame"]
        assert end % 1280 == 0
        digest = s["raw"]["worker_input"]
        assert digest["x1_crc32"] == crc(mic[end - 1280 : end])
        assert digest["x2_crc32"] == crc(sys_[end - 1280 : end])


def test_overload_real_process_drops_both_channels_together(spawn):
    w = spawn("--delay-ms", "200")
    w.configure()
    mic, sys_ = noise(3, 16000 * 4), noise(4, 16000 * 4)
    stream(w, mic, sys_, pace_s=0)
    dropped = w.recv_until(lambda m: m["type"] == "FRAMES_DROPPED")
    assert dropped["cause"] == "overload" and dropped["channels"] == "both"
    w.recv_until(lambda m: m["type"] == "VAP_STATE")
    states = [m for m in w.messages if m["type"] == "VAP_STATE"]
    for s in states:
        end = s["audio_frame"]
        digest = s["raw"]["worker_input"]
        assert digest["x1_crc32"] == crc(mic[end - 1280 : end]) and digest["x2_crc32"] == crc(sys_[end - 1280 : end])
    status = w.recv_until(lambda m: m["type"] == "WORKER_STATUS" and m["status"] == "degraded")
    assert "recent_overload_drop" in status["reason"]["value"]
    assert status["frames_dropped_overload"] > 0 and status["rtf"]["value"] > 1


def test_gap_is_reported_and_zero_filled_in_the_digest(spawn):
    w = spawn()
    w.configure()
    mic, sys_ = noise(5, 6400), noise(6, 6400)
    stream(w, mic[:1280], sys_[:1280])
    stream(w, mic[3840:], sys_[3840:], start=3840)
    gap = w.recv_until(lambda m: m["type"] == "FRAMES_DROPPED")
    assert gap == {
        "type": "FRAMES_DROPPED", "from_audio_frame": 1280, "sample_count": 2560,
        "cause": "network_gap", "zero_filled": True, "channels": "both",
    }
    state = w.recv_until(lambda m: m["type"] == "VAP_STATE" and m["audio_frame"] == 2560)
    assert state["raw"]["worker_input"]["x1_crc32"] == crc(np.zeros(1280, dtype=np.int16))
    assert state["raw"]["worker_input"]["x2_crc32"] == crc(np.zeros(1280, dtype=np.int16))


def test_audio_before_ready_and_bad_messages_are_reported_not_fatal(spawn):
    w = spawn()
    w.send(0, noise(1, 320), noise(2, 320))
    err = w.recv_until(lambda m: m["type"] == "ERROR")
    assert err["code"] == "not_configured" and err["fatal"] is False
    w.ws.send(json.dumps({"type": "NOPE"}))
    assert w.recv_until(lambda m: m["type"] == "ERROR" and m["code"] == "bad_message")["fatal"] is False
    w.configure()
    w.ws.send(b"\x09\x01\x01\x00")
    assert w.recv_until(lambda m: m["type"] == "ERROR" and m["code"].startswith("bad_audio_frame"))["fatal"] is False


def test_ping_returns_worker_clock(spawn):
    w = spawn()
    w.ws.send(json.dumps({"type": "PING", "seq": 3, "t_ms": 12.5}))
    pong = w.recv_until(lambda m: m["type"] == "PONG")
    assert pong["seq"] == 3 and pong["t_ms"] == 12.5 and pong["worker_t_ms"] > 0


def test_shutdown_notifies_and_exits_zero(spawn):
    w = spawn()
    w.configure()
    w.ws.send(json.dumps({"type": "SHUTDOWN", "reason": "session_end"}))
    status = w.recv_until(lambda m: m["type"] == "WORKER_STATUS" and m["status"] == "down")
    assert status["reason"]["value"] == "shutdown: session_end"
    assert w.proc.wait(5) == 0


def test_sigterm_notifies_and_exits(spawn):
    w = spawn()
    w.configure()
    w.proc.send_signal(signal.SIGTERM)
    status = w.recv_until(lambda m: m["type"] == "WORKER_STATUS" and m["status"] == "down")
    assert status["reason"]["value"] == "sigterm"
    assert w.proc.wait(5) == 0


def test_parent_exit_closes_worker():
    proc = subprocess.Popen(
        [sys.executable, str(SCRIPT), "--exit-on-stdin-eof"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
    )
    json.loads(proc.stdout.readline())
    proc.stdin.close()
    assert proc.wait(5) == 0
    proc.stdout.close()


def test_load_failure_is_explicit_and_exit_code_is_nonzero(spawn):
    w = spawn("--fail-load")
    w.ws.send(json.dumps(CONFIGURE))
    err = w.recv_until(lambda m: m["type"] == "ERROR")
    assert err["code"] == "model_load" and err["fatal"] is True
    assert w.recv_until(lambda m: m["type"] == "WORKER_STATUS" and m["status"] == "down")
    assert w.proc.wait(5) == 4
    assert not [m for m in w.messages if m["type"] in ("READY", "VAP_STATE")]


@pytest.mark.parametrize(
    "fault,code", [("swap_channels", "channel_misaligned"), ("nan", "non_finite_output"), ("raise", "process_failed")]
)
def test_runtime_fault_stops_vap_and_exits_nonzero(spawn, fault, code):
    w = spawn("--fault", fault, "--fault-after", "3")
    w.configure()
    try:
        stream(w, noise(1, 12800), noise(2, 12800))
    except ConnectionClosed:
        pass  # 異常で閉じた後の送信。先に届いた通知を下で読む
    err = w.recv_until(lambda m: m["type"] == "ERROR" and m["fatal"])
    assert err["code"] == code
    w.recv_until(lambda m: m["type"] == "WORKER_STATUS" and m["status"] == "down")
    assert w.proc.wait(5) == 5


def test_hung_process_is_reported_as_stuck(spawn):
    w = spawn("--fault", "hang", "--fault-after", "2")
    w.configure()
    stream(w, noise(1, 6400), noise(2, 6400))
    w.recv_until(
        lambda m: m["type"] == "WORKER_STATUS" and m["status"] == "degraded" and "process_stuck" in m["reason"]["value"],
        timeout=8,
    )


def test_second_client_is_refused(spawn):
    w = spawn()
    w.configure()
    with connect(f"ws://127.0.0.1:{w.port}", compression=None) as other:
        with pytest.raises(ConnectionClosed):
            other.recv(timeout=3)
        assert other.protocol.close_code == 1013


def test_bad_frame_samples_is_refused(spawn):
    w = spawn()
    w.ws.send(json.dumps({**CONFIGURE, "frame_samples": 300}))
    err = w.recv_until(lambda m: m["type"] == "ERROR")
    assert err["code"] == "bad_configure" and err["fatal"] is True
    assert w.proc.wait(5) == 5


def test_reconfigure_resets_stream(spawn):
    w = spawn()
    w.configure()
    stream(w, noise(1, 3200), noise(2, 3200), start=64000)
    w.recv_until(lambda m: m["type"] == "VAP_STATE")
    w.configure(session_id="s_test2")
    mic, sys_ = noise(3, 3200), noise(4, 3200)
    stream(w, mic, sys_)
    state = w.recv_until(lambda m: m["type"] == "VAP_STATE" and m["audio_frame"] < 64000)
    assert state["audio_frame"] == 2560
    assert not [m for m in w.messages if m["type"] == "FRAMES_DROPPED"]


def test_production_entry_does_not_reference_test_double():
    package = ROOT / "maai_worker"
    for path in package.glob("*.py"):
        text = path.read_text("utf-8")
        assert "scripted_engine" not in text and "ScriptedEngine" not in text, path
    assert "tests" not in {p.parent.name for p in package.glob("*.py")}


def test_requirements_cover_the_worker_imports():
    lock = (ROOT / "requirements.lock").read_text("utf-8").lower()
    for name in ("maai==", "numpy==", "websockets==", "jsonschema==", "soundfile==", "scipy==", "torch=="):
        assert name in lock
    assert os.path.exists(ROOT / "compat" / "pyaudio.py")
