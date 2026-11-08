/**
 * 実機の対話の抜き出しに、VAP が使えない区間（助走、鮮度切れの近似）を重ねて再生する回帰試験（docs/known_gaps.md §12）。
 * fixtures に mic のエネルギーがないので、エネルギーは vad[0] から作った近似（replay/turn_replay.ts の VapOutage）。
 * ja の変更前は turn.vap_unavailable を外した今の方策（既存の fallback の分岐）。
 *
 * PRINT_REPLAY=1 で前後比較の表を出す。
 */
import { describe, expect, it } from 'vitest';
import { hri2025, ja } from './helpers';
import { SESSION_2_EPISODES, loadFixture, replayEpisode } from './replay/turn_replay';

const fixture = loadFixture('s20261108T045055-ca6e12');
const options = { fallback_energy_silence_threshold: -45 };
const outageOf = (ep: (typeof SESSION_2_EPISODES)[number]) => ({ from_ms: ep.from_ms, to_ms: ep.until_ms + 1 });
const before = SESSION_2_EPISODES.map((ep) =>
  replayEpisode(fixture, ep, ja((p) => { delete p.turn.vap_unavailable; }), outageOf(ep), options),
);
const after = SESSION_2_EPISODES.map((ep) => replayEpisode(fixture, ep, ja(), outageOf(ep), options));
const hri = SESSION_2_EPISODES.map((ep) => replayEpisode(fixture, ep, hri2025(), outageOf(ep), options));

if (process.env.PRINT_REPLAY === '1') {
  const fmt = (r: { start_ms: number | null; delay_ms: number | null; mid_utterance: boolean; start_reason: string | null }) =>
    r.start_ms === null ? '開始なし' : `${(r.start_ms / 1000).toFixed(2)}s（遅れ ${r.delay_ms}ms${r.mid_utterance ? '、途中' : ''}、${r.start_reason}）`;
  console.log(SESSION_2_EPISODES.map((ep, i) => `${ep.name} | ${fmt(before[i]!)} | ${fmt(after[i]!)}`).join('\n'));
}

describe('全区間で VAP が使えないときの再生', () => {
  it('変更後: 人の発話の途中で話し始めない', () => {
    expect(after.filter((r) => r.mid_utterance).map((r) => r.episode)).toEqual([]);
  });

  it('変更後: 開始は VAP でなく fallback／招待で、待ちの下限（1500ms）以上', () => {
    const started = after.filter((r) => r.start_ms !== null);
    expect(started.length).toBeGreaterThan(0);
    for (const r of started) {
      expect(r.start_reason).toMatch(/^(fallback_silence_max|invitation)/);
      expect(r.delay_ms).toBeGreaterThanOrEqual(1500);
    }
  });

  it('変更後: 黙り込まない（E4 の AI の発話中の断片を除き、変更前に話した区間で話す）', () => {
    SESSION_2_EPISODES.forEach((ep, i) => {
      if (ep.name.startsWith('E4')) return;
      if (before[i]!.start_ms !== null) expect(after[i]!.start_ms, ep.name).not.toBeNull();
    });
  });

  it('hri2025: VAP がなければ開始しない（原著に fallback の開始はない）', () => {
    expect(hri.filter((r) => r.start_ms !== null)).toEqual([]);
  });
});
