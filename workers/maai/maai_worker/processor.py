"""1周期を process へ渡し、結果を VAP_STATE へ正規化する。サーバーとリプレイで共通。"""

from __future__ import annotations

import math
import time
import zlib
from collections import deque

import numpy as np

from .engine import EngineRequest, VapEngine
from .errors import WorkerFatal
from .pipeline import Period

_AUDIO_KEYS = ("x1", "x2")
# float32 の丸めで 1 をわずかに超える値だけを許す。それ以上は異常として止める。
_PROBABILITY_EPS = 1e-5


def _to_jsonable(value):
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    if hasattr(value, "tolist"):
        return _to_jsonable(value.tolist())
    if isinstance(value, float) and not math.isfinite(value):
        raise WorkerFatal("non_finite_output", "MaAI returned a non-finite value")
    return value


def _probability(name: str, value) -> float:
    v = float(value)
    if not math.isfinite(v):
        raise WorkerFatal("non_finite_output", f"{name} is {v}")
    if v < -_PROBABILITY_EPS or v > 1 + _PROBABILITY_EPS:
        raise WorkerFatal("output_out_of_range", f"{name} is {v}")
    return min(1.0, max(0.0, v))


def _pair(name: str, value) -> list[float]:
    values = np.asarray(value, dtype=float).ravel()
    if values.size != 2:
        raise WorkerFatal("unexpected_output_shape", f"{name} has {values.size} values, expected 2")
    return [_probability(f"{name}[{i}]", values[i]) for i in range(2)]


def _scalar(name: str, value) -> float:
    values = np.asarray(value, dtype=float).ravel()
    if values.size != 1:
        raise WorkerFatal("unexpected_output_shape", f"{name} has {values.size} values, expected 1")
    return _probability(name, values[0])


def _peak(samples: np.ndarray) -> int:
    return int(np.abs(samples.astype(np.int32)).max()) if len(samples) else 0


def input_digest(period: Period) -> dict:
    """process へ渡した音声の CRC。外から見て、どのサンプルが入ったかをチャネルごとに検証できる。"""
    mic_peak, sys_peak = _peak(period.mic), _peak(period.sys)
    return {
        "from_audio_frame": period.start,
        "x1_crc32": zlib.crc32(period.mic.astype("<i2").tobytes()),
        "x2_crc32": zlib.crc32(period.sys.astype("<i2").tobytes()),
        # デジタルゼロと微小ノイズで p_now[1] が変わる（docs/maai_validation.md）。入力は加工せず、性質を残す。
        "x1_peak": mic_peak,
        "x2_peak": sys_peak,
        "x1_digital_zero": mic_peak == 0,
        "x2_digital_zero": sys_peak == 0,
    }


def normalize_vap_state(
    result: dict,
    *,
    period: Period,
    request: EngineRequest,
    model_variant: str,
    speaking_threshold: float,
    inference_ms: float,
    t_ms: float,
) -> dict:
    raw = {k: _to_jsonable(v) for k, v in result.items() if k not in _AUDIO_KEYS}
    raw["worker_input"] = input_digest(period)
    common = {
        "type": "VAP_STATE",
        "t": t_ms,
        "audio_frame": period.end,
        "model_variant": model_variant,
        "inference_ms": inference_ms,
        "raw": raw,
    }
    if request.channel_layout == "2ch":
        vad = _pair("vad", result["vad"])
        return {
            **common,
            "channel_layout": "2ch",
            "p_now": _pair("p_now", result["p_now"]),
            "p_future": _pair("p_future", result["p_future"]),
            "vad": vad,
            "user_speaking": vad[0] >= speaking_threshold,
            "system_speaking": vad[1] >= speaking_threshold,
        }
    vad = _scalar("vad", result["vad"])
    return {
        **common,
        "channel_layout": "1ch",
        "p_now": _scalar("p_now", result["p_now"]),
        "p_future": _scalar("p_future", result["p_future"]),
        "vad": vad,
        "user_speaking": vad >= speaking_threshold,
        "system_speaking": {"value": None, "null_reason": "not_observable_in_1ch"},
    }


