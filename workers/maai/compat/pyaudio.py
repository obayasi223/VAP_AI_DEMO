"""MaAI の import を通すためだけの pyaudio スタブ。

maai.input は先頭で pyaudio を import するが、このプロジェクトは Mic() を使わない
（音声はブラウザから来る。仕様§6-2）。本物の PyAudio は portaudio を要するので入れない。
PYTHONPATH に workers/maai/compat を足して使う。

音声デバイスを開こうとすると、黙って無音を返さずに例外を出す。
"""

paFloat32 = 1
paInt16 = 8
paContinue = 0


class PyAudio:
    def __init__(self) -> None:
        raise RuntimeError(
            "pyaudio stub: audio devices are not available. "
            "This project feeds MaAI through process(x1, x2); MaaiInput.Mic() is not supported."
        )
