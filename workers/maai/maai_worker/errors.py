"""ワーカーの続行を諦める異常。"""

from __future__ import annotations

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_BIND_FAILED = 3
EXIT_MODEL_LOAD_FAILED = 4
EXIT_RUNTIME_FATAL = 5


class WorkerFatal(RuntimeError):
    """code は ERROR メッセージの code になる。"""

    def __init__(self, code: str, message: str, exit_code: int = EXIT_RUNTIME_FATAL) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code
