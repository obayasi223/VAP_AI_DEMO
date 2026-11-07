"""バイナリ枠のエンコードとデコード。レイアウトの正本は packages/contracts/src/binary.ts。

バイト列の一致は共通の固定値（fixtures/contract_fixtures.json）で試験している。
numpy へは次のように変換する（MaAI へ渡す直前。計画 §3.3）:
    np.asarray(frame.mic, dtype=np.float32) / 32768.0
"""

from __future__ import annotations

import struct
import sys
from array import array
from dataclasses import dataclass

VERSION = 1
KIND_AUDIO = 1
KIND_PCM = 2
FORMAT_INT16LE = 1
PCM_FLAG_END_OF_STREAM = 0x01

_AUDIO_HEADER = struct.Struct("<BBBBIHH")
_PCM_HEADER = struct.Struct("<BBBBIIIIHH")
_U16_MAX = 0xFFFF


class FrameError(ValueError):
    """code は TS の FrameErrorCode と同じ値。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class AudioFrame:
    audio_frame: int
    sample_count: int
    mic: array
    sys: array


@dataclass(frozen=True)
class PcmFrame:
    audio_playback_id: int
    generation: int
    seq: int
    sample_rate_hz: int
    sample_count: int
    end_of_stream: bool
    pcm: array


def _samples(data: bytes) -> array:
    out = array("h")
    out.frombytes(data)
    if sys.byteorder != "little":
        out.byteswap()
    return out


def _to_bytes(samples) -> bytes:
    out = array("h", samples)
    if sys.byteorder != "little":
        out.byteswap()
    return out.tobytes()


def _check_common(data: bytes, expected_kind: int, min_length: int) -> None:
    if len(data) < 4:
        raise FrameError("too_short", f"frame too short: {len(data)} bytes")
    if data[0] != VERSION:
        raise FrameError("bad_version", f"unsupported frame version {data[0]}")
    if data[1] != expected_kind:
        raise FrameError("bad_kind", f"expected frame kind {expected_kind}, got {data[1]}")
    if data[2] != FORMAT_INT16LE:
        raise FrameError("bad_format", f"unsupported sample format {data[2]}")
    if len(data) < min_length:
        raise FrameError("too_short", f"frame too short: {len(data)} bytes, need {min_length}")


def encode_audio_frame(audio_frame: int, mic, sys_samples) -> bytes:
    if len(mic) != len(sys_samples):
        raise FrameError("bad_field", f"mic and sys length differ ({len(mic)} != {len(sys_samples)})")
    if not 1 <= len(mic) <= _U16_MAX:
        raise FrameError("bad_field", f"sample_count out of range: {len(mic)}")
    if not 0 <= audio_frame <= 0xFFFFFFFF:
        raise FrameError("bad_field", f"audio_frame must be a u32, got {audio_frame}")
    header = _AUDIO_HEADER.pack(VERSION, KIND_AUDIO, FORMAT_INT16LE, 0, audio_frame, len(mic), 0)
    return header + _to_bytes(mic) + _to_bytes(sys_samples)


def decode_audio_frame(data: bytes) -> AudioFrame:
    data = bytes(data)
    _check_common(data, KIND_AUDIO, _AUDIO_HEADER.size)
    _, _, _, _, audio_frame, count, _ = _AUDIO_HEADER.unpack_from(data)
    if count == 0:
        raise FrameError("bad_field", "audio frame with sample_count 0")
    expected = _AUDIO_HEADER.size + count * 4
    if len(data) != expected:
        raise FrameError("bad_length", f"audio frame length {len(data)}, expected {expected}")
    middle = _AUDIO_HEADER.size + count * 2
    return AudioFrame(
        audio_frame=audio_frame,
        sample_count=count,
        mic=_samples(data[_AUDIO_HEADER.size : middle]),
        sys=_samples(data[middle:]),
    )


def encode_pcm_frame(
    audio_playback_id: int,
    generation: int,
    seq: int,
    sample_rate_hz: int,
    pcm,
    end_of_stream: bool = False,
) -> bytes:
    if sample_rate_hz == 0:
        raise FrameError("bad_field", "sample_rate_hz must not be 0")
    minimum = 0 if end_of_stream else 1
    if not minimum <= len(pcm) <= _U16_MAX:
        raise FrameError("bad_field", f"sample_count out of range: {len(pcm)}")
    flags = PCM_FLAG_END_OF_STREAM if end_of_stream else 0
    header = _PCM_HEADER.pack(
        VERSION, KIND_PCM, FORMAT_INT16LE, flags, audio_playback_id, generation, seq,
        sample_rate_hz, len(pcm), 0,
    )
    return header + _to_bytes(pcm)


def decode_pcm_frame(data: bytes) -> PcmFrame:
    data = bytes(data)
    _check_common(data, KIND_PCM, _PCM_HEADER.size)
    _, _, _, flags, playback, generation, seq, rate, count, _ = _PCM_HEADER.unpack_from(data)
    end = bool(flags & PCM_FLAG_END_OF_STREAM)
    if rate == 0:
        raise FrameError("bad_field", "sample_rate_hz must not be 0")
    if count == 0 and not end:
        raise FrameError("bad_field", "pcm frame with sample_count 0 and no end_of_stream")
    expected = _PCM_HEADER.size + count * 2
    if len(data) != expected:
        raise FrameError("bad_length", f"pcm frame length {len(data)}, expected {expected}")
    return PcmFrame(playback, generation, seq, rate, count, end, _samples(data[_PCM_HEADER.size :]))
