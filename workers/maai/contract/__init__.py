"""TS の契約（packages/contracts）の Python 側。B の MaAI ワーカーが使う。"""

from .frames import (
    AudioFrame,
    FrameError,
    PcmFrame,
    decode_audio_frame,
    decode_pcm_frame,
    encode_audio_frame,
    encode_pcm_frame,
)
from .validator import ContractViolation, SCHEMA_NAMES, is_valid, validate

__all__ = [
    "AudioFrame",
    "ContractViolation",
    "FrameError",
    "PcmFrame",
    "SCHEMA_NAMES",
    "decode_audio_frame",
    "decode_pcm_frame",
    "encode_audio_frame",
    "encode_pcm_frame",
    "is_valid",
    "validate",
]
