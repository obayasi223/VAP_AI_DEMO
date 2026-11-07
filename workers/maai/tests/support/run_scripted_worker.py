"""test double のエンジンで本物の RPC サーバーを動かす。Node と pytest の試験が別プロセスで起動する。"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from maai_worker.errors import EXIT_MODEL_LOAD_FAILED, WorkerFatal  # noqa: E402
from maai_worker.server import run_server  # noqa: E402
from maai_worker.settings import DEFAULT_CONFIG_PATH, load_settings  # noqa: E402
from support.scripted_engine import ScriptedEngine  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--delay-ms", type=float, default=0)
    ap.add_argument("--fault")
    ap.add_argument("--fault-after", type=int, default=0)
    ap.add_argument("--fail-load", action="store_true")
    ap.add_argument("--exit-on-stdin-eof", action="store_true")
    args = ap.parse_args()

    def factory(request, _settings):
        if args.fail_load:
            raise WorkerFatal("model_load", "scripted load failure", EXIT_MODEL_LOAD_FAILED)
        return ScriptedEngine(
            samples_per_frame=round(16000 / request.frame_rate_hz),
            delay_s=args.delay_ms / 1000,
            fault=args.fault,
            fault_after=args.fault_after,
        )

    code = run_server(load_settings(DEFAULT_CONFIG_PATH), factory, "127.0.0.1", args.port, args.exit_on_stdin_eof)
    sys.stderr.flush()
    os._exit(code)


if __name__ == "__main__":
    sys.exit(main())
