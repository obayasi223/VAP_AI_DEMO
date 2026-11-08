/**
 * 調整画面の再生（dev/replay.ts）の決定性。実のログは使わない（利用者の発話が入るため）。
 * 偽の MaAI と台本のプロバイダで Session を動かしてログを作り、同じ方策で再生すると記録と同じ判断になることを確かめる。
 * 値は台本で、VAP や認識の性能は表さない。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ResearchEvent, TurnDiagnosticBody, type PolicyJa } from '@llm-vap/contracts';
import { prepareLog, replay } from '../../src/dev/replay';
import type { Rig } from '../session/helpers';
import { createRig, ended, productionJaPolicy, started, warmUp } from '../session/helpers';

const USER: [number, number, boolean] = [0.1, 0.1, true];
const PAUSE_AI: [number, number, boolean] = [0.8, 0.8, false];
const PAUSE_USER: [number, number, boolean] = [0.2, 0.2, false];

let rig: Rig | null = null;
afterEach(async () => {
  if (rig) await rig.session.close('test_done');
  rig = null;
});

/** 利用者が話し、間を置き、AI が始めたら再生の報告を返す。 */
async function turn(r: Rig, text: string, speakTicks: number, pause: [number, number, boolean], maxPause = 200): Promise<boolean> {
  await r.steps(speakTicks, { loud: true, p: USER });
  r.stt().deliver({ kind: 'interim', text: text.slice(0, 2), audio_frame_end: r.frame });
  await r.step({ loud: true, p: USER });
  r.stt().deliver({ kind: 'final', text, audio_frame_end: r.frame });
  const before = r.link.of('playback.begin').length;
  for (let i = 0; i < maxPause; i++) {
    await r.step({ p: pause });
    const begins = r.link.of('playback.begin');
    if (begins.length > before) {
      const begin = begins.at(-1) as { audio_playback_id: number; generation: number };
      r.browser(started(begin));
      await r.steps(40, { p: [0.9, 0.9, false] });
      r.browser(ended(begin, 'completed', 16000));
      await r.steps(10, { p: PAUSE_USER });
      return true;
    }
  }
  return false;
}

/**
 * 台本の STT は stt.* をログに書かない（本番は google_v2.ts の deliver が書く）。同じ項目でログに足す。
 * 本番の deliver は結果を渡す前に書くが、ここでは Session の後に書く（同じ時刻の同期の処理なので再生には効かない）。
 */
function logSttLikeGoogle(r: Rig): void {
  r.stt().onResult((result) => {
    const last = r.events.events.at(-1) as ResearchEvent;
    const { received_at: _received, kind, ...fields } = result;
    const event = ResearchEvent.parse({
      schema_version: last.schema_version,
      t_monotonic_ms: r.time.monotonicMs(),
      wall_clock: last.wall_clock,
      session_id: last.session_id,
      condition: last.condition,
      time_basis: { source: 'orchestrator', uncertainty_ms: { value: 0 } },
      event: kind === 'final' ? 'stt.final' : 'stt.interim',
      ...fields,
    });
    r.events.events.push(event);
  });
}

async function syntheticLog(policy: PolicyJa): Promise<ResearchEvent[]> {
  rig = await createRig({ policy, reply: 'そうなんですね。' });
  logSttLikeGoogle(rig);
  await warmUp(rig);
  await turn(rig, 'こんにちは、今日は晴れですね。', 40, PAUSE_AI);
  await turn(rig, '昨日は雨でした。', 30, PAUSE_USER);
  await turn(rig, '週末は山に行きます。', 50, PAUSE_AI);
  await rig.steps(20, { p: PAUSE_USER });
  return [...rig.events.events];
}

describe('再生の決定性（合成のログ）', () => {
  it('記録と同じ方策で再生すると、開始の時刻と turn.allowed が記録と一致する', async () => {
    const policy = productionJaPolicy();
    const events = await syntheticLog(policy);
    const log = prepareLog(events);
    const recordedStarts = events.filter((e) => e.event === 'speech.started').length;
    expect(recordedStarts).toBeGreaterThanOrEqual(2);
    const result = replay(log, policy);
    expect(result.start_match.recorded_only).toBe(0);
    expect(result.start_match.replayed_only).toBe(0);
    expect(result.start_match.matched).toBe(recordedStarts);
    expect(result.start_match.max_abs_shift_ms ?? 0).toBeLessThanOrEqual(20);
    expect(result.replayed.metrics.starts).toBe(result.recorded.metrics.starts);
    expect(result.divergences.filter((d) => d.kind.includes('start'))).toEqual([]);
    // 助走中（VAP の rewarm）は fallback で決まり、fallback_energy は記録にないので再生しない（既知の限界）。助走の後は一致する。
    const warm = (log.workerStartedAt ?? 0) + policy.turn.vap_rewarm_ms;
    const after = (list: { t: number }[]) => list.filter((c) => c.t >= warm);
    expect(after(result.replayed.turn_changes)).toEqual(after(result.recorded.turn_changes));
  });

  it('同じ入力と方策なら、何度再生しても同じ結果になる', async () => {
    const policy = productionJaPolicy();
    const log = prepareLog(await syntheticLog(policy));
    const a = replay(log, policy);
    const b = replay(log, policy);
    expect(b.replayed.starts).toEqual(a.replayed.starts);
    expect(b.replayed.turn_changes).toEqual(a.replayed.turn_changes);
    expect(b.replayed.metrics).toEqual(a.replayed.metrics);
    // 判断の材料（ライブの research.turn_diagnostic と同じ形）は契約に合う。
    expect(a.replayed.diagnostics.length).toBeGreaterThan(10);
    for (const d of a.replayed.diagnostics) TurnDiagnosticBody.parse(d);
    expect(a.replayed.diagnostics.some((d) => d.branches.some((x) => x.id === 'L67' && x.holds === true))).toBe(true);
  });

  it('最小の間を延ばすと、開始は遅れるか減る（再生が方策に効く）', async () => {
    const policy = productionJaPolicy();
    const log = prepareLog(await syntheticLog(policy));
    const base = replay(log, policy);
    const slow: PolicyJa = structuredClone(policy);
    slow.turn.constants.MIN_GAP_TIME_MS = 2500;
    if (slow.turn.start_guard) slow.turn.start_guard.min_gap_ms = 2500;
    const later = replay(log, slow);
    expect(later.replayed.starts.length).toBeLessThanOrEqual(base.replayed.starts.length);
    const firstBase = base.replayed.starts[0]?.t ?? 0;
    const firstLater = later.replayed.starts[0]?.t ?? Number.POSITIVE_INFINITY;
    expect(firstLater).toBeGreaterThan(firstBase);
  });
});
