"""R2 検証プローブの共通部品。

- `pyaudio` / `pygame` をスタブしてから maai を import する（Mic() は使わない。仕様§6-2）。
- `DirectRunner`: `start()` を使わず 1 スレッドで `Maai.process(x1, x2)` を呼び、
  結果を入力サンプル番号と対応づける。
- 素材: 公式 MaAI リポジトリの `example/wav_sample`（環境変数 MAAI_SAMPLE_DIR で指定）。
  素材はリポジトリに含めない。
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import queue
import resource
import sys
import time
import types
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

PROBES_DIR = Path(__file__).resolve().parent
RESULTS_DIR = PROBES_DIR / "results"
REPO_ROOT = PROBES_DIR.parents[2]
SCHEMA_PATH = REPO_ROOT / "docs" / "maai_output_schema.json"
SR = 16000
CHUNK_20MS = 320

_DEFAULT_SAMPLE_DIR = Path(
    "/tmp/claude-1000/-home-yuuto-projects-LLM-VAP-DEMO/"
    "decdc084-3db4-4dd0-b832-ab2a19777949/scratchpad/maai/MaAI/example/wav_sample"
)


def sample_dir() -> Path:
    return Path(os.environ.get("MAAI_SAMPLE_DIR", _DEFAULT_SAMPLE_DIR))


def import_maai():
    """pyaudio（要 portaudio）と GUI 依存をスタブして maai を返す。"""
    sys.modules.setdefault(
        "pyaudio",
        types.SimpleNamespace(PyAudio=None, paFloat32=1, paInt16=8, paContinue=0),
    )
    try:
        import pygame  # noqa: F401
    except Exception:
        sys.modules["pygame"] = types.ModuleType("pygame")
    import maai

    return maai


def load_wav(name: str) -> np.ndarray:
    """16kHz の float32 を返す。モノラルは (n,)、ステレオは (n, 2)。"""
    import soundfile as sf

    a, sr = sf.read(str(sample_dir() / name), dtype="float32")
    if sr != SR:
        raise ValueError(f"{name}: {sr} Hz, expected {SR}")
    return a


def rms_db(x: np.ndarray, hop: int) -> np.ndarray:
    n = len(x) // hop
    if n == 0:
        return np.empty(0)
    return 20 * np.log10(np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(1)) + 1e-9)


def to_jsonable(o):
    if isinstance(o, dict):
        return {k: to_jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [to_jsonable(v) for v in o]
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, np.generic):
        return o.item()
    return o


def save_result(name: str, obj) -> Path:
    RESULTS_DIR.mkdir(exist_ok=True)
    p = RESULTS_DIR / name
    p.write_text(json.dumps(to_jsonable(obj), ensure_ascii=False, indent=1) + "\n")
    return p


def rss_mb() -> float:
    with open("/proc/self/statm") as f:
        return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1e6


def peak_rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def system_cpu() -> tuple[int, int]:
    """/proc/stat の (idle, total) ジフィー。"""
    v = list(map(int, open("/proc/stat").readline().split()[1:]))
    return v[3] + v[4], sum(v)


def system_busy_cores(start: tuple[int, int], end: tuple[int, int]) -> float:
    """start から end の間の全プロセス合計の使用コア数。他レーンの負荷の記録に使う。"""
    idle, total = end[0] - start[0], end[1] - start[1]
    return round((1 - idle / total) * (os.cpu_count() or 1), 2) if total else 0.0


def pct(a, q) -> float:
    return float(np.percentile(np.asarray(a, dtype=float), q))


@dataclass
class Frame:
    """1 結果。end_sample は「その結果までに process へ渡したサンプル数」。"""

    end_sample: int
    p_now: object
    p_future: object
    vad: object
    raw: dict = field(repr=False, default_factory=dict)


class DirectRunner:
    """1 スレッドで process() を直接呼ぶ最小の実行器（§3.3 の方式の検証用）。"""

    def __init__(
        self,
        lang="jp_kyoto",
        model_type="normal-ver2",
        frame_rate=12.5,
        mc=True,
        mono=False,
        torch_threads=None,
        keep_raw=False,
        **kw,
    ):
        maai = import_maai()
        import torch

        if torch_threads:
            torch.set_num_threads(int(torch_threads))
        self.keep_raw = keep_raw
        c1 = maai.MaaiInput.Chunk()
        args = dict(
            mode="vap",
            lang=lang,
            frame_rate=frame_rate,
            audio_ch1=c1,
            device="cpu",
            model_type=model_type,
            mc=mc,
        )
        if not mono:
            # start() しない Chunk は単なる未使用の入れ物。process() には影響しない。
            args["audio_ch2"] = maai.MaaiInput.Chunk()
        args.update(kw)
        self._sink = io.StringIO()
        t = time.perf_counter()
        with contextlib.redirect_stdout(self._sink):
            self.m = maai.Maai(**args)
        self.load_s = time.perf_counter() - t
        self.samples_per_frame = self.m.audio_samples_per_frame
        self.fed = 0
        self.config = dict(
            lang=lang,
            model_type=model_type,
            frame_rate=frame_rate,
            mc_requested=mc,
            variant=self.m.variant,
        )

    def reset(self):
        self.m.reset_runtime_state()
        self.fed = 0

    def feed(self, x1: np.ndarray, x2: np.ndarray) -> list[Frame]:
        """同じ長さの x1, x2 を 1 回渡し、この呼び出しで出た結果を返す。"""
        self._sink.seek(0)
        self._sink.truncate()
        # process() は 101 フレームごとに stdout へ性能行を print する。
        with contextlib.redirect_stdout(self._sink):
            self.m.process(x1, x2)
        self.fed += len(x1)
        out = []
        while True:
            try:
                r = self.m.result_dict_queue.get_nowait()
            except queue.Empty:
                return out
            out.append(
                Frame(self.fed, r["p_now"], r["p_future"], r["vad"], r if self.keep_raw else {})
            )

    def run(self, a: np.ndarray, chunk=CHUNK_20MS) -> list[Frame]:
        """(n, 2) を as-fast-as-possible で流す。"""
        out = []
        for i in range(0, len(a) - chunk + 1, chunk):
            out.extend(self.feed(a[i : i + chunk, 0], a[i : i + chunk, 1]))
        return out


def arr(frames: list[Frame], key: str) -> np.ndarray:
    return np.asarray([getattr(f, key) for f in frames], dtype=float)


def frame_times(frames: list[Frame]) -> np.ndarray:
    return np.asarray([f.end_sample for f in frames], dtype=float) / SR
