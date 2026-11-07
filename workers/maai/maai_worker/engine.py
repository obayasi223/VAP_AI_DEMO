"""実 MaAI の読み込みと process の呼び出し。

Maai は start() せず、呼び出し側の1スレッドから process(x1, x2) だけを呼ぶ。
チャネルの対応は x1=mic、x2=sys（計画 §4.1）。
"""

from __future__ import annotations

import os
import queue
import sys
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path
from typing import Protocol

import numpy as np

from .errors import EXIT_MODEL_LOAD_FAILED, WorkerFatal
from .settings import EngineSettings

COMPAT_DIR = Path(__file__).resolve().parents[1] / "compat"


@dataclass(frozen=True)
class EngineRequest:
    lang: str
    model_type: str
    frame_rate_hz: float
    channel_layout: str


@dataclass(frozen=True)
class EngineInfo:
    maai_version: str
    checkpoint: str
    model_variant: str
    samples_per_frame: int
    is_fake: bool
    # 固定した Mimi の HF commit。Mimi を使わないモデルでは None。
    mimi_revision: str | None = None


class VapEngine(Protocol):
    info: EngineInfo

    def process(self, x1: np.ndarray, x2: np.ndarray) -> list[dict]:
        """同じ長さの Float32 を渡し、この呼び出しで出た結果を返す。"""
        ...

    def reset(self) -> None: ...


def _prepare_imports() -> None:
    os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
    if str(COMPAT_DIR) not in sys.path:
        sys.path.insert(0, str(COMPAT_DIR))
    import pyaudio

    if Path(pyaudio.__file__).resolve().parent != COMPAT_DIR:
        raise WorkerFatal(
            "model_load",
            f"pyaudio resolved to {pyaudio.__file__}, expected the stub in {COMPAT_DIR}",
            EXIT_MODEL_LOAD_FAILED,
        )


def check_model_input(x1: np.ndarray, x2: np.ndarray) -> None:
    """int16 のまま渡すと MaAI は例外を出さず誤った値を返す（docs/maai_validation.md）。呼ぶ前に止める。"""
    for name, x in (("x1", x1), ("x2", x2)):
        if x.dtype != np.float32 or x.ndim != 1:
            raise WorkerFatal("bad_model_input", f"{name} must be 1-D float32, got {x.dtype} ndim={x.ndim}")
    if len(x1) != len(x2):
        raise WorkerFatal("channel_length_mismatch", f"x1 {len(x1)} != x2 {len(x2)}")


def _pinned_mimi_paths(settings: EngineSettings) -> dict:
    """Mimi を固定の commit から取る。古いキャッシュやリビジョンでは結果が変わりうる（カードの drift 修正）。"""
    from huggingface_hub import hf_hub_download

    stem = f"continuous_mimi_{settings.mimi_onnx_precision}"
    key = settings.mimi_onnx_precision
    fetch = lambda name: hf_hub_download(settings.mimi_onnx_repo, name, revision=settings.mimi_onnx_revision)
    return {
        f"mimi_local_onnx_{key}_path": fetch(f"{stem}.onnx"),
        f"mimi_local_onnx_{key}_meta_path": fetch(f"{stem}.json"),
    }


class RealMaaiEngine:
    def __init__(self, maai_obj, info: EngineInfo) -> None:
        self._m = maai_obj
        self.info = info

    def process(self, x1: np.ndarray, x2: np.ndarray) -> list[dict]:
        check_model_input(x1, x2)
        self._m.process(x1, x2)
        # result_dict_queue は無制限なので呼び出しごとに取り切る。
        out: list[dict] = []
        while True:
            try:
                out.append(self._m.result_dict_queue.get_nowait())
            except queue.Empty:
                return out

    def reset(self) -> None:
        self._m.reset_runtime_state()


def load_real_engine(request: EngineRequest, settings: EngineSettings) -> RealMaaiEngine:
    """失敗は WorkerFatal(model_load)。偽の値へ切り替えない。"""
    try:
        _prepare_imports()
        import maai
        import torch

        if settings.torch_threads:
            torch.set_num_threads(settings.torch_threads)
        args: dict = dict(
            mode="vap",
            lang=request.lang,
            frame_rate=request.frame_rate_hz,
            audio_ch1=maai.MaaiInput.Chunk(),
            device="cpu",
            model_type=request.model_type,
            mc=settings.mc,
            context_len_sec=settings.context_len_sec,
            mimi_onnx_precision=settings.mimi_onnx_precision,
            mimi_onnx_cpu_intra_threads=settings.mimi_onnx_cpu_intra_threads,
            mimi_onnx_cpu_inter_threads=settings.mimi_onnx_cpu_inter_threads,
        )
        uses_mimi = request.model_type == "normal-ver2"
        if uses_mimi:
            args.update(_pinned_mimi_paths(settings))
        if request.channel_layout == "2ch":
            # start() しない Chunk は未使用の入れ物。省略すると単一チャネルのモデルになる。
            args["audio_ch2"] = maai.MaaiInput.Chunk()
        m = maai.Maai(**args)
    except WorkerFatal:
        raise
    except Exception as exc:  # noqa: BLE001 - 原因を問わず起動失敗として明示する
        raise WorkerFatal(
            "model_load", f"{type(exc).__name__}: {str(exc)[:500]}", EXIT_MODEL_LOAD_FAILED
        ) from exc

    is_mono_expected = request.channel_layout == "1ch"
    if bool(m.is_mono) != is_mono_expected:
        raise WorkerFatal(
            "model_load",
            f"loaded {m.variant} but channel_layout is {request.channel_layout}",
            EXIT_MODEL_LOAD_FAILED,
        )
    if bool(m.mc) != bool(settings.mc):
        raise WorkerFatal(
            "model_load",
            f"loaded {m.variant} but mc={settings.mc} was requested",
            EXIT_MODEL_LOAD_FAILED,
        )
    return RealMaaiEngine(
        m,
        EngineInfo(
            maai_version=metadata.version("maai"),
            checkpoint=m.variant,
            model_variant=f"{request.lang}/{request.model_type}/{m.variant}",
            samples_per_frame=int(m.audio_samples_per_frame),
            is_fake=False,
            mimi_revision=settings.mimi_onnx_revision if uses_mimi else None,
        ),
    )
