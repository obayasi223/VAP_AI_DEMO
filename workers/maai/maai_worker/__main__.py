"""本番の入口: python -m maai_worker --port 8788"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from .engine import load_real_engine  # noqa: E402
from .errors import EXIT_USAGE  # noqa: E402
from .server import run_server  # noqa: E402
from .settings import DEFAULT_CONFIG_PATH, load_settings  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(prog="maai_worker")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, required=True, help="0 は空きポート。実際の番号は stdout の JSON で告知する")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    ap.add_argument("--exit-on-stdin-eof", action="store_true")
    args = ap.parse_args()
    if args.host not in ("127.0.0.1", "::1", "localhost"):
        print("maai_worker listens on loopback only (no authentication)", file=sys.stderr)
        return EXIT_USAGE
    settings = load_settings(args.config)
    code = run_server(
        settings,
        lambda request, s: load_real_engine(request, s.engine),
        args.host,
        args.port,
        args.exit_on_stdin_eof,
    )
    sys.stderr.flush()
    # torch と onnxruntime のデストラクタを待たない。状態は終了前に送信済み。
    os._exit(code)


if __name__ == "__main__":
    sys.exit(main())
