"""WAV リプレイ（計画 §4.9、「VAP は WAV から再計算」）。

既知の音声を実 MaAI に流し、VAP_STATE を JSONL に記録する。本番と同じ pipeline と processor を通り、
既定は as-fast-as-possible で破棄なし。--realtime では本番と同じ滞留の上限で破棄が起きる。

  python -m maai_worker.replay --stereo mix.wav --out vap.jsonl
  python -m maai_worker.replay --mic user.wav --sys ai.wav --out vap.jsonl --resample

出力の1行目は REPLAY_META、最後は REPLAY_SUMMARY、間は maai_rpc.worker_to_node のメッセージ。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Callable

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from contract import validate  # noqa: E402

from .engine import EngineRequest, VapEngine, load_real_engine  # noqa: E402
from .pipeline import AudioPipeline  # noqa: E402
from .processor import VapProcessor  # noqa: E402
from .settings import DEFAULT_CONFIG_PATH, WorkerSettings, load_settings  # noqa: E402

SAMPLE_RATE_HZ = 16000
REPO_ROOT = ROOT.parents[1]
DEFAULT_POLICY = REPO_ROOT / "config" / "policy.ja.json"
WORKER_TO_NODE = "maai_rpc.worker_to_node"
# 他のプロセスがこれだけ以上のコアを使っていたら、RTF を性能の値として扱わない。
CONTENTION_OTHER_CORES = 0.5


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _read_wav(path: Path, resample: bool) -> tuple[np.ndarray, dict]:
    """(n, channels) の int16 と記録用の情報。"""
    import soundfile as sf

    data, rate = sf.read(str(path), dtype="int16", always_2d=True)
    info = {"path": str(path), "sha256": _sha256(path), "sample_rate_hz": rate, "channels": data.shape[1]}
    if rate != SAMPLE_RATE_HZ:
        if not resample:
            raise SystemExit(f"{path}: {rate} Hz, expected {SAMPLE_RATE_HZ}. Pass --resample to convert explicitly.")
        from math import gcd

        from scipy.signal import resample_poly

        g = gcd(rate, SAMPLE_RATE_HZ)
        converted = resample_poly(data.astype(np.float64), SAMPLE_RATE_HZ // g, rate // g, axis=0)
        data = np.clip(np.round(converted), -32768, 32767).astype(np.int16)
        info["resampled_with"] = "scipy.signal.resample_poly"
    return data, info


def load_channels(args) -> tuple[np.ndarray, np.ndarray, dict]:
    sources: dict = {}
    if args.stereo:
        data, info = _read_wav(Path(args.stereo), args.resample)
        if data.shape[1] != 2:
            raise SystemExit(f"{args.stereo}: {data.shape[1]} channels, expected 2")
        sources["stereo"] = info
        mic, sys_ = data[:, 0], data[:, 1]
    else:
        if not args.mic:
            raise SystemExit("--stereo or --mic is required")
        mic_data, sources["mic"] = _read_wav(Path(args.mic), args.resample)
        mic = mic_data[:, 0]
        if args.sys_silence:
            sys_ = np.zeros_like(mic)
            sources["sys"] = {"silence": True}
        elif args.sys:
            sys_data, sources["sys"] = _read_wav(Path(args.sys), args.resample)
            sys_ = sys_data[:, 0]
        else:
            raise SystemExit("--sys or --sys-silence is required with --mic")
    n = max(len(mic), len(sys_))
    sources["padded_samples"] = {"mic": n - len(mic), "sys": n - len(sys_)}
    mic = np.pad(mic, (0, n - len(mic)))
    sys_ = np.pad(sys_, (0, n - len(sys_)))
    return mic.astype(np.int16), sys_.astype(np.int16), sources


def _cpu_jiffies() -> tuple[int, int]:
    values = list(map(int, Path("/proc/stat").read_text().splitlines()[0].split()[1:]))
    return values[3] + values[4], sum(values)


class ContentionMeter:
    """測定の間の、自分以外のプロセスの CPU 使用量を記録する。"""

    def __init__(self) -> None:
        self.cores = os.cpu_count() or 1
        self._jiffies = _cpu_jiffies()
        self._own = time.process_time()
        self._wall = time.monotonic()

    def result(self) -> dict:
        idle0, total0 = self._jiffies
        idle1, total1 = _cpu_jiffies()
        total = total1 - total0
        busy = (1 - (idle1 - idle0) / total) * self.cores if total else 0.0
        wall = time.monotonic() - self._wall
        own = (time.process_time() - self._own) / wall if wall else 0.0
        other = max(0.0, busy - own)
        return {
            "wall_s": round(wall, 2),
            "cpu_count": self.cores,
            "busy_cores_all_processes": round(busy, 2),
            "own_cores": round(own, 2),
            "other_process_cores": round(other, 2),
            "contended": other >= CONTENTION_OTHER_CORES,
            "contended_threshold_other_cores": CONTENTION_OTHER_CORES,
            "loadavg_end": list(os.getloadavg()),
        }


def run_replay(
    engine: VapEngine,
    request: EngineRequest,
    settings: WorkerSettings,
    speaking_threshold: float,
    mic: np.ndarray,
    sys_: np.ndarray,
    write: Callable[[dict], None],
    frame_samples: int,
    start_audio_frame: int = 0,
    realtime: bool = False,
) -> dict:
    """本番と同じ部品で流す。返り値は REPLAY_SUMMARY。"""
    spf = engine.info.samples_per_frame
    backlog = int(settings.runtime.max_backlog_ms * SAMPLE_RATE_HZ / 1000) if realtime else None
    pipeline = AudioPipeline(spf, backlog, int(settings.runtime.max_zero_fill_ms * SAMPLE_RATE_HZ / 1000))
    processor = VapProcessor(
        engine, request, speaking_threshold, settings.runtime.rtf_window, settings.runtime.max_consecutive_process_failures
    )
    rtf: list[float] = []
    meter = ContentionMeter()
    t0 = time.monotonic()

    def emit(message: dict) -> None:
        validate(WORKER_TO_NODE, message)
        write(message)

    def process_one() -> bool:
        period = pipeline.take_period(0)
        if period is None:
            return False
        message = processor.run_period(period)
        if message is not None:
            if message["type"] == "VAP_STATE":
                rtf.append(message["inference_ms"] / processor.period_ms)
            emit(message)
        return True

    n = len(mic) - len(mic) % frame_samples
    i = 0
    while i < n:
        if realtime:
            # 到着は音声時刻に従う。process の間に届いた分はまとめて入り、本番と同じく滞留になる。
            elapsed = time.monotonic() - t0
            due = min(n, int(elapsed * SAMPLE_RATE_HZ) // frame_samples * frame_samples)
            if due <= i:
                time.sleep(max(0.0, (i + frame_samples) / SAMPLE_RATE_HZ - elapsed))
                continue
        else:
            due = i + frame_samples
        while i < due:
            for message in pipeline.ingest(start_audio_frame + i, mic[i : i + frame_samples], sys_[i : i + frame_samples]):
                emit(message)
            i += frame_samples
        if realtime:
            process_one()
        else:
            while process_one():
                pass
    while process_one():
        pass
    snap = pipeline.snapshot()
    values = np.asarray(rtf) if rtf else np.zeros(0)
    return {
        "type": "REPLAY_SUMMARY",
        "audio_s": n / SAMPLE_RATE_HZ,
        "vap_states": len(rtf),
        "frames_dropped_network": snap.dropped_network,
        "frames_dropped_overload": snap.dropped_overload,
        "process_resets": processor.process_resets,
        "tail_samples_unprocessed": len(mic) - n + snap.pending_samples,
        "rtf": {
            "p50": float(np.percentile(values, 50)),
            "p95": float(np.percentile(values, 95)),
            "p99": float(np.percentile(values, 99)),
            "max": float(values.max()),
        }
        if len(values)
        else None,
        "contention": meter.result(),
    }


def main() -> int:
    ap = argparse.ArgumentParser(prog="maai_worker.replay", description=__doc__)
    ap.add_argument("--stereo", help="ch0=mic, ch1=sys の WAV")
    ap.add_argument("--mic")
    ap.add_argument("--sys")
    ap.add_argument("--sys-silence", action="store_true", help="sys を無音にする（明示）")
    ap.add_argument("--resample", action="store_true", help="16kHz 以外を明示的に変換する")
    ap.add_argument("--out", required=True)
    ap.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    ap.add_argument("--policy", default=str(DEFAULT_POLICY), help="vap.speaking_threshold と channel_layout の出所")
    ap.add_argument("--lang")
    ap.add_argument("--model-type")
    ap.add_argument("--frame-rate-hz", type=float)
    ap.add_argument("--start-audio-frame", type=int, default=0)
    ap.add_argument("--realtime", action="store_true", help="実時間で投入し、本番と同じ滞留の上限で破棄する")
    args = ap.parse_args()

    settings = load_settings(args.config)
    defaults = settings.session_defaults
    vap_policy = json.loads(Path(args.policy).read_text("utf-8"))["vap"]
    request = EngineRequest(
        lang=args.lang or defaults.lang,
        model_type=args.model_type or defaults.model_type,
        frame_rate_hz=args.frame_rate_hz or defaults.frame_rate_hz,
        channel_layout=vap_policy["channel_layout"],
    )
    mic, sys_, sources = load_channels(args)

    # MaAI の print を出力の外へ。
    real_stdout, sys.stdout = sys.stdout, sys.stderr
    t_load = time.monotonic()
    engine = load_real_engine(request, settings.engine)
    load_s = time.monotonic() - t_load

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:

        def write(obj: dict) -> None:
            f.write(json.dumps(obj, ensure_ascii=False, allow_nan=False) + "\n")

        write(
            {
                "type": "REPLAY_META",
                "is_fake": engine.info.is_fake,
                "maai_version": engine.info.maai_version,
                "checkpoint": engine.info.checkpoint,
                "mimi_revision": engine.info.mimi_revision,
                "model_variant": engine.info.model_variant,
                "samples_per_frame": engine.info.samples_per_frame,
                "request": request.__dict__,
                "engine_settings": settings.engine.__dict__,
                "config_status": settings.status,
                "speaking_threshold": vap_policy["speaking_threshold"],
                "policy_file": args.policy,
                "sources": sources,
                "realtime": args.realtime,
                "load_s": round(load_s, 2),
            }
        )
        summary = run_replay(
            engine,
            request,
            settings,
            vap_policy["speaking_threshold"],
            mic,
            sys_,
            write,
            defaults.frame_samples,
            args.start_audio_frame,
            args.realtime,
        )
        write(summary)
    print(json.dumps(summary, ensure_ascii=False), file=real_stdout, flush=True)
    sys.stderr.flush()
    real_stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main())
