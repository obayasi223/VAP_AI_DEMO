"""Node↔Python の RPC サーバー（packages/contracts/src/maai_rpc.ts）。

スレッドは2本。asyncio のスレッドが WS と状態報告を持ち、EngineThread だけがモデルの読み込みと
process を呼ぶ。Node が先に接続してから CONFIGURE を送るので、待ち受けは読み込みより先に始める。
"""

from __future__ import annotations

import asyncio
import json
import queue
import signal
import sys
import threading
import time
import traceback
from dataclasses import dataclass
from typing import Callable

import numpy as np
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from contract import ContractViolation, FrameError, decode_audio_frame, validate

from .engine import EngineRequest, VapEngine
from .errors import EXIT_BIND_FAILED, EXIT_OK, EXIT_RUNTIME_FATAL, WorkerFatal
from .pipeline import AudioPipeline
from .processor import VapProcessor
from .settings import WorkerSettings

PROTOCOL_VERSION = 1
SAMPLE_RATE_HZ = 16000
WORKER_TO_NODE = "maai_rpc.worker_to_node"
NODE_TO_WORKER = "maai_rpc.node_to_worker"

EngineFactory = Callable[[EngineRequest, WorkerSettings], VapEngine]


def present(value):
    return {"value": value}


def absent(reason: str):
    return {"value": None, "null_reason": reason}


@dataclass(frozen=True)
class _Session:
    generation: int
    pipeline: AudioPipeline
    processor: VapProcessor
    frame_samples: int


