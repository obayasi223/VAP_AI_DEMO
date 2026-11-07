/** want_to_speak、permitted_to_speak、speaking の分離と、E1 の範囲の固定。 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TurnManagerFactory } from '@llm-vap/contracts';
import { createTurnManager } from '../../src/control';
import type { TurnState } from '../../src/control';
import { Driver, T0, ja, kinds, playing, ready } from './helpers';

const YIELD: [number, number, boolean] = [0.6, 0.6, false];
const USER: [number, number, boolean] = [0.3, 0.3, false];

describe('want != permitted != speaking（計画 §4.6）', () => {
  it.each([
    ['want のみ', { p: USER, prefetch: ready() }, { want: 'response', permitted: false, speaking: 'silent' }],
    ['permitted のみ', { p: YIELD }, { want: 'none', permitted: true, speaking: 'silent' }],
  ])('%s', (_title, input, expected) => {
    const d = new Driver(ja());
    d.tick(T0, { p: USER });
    d.tick(T0 + 500, input);
    expect(d.state.want_to_speak.kind).toBe(expected.want);
    expect(d.state.permitted_to_speak).toBe(expected.permitted);
    expect(d.state.speaking.phase).toBe(expected.speaking);
  });
  it('speaking のみ', () => {
    const d = new Driver(ja());
    d.tick(T0, { p: USER, playback: playing(9) });
    expect(d.state.want_to_speak.kind).toBe('none');
    expect(d.state.permitted_to_speak).toBe(false);
    expect(d.state.speaking).toEqual({ phase: 'playing', audio_playback_id: 9 });
  });
  it('want と permitted の両方が揃った tick で開始し、話し中に移る', () => {
    const d = new Driver(ja());
    d.tick(T0, { p: USER });
    expect(kinds(d.tick(T0 + 500, { p: YIELD, prefetch: ready() }))).toContain('start_speech');
    expect(d.state.speaking.phase).toBe('starting');
    expect(d.state.want_to_speak.kind).toBe('none');
  });
});

describe('E1 の範囲', () => {
  it('createTurnManager は契約の TurnManagerFactory の形', () => {
    const factory: TurnManagerFactory<TurnState> = createTurnManager;
    expect(factory(ja()).initialState().segment_id).toBe(0);
  });
  it('WoZ の入力は E3 まで読まない（allow_turn を渡しても許可しない）', () => {
    const d = new Driver(ja());
    d.tick(T0, { p: USER, woz: [{ action: 'allow_turn', operator: 'test' }] });
    expect(d.state.permitted_to_speak).toBe(false);
  });
  it('p の添字を読むのは vap_direction.ts だけ', () => {
    const dir = join(import.meta.dirname, '..', '..', 'src', 'control');
    const offenders = readdirSync(dir)
      .filter((name) => name !== 'vap_direction.ts')
      .filter((name) => /\b(p_now|p_future|vad)\[/.test(readFileSync(join(dir, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
