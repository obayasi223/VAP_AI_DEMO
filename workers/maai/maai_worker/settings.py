"""worker_config.json の読み込み。既定値をコードに持たず、欠けていれば起動を止める。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[1] / "worker_config.json"


@dataclass(frozen=True)
class EngineSettings:
    mc: bool
    torch_threads: int | None
    mimi_onnx_cpu_intra_threads: int | None
    mimi_onnx_cpu_inter_threads: int | None
    mimi_onnx_precision: str
    context_len_sec: int
    mimi_onnx_repo: str
    mimi_onnx_revision: str


@dataclass(frozen=True)
class RuntimeSettings:
    max_backlog_ms: float
    max_zero_fill_ms: float
    max_consecutive_process_failures: int
    status_interval_ms: float
    degraded_hold_ms: float
    process_stuck_ms: float
    rtf_window: int


@dataclass(frozen=True)
class SessionDefaults:
    lang: str
    model_type: str
    frame_rate_hz: float
    frame_samples: int
    device: str


@dataclass(frozen=True)
class WorkerSettings:
    status: str
    session_defaults: SessionDefaults
    engine: EngineSettings
    runtime: RuntimeSettings


def load_settings(path: Path | str = DEFAULT_CONFIG_PATH) -> WorkerSettings:
    data = json.loads(Path(path).read_text("utf-8"))
    return WorkerSettings(
        status=data["status"],
        session_defaults=SessionDefaults(**data["session_defaults"]),
        engine=EngineSettings(**data["engine"]),
        runtime=RuntimeSettings(**data["runtime"]),
    )
