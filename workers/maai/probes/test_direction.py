"""p の向きを既知の音声で固定する試験（§5.1 R2）。

ch1 のみ話す区間では添字 0、ch2 のみ話す区間では添字 1 が優勢になること。
話者を入れ替えても添字はチャネルに従うこと（声質に依存しない）。
"""
import os

import numpy as np
import pytest

from probe_common import DirectRunner, SR, arr, frame_times, load_wav, sample_dir

os.environ.setdefault("HF_HUB_OFFLINE", "1")
pytestmark = pytest.mark.skipif(not (sample_dir() / "jpn_mix_16k.wav").exists(), reason="公式 sample がない")

CONFIGS = [
    dict(lang="jp_kyoto", model_type="normal-ver2", frame_rate=12.5, mc=True),
    dict(lang="jp", model_type="normal-ver2", frame_rate=12.5, mc=True),
]


def timeline(a, b):
    """0-2 無音 / 2-17 a を ch1 / 17-19 無音 / 19-34 b を ch2 / 34-36 無音"""
    x = np.zeros((36 * SR, 2), dtype=np.float32)
    x[2 * SR : 17 * SR, 0] = a[: 15 * SR]
    x[19 * SR : 34 * SR, 1] = b[: 15 * SR]
    return x


def dense(track):
    from probe_direction import densest_window

    s, _ = densest_window(track, 20.0)
    return track[s:]


@pytest.fixture(scope="module", params=CONFIGS, ids=lambda c: c["lang"])
def runner(request):
    try:
        return DirectRunner(**request.param)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"重みがキャッシュにない: {e}")


@pytest.mark.parametrize("swap", [False, True], ids=["inoue_on_ch1", "sumida_on_ch1"])
def test_index_follows_channel(runner, swap):
    a, b = dense(load_wav("jpn_inoue_16k.wav")), dense(load_wav("jpn_sumida_16k.wav"))
    if swap:
        a, b = b, a
    runner.reset()
    fs = runner.run(timeline(a, b))
    t, pn, pf, vd = frame_times(fs), arr(fs, "p_now"), arr(fs, "p_future"), arr(fs, "vad")
    # 切替直後を除く
    c1, c2 = (t > 4) & (t <= 17), (t > 21) & (t <= 34)
    for q in (pn, vd):
        assert q[c1, 0].mean() > q[c1, 1].mean() + 0.3
        assert q[c2, 1].mean() > q[c2, 0].mean() + 0.3
    assert (pn[c1, 0] > 0.5).mean() > 0.8
    assert (pn[c2, 1] > 0.5).mean() > 0.8
    # p_future も同じ向き（差は小さくてよい）
    assert pf[c1, 0].mean() > pf[c1, 1].mean()
    assert pf[c2, 1].mean() > pf[c2, 0].mean()
    # 2ch の p は話者間で正規化される
    assert np.abs(pn.sum(1) - 1).max() < 1e-4
    assert np.abs(pf.sum(1) - 1).max() < 1e-4


def test_result_audio_echo_is_input_channel(runner):
    """result の x1/x2 が入力の ch1/ch2 のままであること（入れ替わりがない）。"""
    r = DirectRunner(keep_raw=True, **{k: runner.config[k] for k in ("lang", "model_type", "frame_rate")})
    a = load_wav("jpn_mix_16k.wav")[: 5 * SR]
    for f in r.run(a):
        s = f.end_sample - r.samples_per_frame
        assert np.array_equal(f.raw["x1"], a[s : f.end_sample, 0])
        assert np.array_equal(f.raw["x2"], a[s : f.end_sample, 1])
