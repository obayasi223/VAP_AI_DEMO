"""試験専用の test double。音声から p を計算しない（VAD を VAP と呼ぶダミーにしない）。

is_fake=True、model_variant=FAKE_NOT_MAAI を名乗る。本番の入口はこのファイルを参照しない。
周期ごとの x1, x2 の添付は実 MaAI と同じ形にしている（channel_misaligned の検出の試験用）。
"""

from __future__ import annotations

import os
import time

import numpy as np

from maai_worker.engine import EngineInfo


class ScriptedEngine:
    def __init__(
        self,
        samples_per_frame: int = 1280,
        delay_s: float = 0.0,
        skip_first: bool = True,
        fault: str | None = None,
        fault_after: int = 0,
        gate_path: str | None = None,
    ) -> None:
        self.info = EngineInfo(
            maai_version="scripted",
            checkpoint="FAKE_NOT_MAAI",
            model_variant="FAKE_NOT_MAAI",
            samples_per_frame=samples_per_frame,
            is_fake=True,
        )
        self.delay_s = delay_s
        self.skip_first = skip_first
        self.fault = fault
        self.fault_after = fault_after
        # gate_path があれば、そのファイルができるまで process を止める。試験が「処理が進まない間に音声を積む」
        # 状況を時刻や負荷に依存せずに作るため（過負荷の破棄の試験）。
        self.gate_path = gate_path
        self.calls: list[tuple[np.ndarray, np.ndarray]] = []
        self.resets = 0
        self._first = skip_first

    def reset(self) -> None:
        self.resets += 1
        self._first = self.skip_first

    def process(self, x1, x2):
        self.calls.append((x1.copy(), x2.copy()))
        while self.gate_path is not None and not os.path.exists(self.gate_path):
            time.sleep(0.005)
        if self.delay_s:
            time.sleep(self.delay_s)
        if self._first:
            self._first = False
            return []
        out = {
            "t": time.time(),
            "x1": x1.copy(),
            "x2": x2.copy(),
            "p_now": [0.25, 0.75],
            "p_future": [0.5, 0.5],
            "vad": [0.9, 0.1],
        }
        if self.fault and len(self.calls) > self.fault_after:
            if self.fault == "swap_channels":
                out["x1"], out["x2"] = out["x2"], out["x1"]
            elif self.fault == "nan":
                out["p_now"] = [float("nan"), 0.5]
            elif self.fault == "raise":
                raise ValueError("scripted process failure")
            elif self.fault == "two_results":
                return [out, out]
            elif self.fault == "hang":
                time.sleep(3600)
        return [out]
