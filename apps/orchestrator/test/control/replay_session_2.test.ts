/**
 * 実機の対話（s20261108T045055-ca6e12、ヘッドセットあり）を TurnManager に再生する回帰試験（docs/known_gaps.md §10）。
 * 素材は fixtures/turn_replay/ の抜き出し（発話文を含まない）。再生の前提と限界は replay/turn_replay.ts。
 *
 * 変更前は Appendix A のままの ja（start_guard と after_ai_speech なし）、変更後は config の ja。
 * 数値は1セッションだけの結果で、方策の妥当性の根拠としては弱い。
 *
 * PRINT_REPLAY=1 で前後比較の表を出す。
 */
import { describe, expect, it } from 'vitest';
import { hri2025, ja, jaAppendixA } from './helpers';
import { SESSION_2_EPISODES, loadFixture, realStart, replayEpisode } from './replay/turn_replay';
import type { ReplayResult } from './replay/turn_replay';

const fixture = loadFixture('s20261108T045055-ca6e12');
const before = SESSION_2_EPISODES.map((ep) => replayEpisode(fixture, ep, jaAppendixA()));
const after = SESSION_2_EPISODES.map((ep) => replayEpisode(fixture, ep, ja()));
const real = SESSION_2_EPISODES.map((ep) => realStart(fixture, ep));
const byName = (results: ReplayResult[], prefix: string) => results.find((r) => r.episode.startsWith(prefix))!;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
/** 正当な開始: 区間の中で始め、利用者の続きが来なかったもの。E4 は AI の連続の発話なので除く。 */
const legitDelays = (results: ReplayResult[]) =>
  results.filter((r) => !r.episode.startsWith('E4') && r.start_ms !== null && !r.mid_utterance).map((r) => r.delay_ms as number);

if (process.env.PRINT_REPLAY === '1') {
  const fmt = (r: { start_ms: number | null; delay_ms: number | null; mid_utterance: boolean }) =>
    r.start_ms === null ? '開始なし' : `${(r.start_ms / 1000).toFixed(2)}s（遅れ ${r.delay_ms}ms${r.mid_utterance ? '、途中' : ''}）`;
  const rows = SESSION_2_EPISODES.map((ep, i) =>
    [ep.name, fmt(real[i]!), fmt(before[i]!), `${before[i]!.allowed_mid_utterance}/${before[i]!.allowed_windows}`, fmt(after[i]!), `${after[i]!.allowed_mid_utterance}/${after[i]!.allowed_windows}`, after[i]!.start_reason ?? ''].join(' | '),
  );
  console.log(['区間 | 実際 | 変更前の再生 | 変更前の許可（途中/全） | 変更後の再生 | 変更後の許可（途中/全） | 変更後の理由', ...rows].join('\n'));
  console.log(`正当な開始の遅れの中央値: 変更前 ${median(legitDelays(before))}ms、変更後 ${median(legitDelays(after))}ms`);
}

describe('s20261108T045055-ca6e12 の再生（ja）', () => {
  it('変更前の再生は実際の問題を再現する（再生の妥当性の確認）', () => {
    // E3: 利用者の発話の途中（直後に「で」）で始めた。
    expect(real[2]!.mid_utterance).toBe(true);
    expect(byName(before, 'E3').mid_utterance).toBe(true);
    expect(Math.abs((byName(before, 'E3').start_ms as number) - (real[2]!.start_ms as number))).toBeLessThan(300);
    // E4: AI の発話中の「で」に、AI が話し終えた直後に2回目の発話で応えた。
    expect(byName(before, 'E4').start_ms).not.toBeNull();
    expect((byName(before, 'E4').start_ms as number) - 57400).toBeLessThan(1000);
    // E2: 「そうですね」の後、利用者が続ける前に許可が出ていた（実ログ 18.50s。準備が間に合わず開始はしなかった）。
    expect(byName(before, 'E2').allowed_mid_utterance).toBeGreaterThanOrEqual(1);
  });

  it('変更後: 利用者の発話の途中での開始がない', () => {
    expect(after.filter((r) => r.mid_utterance)).toEqual([]);
  });

  it('変更後: 発話の途中に出る許可が減る', () => {
    const sum = (rs: ReplayResult[]) => rs.reduce((a, r) => a + r.allowed_mid_utterance, 0);
    expect(sum(after)).toBeLessThan(sum(before));
  });

  it('変更後: AI の発話中の「で」に、話し終えた後で続けて応答しない（E4）', () => {
    expect(byName(after, 'E4').start_ms).toBeNull();
  });

  it('変更後: 他の区間では話し始める（黙り込まない）', () => {
    for (const prefix of ['E1', 'E2', 'E3', 'E5']) expect(byName(after, prefix).start_ms).not.toBeNull();
  });

  it('変更後: 正当な開始までの遅れの中央値は 1.8 秒以内、変更前からの増分は 1 秒以内', () => {
    const b = median(legitDelays(before));
    const a = median(legitDelays(after));
    expect(a).toBeLessThanOrEqual(1800);
    expect(a - b).toBeLessThanOrEqual(1000);
  });
});

describe('s20261108T045055-ca6e12 の再生（hri2025 は原著どおり）', () => {
  it('hri2025 の再生は変更の前と同じ（start_guard と after_ai_speech の影響を受けない）', () => {
    // 期待値は変更前のコード（b6f6595 の turn_manager.ts）で同じ再生を回した結果。一致を確かめてから固定した。
    // E4 は原著どおり AI の発話中に L74 で許可し、U-1 の補正がないので再生中でも開始する。
    const results = SESSION_2_EPISODES.map((ep) => replayEpisode(fixture, ep, hri2025()));
    expect(results.map((r) => [r.start_ms, r.start_reason, r.mid_utterance, r.allowed_windows, r.allowed_mid_utterance])).toEqual([
      [11120, 'L67_vap_yield+L74_completion_timeout', false, 1, 0],
      [33091, 'L67_vap_yield+L74_completion_timeout', false, 2, 2],
      [50255, 'L74_completion_timeout', true, 0, 0],
      [52965, 'L74_completion_timeout', false, 0, 0],
      [67595, 'L74_completion_timeout', false, 1, 0],
    ]);
  });
});
