"""audio_frame の順序づけ、ゼロ埋め、同時破棄、周期ごとの切り出し（計画 §3.3）。

mic と sys は常に1つの区間に入れて同じ位置で切るので、片方だけ捨てる経路がない。
process へは MaAI の frame 周期ちょうどの長さで渡す。probes/results/direct_process.json で、
周期ちょうどの送信と 320 サンプルずつの送信が同じ結果になることを確認済み。
破棄も周期の倍数に限るので、結果の audio_frame は常に「起点 + 周期の倍数」になる。
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass

import numpy as np

from .errors import WorkerFatal


@dataclass
class _Segment:
    start: int
    count: int
    mic: np.ndarray | None  # None はゼロ埋め（長い欠損でメモリを使わない）
    sys: np.ndarray | None


@dataclass(frozen=True)
class Period:
    start: int
    mic: np.ndarray
    sys: np.ndarray

    @property
    def end(self) -> int:
        return self.start + len(self.mic)


@dataclass(frozen=True)
class PipelineSnapshot:
    head_audio_frame: int
    pending_samples: int
    dropped_network: int
    dropped_overload: int
    late_samples: int
    last_network_gap_at: float | None
    last_overload_at: float | None
    last_late_at: float | None


def frames_dropped(start: int, count: int, cause: str) -> dict:
    return {
        "type": "FRAMES_DROPPED",
        "from_audio_frame": start,
        "sample_count": count,
        "cause": cause,
        "zero_filled": cause == "network_gap",
        "channels": "both",
    }


class AudioPipeline:
    """ingest は受信側のスレッド、take_period は process のスレッドから呼ぶ。"""

    def __init__(
        self,
        samples_per_period: int,
        max_backlog_samples: int | None,
        max_zero_fill_samples: int = 0,
    ) -> None:
        """max_zero_fill_samples までの欠損は滞留に数えず、ゼロ埋めのまま process へ渡す。

        数えると上限を超える欠損がすぐ過負荷の破棄になり、ゼロ埋めの意味がなくなる。超えた分は滞留に数える。
        """
        self.samples_per_period = samples_per_period
        self.max_backlog_samples = max_backlog_samples
        self.max_zero_fill_samples = max_zero_fill_samples
        self._zero_pending = 0
        self._zero_exempt = 0
        self._cond = threading.Condition()
        self._segments: deque[_Segment] = deque()
        self._pending = 0
        self._origin: int | None = None
        self._expected: int | None = None
        self._head = 0
        self._dropped_network = 0
        self._dropped_overload = 0
        self._late = 0
        self._last_gap_at: float | None = None
        self._last_overload_at: float | None = None
        self._last_late_at: float | None = None
        self._closed = False

    def ingest(self, audio_frame: int, mic: np.ndarray, sys: np.ndarray) -> list[dict]:
        """契約のメッセージ（FRAMES_DROPPED）を返す。古い枠の捨て分は late に数える。"""
        if len(mic) != len(sys):
            raise WorkerFatal("channel_length_mismatch", f"mic {len(mic)} != sys {len(sys)}")
        messages: list[dict] = []
        with self._cond:
            if self._closed:
                return messages
            if self._expected is None:
                self._origin = audio_frame
                self._expected = audio_frame
                self._head = audio_frame
            if audio_frame > self._expected:
                gap = audio_frame - self._expected
                self._segments.append(_Segment(self._expected, gap, None, None))
                self._pending += gap
                self._zero_pending += gap
                self._zero_exempt += min(gap, self.max_zero_fill_samples)
                self._zero_exempt = min(self._zero_exempt, self.max_zero_fill_samples)
                self._dropped_network += gap
                self._last_gap_at = time.monotonic()
                messages.append(frames_dropped(self._expected, gap, "network_gap"))
                self._expected = audio_frame
            elif audio_frame < self._expected:
                overlap = self._expected - audio_frame
                self._late += min(overlap, len(mic))
                self._last_late_at = time.monotonic()
                if overlap >= len(mic):
                    return messages
                mic, sys = mic[overlap:], sys[overlap:]
                audio_frame = self._expected
            self._segments.append(_Segment(audio_frame, len(mic), mic, sys))
            self._pending += len(mic)
            self._expected = audio_frame + len(mic)
            overload = self._drop_if_overloaded()
            if overload is not None:
                messages.append(overload)
            self._cond.notify_all()
        return messages

    def _drop_if_overloaded(self) -> dict | None:
        limit = self.max_backlog_samples
        backlog = self._pending - self._zero_exempt
        if limit is None or backlog <= limit:
            return None
        # 次の周期の頭から、周期の倍数だけ捨てる。1周期分の未満を残して滞留を解消する。
        spf = self.samples_per_period
        drop = ((backlog - spf) // spf) * spf
        if drop <= 0:
            return None
        start = self._segments[0].start
        self._carve(drop, keep=False)
        self._head = start + drop
        self._dropped_overload += drop
        self._last_overload_at = time.monotonic()
        return frames_dropped(start, drop, "overload")

    def _carve(self, count: int, keep: bool) -> tuple[list[np.ndarray], list[np.ndarray]]:
        mic_parts: list[np.ndarray] = []
        sys_parts: list[np.ndarray] = []
        need = count
        while need > 0:
            seg = self._segments[0]
            k = min(need, seg.count)
            if seg.mic is None:
                self._zero_pending -= k
                if keep:
                    self._zero_exempt = max(0, self._zero_exempt - k)
            if keep:
                if seg.mic is None:
                    zeros = np.zeros(k, dtype=np.int16)
                    mic_parts.append(zeros)
                    sys_parts.append(zeros)
                else:
                    mic_parts.append(seg.mic[:k])
                    sys_parts.append(seg.sys[:k])
            if k == seg.count:
                self._segments.popleft()
            else:
                seg.start += k
                seg.count -= k
                if seg.mic is not None:
                    seg.mic = seg.mic[k:]
                    seg.sys = seg.sys[k:]
            need -= k
        self._pending -= count
        self._zero_exempt = min(self._zero_exempt, self._zero_pending)
        return mic_parts, sys_parts

    def take_period(self, timeout: float) -> Period | None:
        with self._cond:
            if self._pending < self.samples_per_period and not self._closed:
                self._cond.wait(timeout)
            if self._closed or self._pending < self.samples_per_period:
                return None
            spf = self.samples_per_period
            start = self._segments[0].start
            if (start - self._origin) % spf != 0:
                raise WorkerFatal(
                    "period_misaligned", f"period starts at {start}, origin {self._origin}, period {spf}"
                )
            mic_parts, sys_parts = self._carve(spf, keep=True)
            mic = np.concatenate(mic_parts)
            sys = np.concatenate(sys_parts)
            if len(mic) != spf or len(sys) != spf:
                raise WorkerFatal("channel_length_mismatch", f"carved mic {len(mic)}, sys {len(sys)}")
            self._head = start + spf
            return Period(start, mic, sys)

    def snapshot(self) -> PipelineSnapshot:
        with self._cond:
            return PipelineSnapshot(
                head_audio_frame=self._head,
                pending_samples=self._pending,
                dropped_network=self._dropped_network,
                dropped_overload=self._dropped_overload,
                late_samples=self._late,
                last_network_gap_at=self._last_gap_at,
                last_overload_at=self._last_overload_at,
                last_late_at=self._last_late_at,
            )

    def close(self) -> None:
        with self._cond:
            self._closed = True
            self._cond.notify_all()
