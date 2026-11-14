/** 2 体の振り分けの純粋な部品（docs/design/two_ai/03 §2.5、§5.1）。 */
import { describe, expect, it } from 'vitest';
import { PLAYBACK_OWNER_LIMIT, PlaybackOwnerTable, commandTarget, gazeTargets, routeMouthLevel } from '../../src/session/ai_routing';

describe('PlaybackOwnerTable', () => {
  it('begin の ai_id を覚え、ownerOf で引ける', () => {
    const table = new PlaybackOwnerTable();
    expect(table.noteBegin({ audio_playback_id: 1, ai_id: 'B' })).toBe('B');
    expect(table.noteBegin({ audio_playback_id: 2, ai_id: 'A' })).toBe('A');
    expect(table.ownerOf(1)).toBe('B');
    expect(table.ownerOf(2)).toBe('A');
    expect(table.ownerOf(3)).toBeNull();
    expect(table.missingAiId).toBe(0);
  });

  it('ai_id のない begin は A として数える', () => {
    const table = new PlaybackOwnerTable();
    expect(table.noteBegin({ audio_playback_id: 7 })).toBe('A');
    expect(table.ownerOf(7)).toBe('A');
    expect(table.missingAiId).toBe(1);
  });

  it('未知の ai_id は覚えずに数える', () => {
    const table = new PlaybackOwnerTable();
    expect(table.noteBegin({ audio_playback_id: 7, ai_id: 'C' })).toBeNull();
    expect(table.ownerOf(7)).toBeNull();
    expect(table.unknownAiId).toBe(1);
  });

  it('forget で消え、上限を超えると古い順に落とす', () => {
    const table = new PlaybackOwnerTable();
    table.noteBegin({ audio_playback_id: 1, ai_id: 'A' });
    table.forget(1);
    expect(table.ownerOf(1)).toBeNull();
    for (let id = 100; id < 100 + PLAYBACK_OWNER_LIMIT + 5; id += 1) table.noteBegin({ audio_playback_id: id, ai_id: 'B' });
    expect(table.size).toBe(PLAYBACK_OWNER_LIMIT);
    expect(table.ownerOf(100)).toBeNull();
    expect(table.ownerOf(104)).toBeNull();
    expect(table.ownerOf(105)).toBe('B');
  });
});

describe('routeMouthLevel', () => {
  it('再生中の AI にだけ渡す', () => {
    expect(routeMouthLevel(0.3, new Set(['A']))).toEqual({ A: 0.3, B: 0 });
    expect(routeMouthLevel(0.3, new Set(['B']))).toEqual({ A: 0, B: 0.3 });
  });
  it('0 件なら両方 0', () => {
    expect(routeMouthLevel(0.3, new Set())).toEqual({ A: 0, B: 0 });
  });
});

describe('指示の宛先', () => {
  it('gaze.command は省略で両方、未知で空', () => {
    expect(gazeTargets(undefined)).toEqual(['A', 'B']);
    expect(gazeTargets('B')).toEqual(['B']);
    expect(gazeTargets('Z')).toEqual([]);
  });
  it('他の指示は省略で A（数える）、未知で null', () => {
    expect(commandTarget(undefined)).toEqual({ ai_id: 'A', missing: true });
    expect(commandTarget('B')).toEqual({ ai_id: 'B', missing: false });
    expect(commandTarget('Z')).toBeNull();
  });
});