def check_channel_alignment(result: dict, x1: np.ndarray, x2: np.ndarray) -> None:
    """MaAI が結果に添える x1, x2 が、渡した音声とチャネルごとに一致することを確かめる。"""
    for name, sent in (("x1", x1), ("x2", x2)):
        if not np.array_equal(np.asarray(result[name]), sent):
            raise WorkerFatal(
                "channel_misaligned",
                f"MaAI result {name} does not match the samples given to process()",
            )


class VapProcessor:
    def __init__(
        self,
        engine: VapEngine,
        request: EngineRequest,
        speaking_threshold: float,
        rtf_window: int,
        max_consecutive_failures: int,
    ) -> None:
        self.engine = engine
        self.request = request
        self.speaking_threshold = speaking_threshold
        self.period_ms = engine.info.samples_per_frame * 1000 / 16000
        self._rtf: deque[float] = deque(maxlen=rtf_window)
        self.results = 0
        self.process_started_at: float | None = None
        self.max_consecutive_failures = max_consecutive_failures
        self._consecutive_failures = 0
        self.process_resets = 0
        self.last_reset_at: float | None = None

    def run_period(self, period: Period) -> dict | None:
        """VAP_STATE、結果なしの None、回復した異常の ERROR のどれかを返す。"""
        if period.mic.dtype != np.int16 or period.sys.dtype != np.int16:
            raise WorkerFatal("bad_model_input", f"expected int16, got {period.mic.dtype}, {period.sys.dtype}")
        if len(period.mic) != len(period.sys):
            raise WorkerFatal("channel_length_mismatch", f"mic {len(period.mic)} != sys {len(period.sys)}")
        x1 = period.mic.astype(np.float32) / 32768.0
        x2 = period.sys.astype(np.float32) / 32768.0
        self.process_started_at = time.monotonic()
        t0 = time.perf_counter()
        try:
            results = self.engine.process(x1, x2)
        except WorkerFatal:
            raise
        except Exception as exc:  # noqa: BLE001
            return self._recover(period, exc)
        finally:
            self.process_started_at = None
        inference_ms = (time.perf_counter() - t0) * 1000
        if not results:
            return None  # 周期ちょうどの投入で結果が無いのは Mimi の最初の出力の破棄だけ
        if len(results) > 1:
            raise WorkerFatal("unexpected_result_count", f"{len(results)} results for one period")
        check_channel_alignment(results[0], x1, x2)
        # 結果が出て初めて回復と見なす（reset 直後の助走で結果のない呼び出しは数えない）。
        self._consecutive_failures = 0
        self._rtf.append(inference_ms / self.period_ms)
        self.results += 1
        return normalize_vap_state(
            results[0],
            period=period,
            request=self.request,
            model_variant=self.engine.info.model_variant,
            speaking_threshold=self.speaking_threshold,
            inference_ms=inference_ms,
            t_ms=time.monotonic() * 1000,
        )

    def _recover(self, period: Period, exc: Exception) -> dict:
        """例外の後の MaAI は次の呼び出しも失敗する。reset_runtime_state で戻す。続くなら諦める。"""
        detail = f"{type(exc).__name__}: {str(exc)[:400]}"
        self._consecutive_failures += 1
        if self._consecutive_failures >= self.max_consecutive_failures:
            raise WorkerFatal("process_failed", detail) from exc
        self.engine.reset()
        self.process_resets += 1
        self.last_reset_at = time.monotonic()
        return {
            "type": "ERROR",
            "code": "process_failed_reset",
            "message": f"period at {period.start} lost, model state reset: {detail}",
            "fatal": False,
        }

    def recent_rtf_p95(self) -> float | None:
        """WORKER_STATUS の rtf。直近の窓の p95（関門 G0 と同じ見方）。"""
        if not self._rtf:
            return None
        return float(np.percentile(np.fromiter(self._rtf, dtype=float), 95))