class WorkerServer:
    def __init__(self, settings: WorkerSettings, engine_factory: EngineFactory, stdout) -> None:
        self.settings = settings
        self.engine_factory = engine_factory
        self.stdout = stdout
        self.exit_code = EXIT_OK
        self._loop: asyncio.AbstractEventLoop | None = None
        self._exit = None
        self._outbox: asyncio.Queue[str | None] | None = None
        self._client: ServerConnection | None = None
        self._generation = 0
        self._session: _Session | None = None
        self._state = "loading"
        self._reason: str | None = "waiting_for_configure"
        self._commands: queue.Queue = queue.Queue()
        self._engine: VapEngine | None = None
        self._engine_key: tuple | None = None
        self._audio_refused_notified = False
        self._late_seen = 0
        self._late_notified_at = 0.0
        self._thread = threading.Thread(target=self._engine_thread, name="maai-engine", daemon=True)

    # ---- 送信 ---------------------------------------------------------------

    def _send_from_loop(self, message: dict) -> None:
        validate(WORKER_TO_NODE, message)
        if self._outbox is not None:
            self._outbox.put_nowait(json.dumps(message, ensure_ascii=False, allow_nan=False))

    def _send_from_thread(self, message: dict, generation: int | None = None) -> None:
        validate(WORKER_TO_NODE, message)
        text = json.dumps(message, ensure_ascii=False, allow_nan=False)

        def deliver() -> None:
            if generation is not None and generation != self._generation:
                return  # 終わったセッションの結果を次の接続へ流さない
            if self._outbox is not None:
                self._outbox.put_nowait(text)

        self._loop.call_soon_threadsafe(deliver)

    def _status(self, status: str | None = None, reason: str | None = None) -> dict:
        session = self._session
        status = status or self._state
        reason = reason if reason is not None else self._reason
        snap = session.pipeline.snapshot() if session else None
        rtf = session.processor.recent_rtf_p95() if session else None
        return {
            "type": "WORKER_STATUS",
            "status": status,
            "reason": present(reason) if reason else absent("healthy"),
            "audio_frame": snap.head_audio_frame if snap else 0,
            "frames_dropped_network": snap.dropped_network if snap else 0,
            "frames_dropped_overload": snap.dropped_overload if snap else 0,
            "queue_depth": snap.pending_samples // session.frame_samples if session else 0,
            "rtf": present(rtf) if rtf is not None else absent("no_results_yet"),
        }

    def _health(self) -> tuple[str, str | None]:
        """ready の間の ok と degraded の判定。"""
        session = self._session
        if self._state != "ok" or session is None:
            return self._state, self._reason
        rt = self.settings.runtime
        now = time.monotonic()
        snap = session.pipeline.snapshot()
        hold = rt.degraded_hold_ms / 1000
        reasons = []
        started = session.processor.process_started_at
        if started is not None and (now - started) * 1000 > rt.process_stuck_ms:
            reasons.append("process_stuck")
        if snap.last_overload_at is not None and now - snap.last_overload_at < hold:
            reasons.append("recent_overload_drop")
        if snap.last_network_gap_at is not None and now - snap.last_network_gap_at < hold:
            reasons.append("recent_network_gap")
        if snap.last_late_at is not None and now - snap.last_late_at < hold:
            reasons.append("late_audio_frames")
        last_reset = session.processor.last_reset_at
        if last_reset is not None and now - last_reset < hold:
            reasons.append("recent_process_reset")
        rtf = session.processor.recent_rtf_p95()
        if rtf is not None and rtf > 1.0:
            reasons.append("rtf_above_1")
        return ("degraded", ",".join(reasons)) if reasons else ("ok", None)

    # ---- 致命的な異常と終了 --------------------------------------------------

    def _fatal_from_thread(self, exc: WorkerFatal) -> None:
        print(f"[maai_worker] fatal {exc.code}: {exc}", file=sys.stderr, flush=True)
        self._loop.call_soon_threadsafe(self._fatal, exc.code, str(exc), exc.exit_code)

    def _fatal(self, code: str, message: str, exit_code: int) -> None:
        self.exit_code = exit_code
        self._state = "down"
        self._reason = f"{code}: {message}"[:500]
        self._send_from_loop({"type": "ERROR", "code": code, "message": message, "fatal": True})
        self._send_from_loop(self._status("down", self._reason))
        self._end_session()
        self._exit.set()

    def _end_session(self) -> None:
        self._generation += 1
        session, self._session = self._session, None
        if session is not None:
            session.pipeline.close()

    # ---- EngineThread（process を呼ぶ唯一のスレッド） --------------------------

    def _engine_thread(self) -> None:
        try:
            self._engine_loop()
        except WorkerFatal as exc:
            self._fatal_from_thread(exc)
        except ContractViolation as exc:
            self._fatal_from_thread(WorkerFatal("contract_violation", str(exc)[:500]))
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            self._fatal_from_thread(WorkerFatal("engine_thread_failed", f"{type(exc).__name__}: {exc}"))

    def _engine_loop(self) -> None:
        while True:
            session = self._session
            try:
                command = self._commands.get(timeout=0 if session else 0.01)
            except queue.Empty:
                command = None
            if command == "stop":
                return
            if command is not None:
                self._configure(*command)
                continue
            if session is None:
                continue
            period = session.pipeline.take_period(0.05)
            if period is None:
                continue
            message = session.processor.run_period(period)
            if message is not None:
                self._send_from_thread(message, session.generation)

    def _configure(self, config: dict, generation: int) -> None:
        request = EngineRequest(
            lang=config["lang"],
            model_type=config["model_type"],
            frame_rate_hz=config["frame_rate_hz"],
            channel_layout=config["channel_layout"],
        )
        period_exact = SAMPLE_RATE_HZ / request.frame_rate_hz
        if abs(period_exact - round(period_exact)) > 1e-9:
            raise WorkerFatal("bad_configure", f"frame_rate_hz {request.frame_rate_hz} is not an integer sample period")
        key = (request.lang, request.model_type, request.frame_rate_hz, request.channel_layout)
        if self._engine is None or self._engine_key != key:
            self._engine = None
            self._engine = self.engine_factory(request, self.settings)
            self._engine_key = key
        else:
            self._engine.reset()
        engine = self._engine
        spf = engine.info.samples_per_frame
        if spf != round(period_exact):
            raise WorkerFatal("bad_configure", f"engine period {spf} != requested {round(period_exact)}")
        if spf % config["frame_samples"] != 0:
            raise WorkerFatal("bad_configure", f"frame_samples {config['frame_samples']} does not divide period {spf}")
        rt = self.settings.runtime
        session = _Session(
            generation=generation,
            pipeline=AudioPipeline(
                spf,
                int(rt.max_backlog_ms * SAMPLE_RATE_HZ / 1000),
                int(rt.max_zero_fill_ms * SAMPLE_RATE_HZ / 1000),
            ),
            processor=VapProcessor(
                engine, request, config["speaking_threshold"], rt.rtf_window, rt.max_consecutive_process_failures
            ),
            frame_samples=config["frame_samples"],
        )
        ready = {
            "type": "READY",
            "protocol_version": PROTOCOL_VERSION,
            "maai_version": engine.info.maai_version,
            "checkpoint": engine.info.checkpoint,
            "lang": request.lang,
            "model_type": request.model_type,
            "channel_layout": request.channel_layout,
            "frame_rate_hz": request.frame_rate_hz,
            "device": "cpu",
            "is_fake": engine.info.is_fake,
        }
        validate(WORKER_TO_NODE, ready)
        # READY に項目がない（契約への要望）ので、固定した Mimi の版は stderr に残す。
        print(f"[maai_worker] loaded {engine.info.model_variant} mimi_revision={engine.info.mimi_revision}", file=sys.stderr, flush=True)
        self._loop.call_soon_threadsafe(self._activate, session, ready)

    def _activate(self, session: _Session, ready: dict) -> None:
        if session.generation != self._generation:
            session.pipeline.close()
            return  # 読み込みの間に接続が切れた
        self._session = session
        self._state = "ok"
        self._reason = None
        self._send_from_loop(ready)
        self._send_from_loop(self._status())

    # ---- 受信（asyncio のスレッド） ---------------------------------------------

    def _on_text(self, text: str) -> None:
        try:
            message = json.loads(text)
            validate(NODE_TO_WORKER, message)
        except (ValueError, ContractViolation) as exc:
            self._send_from_loop({"type": "ERROR", "code": "bad_message", "message": str(exc)[:500], "fatal": False})
            return
        kind = message["type"]
        if kind == "PING":
            self._send_from_loop(
                {"type": "PONG", "seq": message["seq"], "t_ms": message["t_ms"], "worker_t_ms": time.monotonic() * 1000}
            )
        elif kind == "CONFIGURE":
            self._end_session()
            self._state = "loading"
            self._reason = "loading_model"
            self._audio_refused_notified = False
            self._late_seen = 0
            self._send_from_loop(self._status())
            self._commands.put((message, self._generation))
        elif kind == "SHUTDOWN":
            self._state = "down"
            self._reason = f"shutdown: {message['reason']}"
            self._send_from_loop(self._status("down", self._reason))
            self._end_session()
            self.exit_code = EXIT_OK
            self._exit.set()

    def _on_binary(self, data: bytes) -> None:
        session = self._session
        if session is None:
            if not self._audio_refused_notified:
                self._audio_refused_notified = True
                self._send_from_loop(
                    {"type": "ERROR", "code": "not_configured", "message": "audio before READY", "fatal": False}
                )
            return
        try:
            frame = decode_audio_frame(data)
        except FrameError as exc:
            self._send_from_loop(
                {"type": "ERROR", "code": f"bad_audio_frame_{exc.code}", "message": str(exc)[:500], "fatal": False}
            )
            return  # 届かなかった番号は次の枠でゼロ埋めになる
        mic = np.frombuffer(frame.mic, dtype=np.int16)
        sys_ = np.frombuffer(frame.sys, dtype=np.int16)
        for message in session.pipeline.ingest(frame.audio_frame, mic, sys_):
            self._send_from_loop(message)
        late = session.pipeline.snapshot().late_samples
        now = time.monotonic()
        if late > self._late_seen and now - self._late_notified_at >= 1.0:
            self._late_seen = late
            self._late_notified_at = now
            self._send_from_loop(
                {
                    "type": "ERROR",
                    "code": "late_audio_frame",
                    "message": f"audio_frame {frame.audio_frame} is behind the stream; {late} samples ignored in total",
                    "fatal": False,
                }
            )

    async def _sender(self, ws: ServerConnection, outbox: asyncio.Queue) -> None:
        while True:
            text = await outbox.get()
            if text is None:
                return
            await ws.send(text)

    async def _status_ticker(self) -> None:
        interval = self.settings.runtime.status_interval_ms / 1000
        while True:
            await asyncio.sleep(interval)
            status, reason = self._health()
            try:
                self._send_from_loop(self._status(status, reason))
            except ContractViolation as exc:
                self._fatal("contract_violation", str(exc)[:500], EXIT_RUNTIME_FATAL)
                return

    async def _handler(self, ws: ServerConnection) -> None:
        if self._client is not None:
            await ws.close(1013, "worker already has a client")
            return
        self._client = ws
        self._outbox = asyncio.Queue()
        sender = asyncio.create_task(self._sender(ws, self._outbox))
        ticker = asyncio.create_task(self._status_ticker())
        self._send_from_loop(self._status())
        try:
            async for data in ws:
                if isinstance(data, bytes):
                    self._on_binary(data)
                else:
                    self._on_text(data)
        except ConnectionClosed:
            pass
        except WorkerFatal as exc:
            self._fatal(exc.code, str(exc), exc.exit_code)
        finally:
            ticker.cancel()
            await self._flush(sender)
            self._outbox = None
            self._client = None
            if not self._exit.is_set():
                self._end_session()
                self._state, self._reason = "loading", "waiting_for_configure"

    async def _flush(self, sender: asyncio.Task) -> None:
        if self._outbox is not None:
            self._outbox.put_nowait(None)
        try:
            await asyncio.wait_for(sender, 2)
        except (ConnectionClosed, asyncio.TimeoutError):
            sender.cancel()

    # ---- 起動 ---------------------------------------------------------------

    def _watch_stdin(self) -> None:
        """親が消えたら終わる（stdin の EOF）。孤児のプロセスがメモリを持ち続けないようにする。"""
        try:
            while sys.stdin.buffer.read(4096):
                pass
        except (OSError, ValueError):
            pass
        self._loop.call_soon_threadsafe(self._request_exit, "parent_exited")

    def _request_exit(self, reason: str) -> None:
        if self._exit.is_set():
            return
        self._state = "down"
        self._reason = reason
        if self._outbox is not None:
            self._send_from_loop(self._status("down", reason))
        self._end_session()
        self._exit.set()

    async def run(self, host: str, port: int, exit_on_stdin_eof: bool) -> int:
        self._loop = asyncio.get_running_loop()
        self._exit = asyncio.Event()
        self._thread.start()
        try:
            server = await serve(self._handler, host, port, compression=None, ping_interval=None, max_size=2**20)
        except OSError as exc:
            print(f"[maai_worker] cannot bind {host}:{port}: {exc}", file=sys.stderr, flush=True)
            return EXIT_BIND_FAILED
        for sig, name in ((signal.SIGTERM, "sigterm"), (signal.SIGINT, "sigint")):
            self._loop.add_signal_handler(sig, self._request_exit, name)
        if exit_on_stdin_eof:
            threading.Thread(target=self._watch_stdin, name="stdin-watch", daemon=True).start()
        actual = server.sockets[0].getsockname()[1]
        print(json.dumps({"event": "listening", "port": actual}), file=self.stdout, flush=True)

        await self._exit.wait()
        self._commands.put("stop")
        client = self._client
        if client is not None:
            # 送信済みの停止通知を流し切ってから閉じる。
            if self._outbox is not None:
                for _ in range(100):
                    if self._outbox.empty():
                        break
                    await asyncio.sleep(0.01)
            try:
                await asyncio.wait_for(client.close(1000, self._reason or "exit"), 2)
            except (asyncio.TimeoutError, ConnectionClosed):
                pass
        server.close()
        return self.exit_code


def run_server(settings: WorkerSettings, engine_factory: EngineFactory, host: str, port: int, exit_on_stdin_eof: bool) -> int:
    """MaAI の print が RPC の告知と混ざらないよう、stdout の実体は告知だけに使う。"""
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    worker = WorkerServer(settings, engine_factory, real_stdout)
    code = asyncio.run(worker.run(host, port, exit_on_stdin_eof))
    return code

