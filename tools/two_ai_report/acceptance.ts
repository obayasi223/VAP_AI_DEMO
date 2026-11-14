/**
 * 受け入れ基準の自動の列（04 の AC1〜AC21、05 §6 の AC12〜AC14）。log_check の 2 体の規則と要約の acceptance の両方がこれを使う。
 * 入力は events.jsonl と manifest（と、manifest が指す設定と台本。なければ、それに依る項目は ok: null）。
 * ok: true 合格、false 不合格、null このログでは確かめられない（手動の項目、材料がない）。
 */
import type { ResearchEvent } from '@llm-vap/contracts';
import {
  mval,
  ofType,
  phaseOf,
  playedMs,
  sameHash,
  sha256,
  slipTexts,
  spokenText,
  twoAiSpeech,
  type TwoAiSessionData,
} from './session';

export interface AcceptanceRow {
  id: string;
  ok: boolean | null;
  detail: string;
}

const CONTENT_KINDS = new Set(['discussion', 'point', 'point_elaboration']);
const ACK_TOLERANCE_MS_DEFAULT = 150;
const AT_SEC_TOLERANCE_MS = 20_000;

function row(id: string, problems: string[], okDetail: string): AcceptanceRow {
  return problems.length === 0 ? { id, ok: true, detail: okDetail } : { id, ok: false, detail: problems.slice(0, 6).join('、') + (problems.length > 6 ? ` ほか ${problems.length - 6} 件` : '') };
}

function turnStarts(events: readonly ResearchEvent[]) {
  return ofType(events, 'two_ai.turn').filter((t) => t.stage === 'started');
}

/** 封筒の規則（04 A。第 4 回 M5）。 */
export function checkEnvelope(data: TwoAiSessionData): AcceptanceRow {
  const problems: string[] = [];
  let current: string | null = null;
  let missing = 0;
  for (const e of data.emitted ?? data.events) {
    if (e.event === 'two_ai.phase_changed') current = e.to;
    if (e.two_ai === undefined) {
      missing += 1;
      continue;
    }
    if (e.event === 'two_ai.phase_changed') {
      if (e.two_ai.phase !== e.to && e.two_ai.phase !== e.from) problems.push(`phase_changed の封筒の段階 ${e.two_ai.phase} が from/to と違う`);
    } else if (current !== null && e.two_ai.phase !== current) {
      problems.push(`${e.event}@${Math.round(e.t_monotonic_ms)} の封筒の段階 ${e.two_ai.phase} が ${current} と違う`);
    }
    const needsAi =
      e.event.startsWith('speech.') || e.event.startsWith('signal.') || ((e.event === 'llm.request' || e.event === 'llm.response') && e.purpose === 'discussion_turn');
    if (needsAi && e.two_ai.ai_id === null) problems.push(`${e.event}@${Math.round(e.t_monotonic_ms)} の ai_id が null`);
    if ((e.event === 'speech.started' || e.event === 'speech.ended' || e.event === 'speech.interrupted') && (e as { origin: string }).origin === 'two_ai_turn') {
      const ai = (e as { ai_id: string }).ai_id;
      if (e.two_ai.ai_id !== null && e.two_ai.ai_id !== ai) problems.push(`${e.event}@${Math.round(e.t_monotonic_ms)} の封筒の ai_id と発話の ai_id が違う`);
    }
  }
  if (missing > 0) problems.unshift(`封筒の two_ai がないイベント ${missing} 件`);
  return row('envelope', problems, `${data.events.length} 件すべてに two_ai、段階は phase_changed の列と一致`);
}

/** AC7：条件は途中で変えない。 */
function ac7(data: TwoAiSessionData): AcceptanceRow {
  const conditions = new Set(data.events.map((e) => e.condition));
  const problems: string[] = [];
  if (conditions.size > 1) problems.push(`condition が混在: ${[...conditions].join(', ')}`);
  const manifestCondition = data.two_ai?.condition;
  if (manifestCondition !== undefined && conditions.size === 1 && !conditions.has(manifestCondition)) problems.push(`manifest の条件 ${manifestCondition} とイベントが違う`);
  return row('AC7', problems, `条件 ${[...conditions].join(', ')} で一定`);
}

function condition(data: TwoAiSessionData): string | null {
  return data.two_ai?.condition ?? data.events[0]?.condition ?? null;
}

/** AC1：受け止めの長さの固定。 */
function ac1(data: TwoAiSessionData): AcceptanceRow {
  const problems: string[] = [];
  const tolerance = data.config?.acknowledgment.duration_tolerance_ms ?? ACK_TOLERANCE_MS_DEFAULT;
  const templateTexts = data.config?.acknowledgment.templates.map((t) => t.text) ?? null;
  const templateHashes = data.two_ai?.ack_templates.map((t) => t.text_sha256) ?? null;
  const synthesized = new Map((data.two_ai?.ack_templates ?? []).map((t) => [t.id, t.synthesized_ms]));
  const speeches = twoAiSpeech(data.events, 'finished');
  const episodes = ofType(data.events, 'two_ai.interjection_episode').filter((e) => e.ack !== null);
  const woz = ofType(data.events, 'woz.override').filter((w) => w.action === 'abort' || w.action === 'stop');
  for (const ep of episodes) {
    const ack = ep.ack!;
    const speech = speeches.find((s) => s.audio_playback_id === ack.audio_playback_id);
    if (speech === undefined) {
      problems.push(`${ep.interjection_id}: 受け止めの発話（audio_playback_id ${ack.audio_playback_id}）がない`);
      continue;
    }
    if (speech.turn_kind !== 'ack') problems.push(`${ep.interjection_id}: 受け止めの発話の turn_kind が ${speech.turn_kind}`);
    const text = spokenText(speech);
    if (!ack.truncated) {
      if (templateTexts !== null && !templateTexts.includes(text)) problems.push(`${ep.interjection_id}: 受け止めの文が定型と違う`);
      else if (templateTexts === null && templateHashes !== null && !templateHashes.some((h) => sameHash(h, sha256(text)))) problems.push(`${ep.interjection_id}: 受け止めの文のハッシュが manifest と違う`);
    }
    const expected = synthesized.get(ack.template_id)?.[ack.ai_id] ?? ack.synthesized_ms;
    if (!ack.truncated && Math.abs(ack.played_ms - expected) > tolerance) problems.push(`${ep.interjection_id}: 再生 ${ack.played_ms}ms が合成 ${expected}ms から ±${tolerance}ms を外れた`);
    if (ack.truncated && !woz.some((w) => w.t_monotonic_ms >= ep.onset_at)) problems.push(`${ep.interjection_id}: 受け止めが途中で切れた（WoZ の中止でない）`);
  }
  if (condition(data) === 'respond_at_end') {
    const inDiscussion = ofType(data.events, 'two_ai.interjection_episode').filter((e) => e.ack !== null && phaseOf(e) === 'discussion');
    if (inDiscussion.length > 0) problems.push(`② の discussion に受け止め ${inDiscussion.length} 件`);
  }
  return row('AC1', problems, `受け止め ${episodes.length} 件が定型・長さ ±${tolerance}ms`);
}

/** AC2：C と対照の推論を同じ長さで展開（(a)(b)。(d) は --pair）。 */
function ac2(data: TwoAiSessionData): AcceptanceRow {
  const problems: string[] = [];
  const aborted = ofType(data.events, 'woz.override').some((w) => w.action === 'abort');
  const exposures = ofType(data.events, 'two_ai.point_exposure').filter((p) => p.point_kind === 'framing_C' || p.point_kind === 'control_inference');
  for (const p of exposures) {
    if (!p.complete && !aborted) problems.push(`${p.point_id}: complete が false`);
    if (p.elaborations_done !== p.elaborations_planned) problems.push(`${p.point_id}: 展開 ${p.elaborations_done}/${p.elaborations_planned}`);
  }
  if (exposures.length === 0) return { id: 'AC2', ok: null, detail: 'C と対照の推論の point_exposure がない' };
  return row('AC2', problems, `${exposures.map((p) => `${p.point_id} 新しい部分 ${p.exposure_new_ms}ms`).join('、')}`);
}

/** AC3：訂正による台本の切替（(a)〜(j)）。 */
function ac3(data: TwoAiSessionData): AcceptanceRow {
  const problems: string[] = [];
  const cond = condition(data);
  const scripts = ofType(data.events, 'two_ai.script');
  const switched = scripts.filter((s) => s.stage === 'switched');
  // (a)(d)
  if (switched.length > 1) problems.push(`(a) switched が ${switched.length} 回`);
  if (cond === 'respond_at_end' && switched.length > 0) problems.push('(d) ② で切り替わった');
  for (const s of scripts.filter((x) => x.stage === 'rejected' && cond === 'respond_at_end' && phaseOf(x) === 'discussion')) {
    if (s.reason !== 'condition_respond_at_end') problems.push(`(d) ② の rejected の理由が ${s.reason}`);
  }
  const sw = switched[0];
  // (b)
  if (sw !== undefined) {
    const before = data.events.filter((e) => e.t_monotonic_ms > sw.t_monotonic_ms && e.two_ai?.script_variant !== 'corrected');
    if (before.length > 0) problems.push(`(b) 切替の後に original の封筒 ${before.length} 件`);
    // (c)
    const startedAfter = turnStarts(data.events).filter((t) => t.t_monotonic_ms > sw.t_monotonic_ms && sw.invalidated_turn_ids.includes(t.turn_id));
    if (startedAfter.length > 0) problems.push(`(c) 取り消したターンが始まった: ${startedAfter.map((t) => t.turn_id).join(',')}`);
  }
  // (e)
  for (const s of scripts.filter((x) => x.stage === 'recorded_only')) {
    if (phaseOf(s) !== 'response') problems.push(`(e) recorded_only が ${phaseOf(s)} の段階`);
    const uptakeAfter = twoAiSpeech(data.events, 'started').filter((x) => x.turn_kind === 'uptake' && x.t_monotonic_ms > s.t_monotonic_ms);
    if (uptakeAfter.length > 0) problems.push('(e) 応答の段の訂正の後に uptake を話した');
  }
  // (g)
  for (const s of scripts.filter((x) => x.trigger === 'auto_confirmed' && x.stage === 'switched')) {
    const ok = ofType(data.events, 'two_ai.correction_suggested').some((c) => c.point_id === s.point_id && c.status === 'done' && c.corrects === true && c.t_monotonic_ms <= s.t_monotonic_ms);
    if (!ok) problems.push('(g) auto_confirmed の前に corrects: true の提案がない');
    if (data.two_ai !== null && data.two_ai.correction_mode !== 'auto') problems.push('(g) auto_confirmed なのに correction_mode が auto でない');
  }
  // (h)
  const slip = slipTexts(data);
  const uptakeStart = twoAiSpeech(data.events, 'started').find((x) => x.turn_kind === 'uptake');
  let hChecked = false;
  if (slip !== null && uptakeStart !== undefined) {
    hChecked = true;
    const contains = (text: string) => text.includes(slip.slip_statement) || text.includes(slip.slip_value);
    for (const s of twoAiSpeech(data.events, 'finished')) {
      if (s.t_monotonic_ms <= uptakeStart.t_monotonic_ms) continue;
      const ph = phaseOf(s);
      if ((ph === 'discussion' || ph === 'response') && s.turn_kind !== 'retraction' && contains(spokenText(s))) {
        problems.push(`(h) uptake の後の ${s.turn_id}（${s.turn_kind}）に取り違えの文`);
      }
    }
    const shownBefore = new Set<string>();
    for (const b of ofType(data.events, 'two_ai.board')) {
      if (sw !== undefined && b.t_monotonic_ms <= sw.t_monotonic_ms) for (const c of b.cards) shownBefore.add(c.card_id);
    }
    for (const b of ofType(data.events, 'two_ai.board')) {
      if (b.t_monotonic_ms <= uptakeStart.t_monotonic_ms) continue;
      for (const c of b.cards) {
        const exempt = shownBefore.has(c.card_id) && b.mode === 'building';
        if (!exempt && contains(c.text)) problems.push(`(h) uptake の後の板 ${c.card_id}（${b.mode}）に取り違えの値`);
      }
    }
  }
  // (i)(j)
  const turns = turnStarts(data.events);
  const episodes = ofType(data.events, 'two_ai.interjection_episode');
  for (const ep of episodes) {
    const hold = ep.correction_hold;
    if (cond === 'respond_at_end' && hold !== null) problems.push(`(j) ② の ${ep.interjection_id} に correction_hold`);
    if (hold === null) continue;
    const nextOnset = ofType(data.events, 'two_ai.interjection').find((i) => i.stage === 'onset' && i.t_monotonic_ms > ep.onset_at && i.interjection_id !== ep.interjection_id);
    const until = nextOnset?.t_monotonic_ms ?? Number.POSITIVE_INFINITY;
    const after = turns.filter((t) => t.t_monotonic_ms > ep.onset_at && t.t_monotonic_ms < until);
    const resumes = after.filter((t) => t.turn_kind === 'resume');
    const bridges = after.filter((t) => t.turn_kind === 'bridge');
    if (hold.ended_by === 'corrected') {
      if (resumes.length > 0 || bridges.length > 0) problems.push(`(j) ${ep.interjection_id}: 訂正が確定したのに resume/bridge がある`);
      // (i) 受け止め → uptake → 訂正後の版
      const kinds = after.map((t) => t.turn_kind);
      const ackIdx = kinds.indexOf('ack');
      if (ackIdx < 0 || kinds[ackIdx + 1] !== 'uptake') problems.push(`(i) ${ep.interjection_id}: 受け止めの次が uptake でない（${kinds.slice(0, 4).join('→')}）`);
      else {
        const next = after[ackIdx + 2];
        const sw2 = scripts.find((s) => s.stage === 'switched');
        if (sw2?.resume_dropped && next !== undefined && next.point_id !== null && next.point_id === sw2.point_id && next.point_variant !== 'corrected') problems.push(`(i) ${ep.interjection_id}: uptake の次の点のターンが訂正後の版でない`);
      }
    } else if (hold.ended_by === 'timeout') {
      if (resumes.length > 0) problems.push(`(j) ${ep.interjection_id}: 時間切れなのに resume がある`);
      if (bridges.length !== 1) problems.push(`(j) ${ep.interjection_id}: bridge が ${bridges.length} 回`);
      for (const br of bridges) {
        const ended = ofType(data.events, 'two_ai.turn').find((t) => t.turn_id === br.turn_id && t.stage === 'ended');
        if (ended && (mval(ended.content_ms) ?? 0) !== 0) problems.push(`(j) bridge ${br.turn_id} の content_ms が 0 でない`);
        const sp = twoAiSpeech(data.events, 'finished').find((s) => s.turn_id === br.turn_id);
        if (sp && slip !== null && (spokenText(sp).includes(slip.slip_statement) || spokenText(sp).includes(slip.slip_value))) problems.push(`(j) bridge に取り違えの文`);
      }
    }
  }
  for (const pe of ofType(data.events, 'two_ai.point_exposure')) {
    if (pe.segments.some((s) => s.turn_kind === 'bridge')) problems.push(`(j) ${pe.point_id} の segments に bridge`);
  }
  // 訂正が確定した F の途中の割り込みの script は resume_dropped
  for (const s of switched) {
    const ep = episodes.find((e) => e.correction?.point_id === s.point_id && e.during_point_id === s.point_id && e.correction_hold?.ended_by === 'corrected');
    if (ep !== undefined && !s.resume_dropped) problems.push('(i) F の途中の訂正なのに resume_dropped が false');
  }
  const detail = [
    `switched ${switched.length}、rejected ${scripts.filter((s) => s.stage === 'rejected').length}、recorded_only ${scripts.filter((s) => s.stage === 'recorded_only').length}`,
    hChecked ? '(h) 検査済み' : slip === null ? '(h) 取り違えの文が分からない' : '(h) uptake なし',
  ].join('、');
  return row('AC3', problems, detail);
}

/** AC4：接触秒数（events から独立に再計算）。 */
function ac4(data: TwoAiSessionData): AcceptanceRow {
  const problems: string[] = [];
  const exposures = ofType(data.events, 'two_ai.point_exposure');
  const unavailable = new Set(ofType(data.events, 'two_ai.point').filter((p) => p.stage === 'unavailable').map((p) => p.point_id));
  const planned = data.two_ai?.planned_points.map((p) => p.id) ?? [...new Set(ofType(data.events, 'two_ai.point').map((p) => p.point_id))];
  const reachedEnd = ofType(data.events, 'two_ai.phase_changed').some((p) => p.to === 'response' || p.to === 'end');
  for (const id of planned) {
    if (unavailable.has(id)) continue;
    const n = exposures.filter((e) => e.point_id === id).length;
    if (n !== 1 && (reachedEnd || n > 1)) problems.push(`(a) ${id} の point_exposure が ${n} 件`);
  }
  const speeches = twoAiSpeech(data.events, 'finished');
  for (const e of exposures) {
    const total = speeches.filter((s) => s.point_id === e.point_id && s.turn_kind !== 'ack' && s.turn_kind !== 'uptake' && s.turn_kind !== 'bridge').reduce((sum, s) => sum + playedMs(s), 0);
    if (Math.abs(total - e.exposure_total_ms) > 1) problems.push(`(b) ${e.point_id}: total ${e.exposure_total_ms} と再計算 ${total.toFixed(1)} が違う`);
    if (Math.abs(e.exposure_new_ms - (e.exposure_total_ms - e.bridge_ms - e.repeated_ms)) > 1) problems.push(`(c) ${e.point_id}: new ≠ total − bridge − repeated`);
  }
  return row('AC4', problems, `point_exposure ${exposures.length} 件、再計算と 1ms 以内`);
}

/** AC5：② では止まらない。 */
function ac5(data: TwoAiSessionData): AcceptanceRow {
  if (condition(data) !== 'respond_at_end') return { id: 'AC5', ok: null, detail: '② だけの基準' };
  const problems: string[] = [];
  const stops = ofType(data.events, 'speech.interrupted').filter((s) => phaseOf(s) === 'discussion' && s.decision_source !== 'woz');
  if (stops.length > 0) problems.push(`(a) ② の discussion で vap/fallback の停止 ${stops.length} 件`);
  const allowed = new Set(['onset', 'ignored_by_condition', 'sub_threshold']);
  const bad = ofType(data.events, 'two_ai.interjection').filter((i) => phaseOf(i) === 'discussion' && !allowed.has(i.stage));
  if (bad.length > 0) problems.push(`(b) ② の interjection に ${[...new Set(bad.map((b) => b.stage))].join(',')}`);
  const wozFace = ofType(data.events, 'woz.override').filter((w) => w.action === 'face_user').map((w) => w.t_monotonic_ms);
  // 割り込みが原因のものだけを数える。段階の台詞（話し合いの終わりの phase_line）は両条件で同じに本人を見る（01 §3.8）。
  const gazeUser = ofType(data.events, 'gaze.decision').filter(
    (g) => phaseOf(g) === 'discussion' && g.target === 'user' && g.reason !== 'phase_line' && !wozFace.some((t) => g.t_monotonic_ms >= t && g.t_monotonic_ms - t <= 1000),
  );
  if (gazeUser.length > 0) problems.push(`(c) ② の discussion で本人への視線 ${gazeUser.length} 件`);
  const wozStops = ofType(data.events, 'woz.override').filter((w) => w.action === 'stop');
  const detail = wozStops.length > 0 ? `手順の逸脱：WoZ の stop ${wozStops.length} 件` : '停止なし';
  return row('AC5', problems, detail);
}

/** AC6：両条件で同じ長さの応答の時間。 */
function ac6(data: TwoAiSessionData): AcceptanceRow {
  const windows = ofType(data.events, 'two_ai.response_window');
  const reached = ofType(data.events, 'two_ai.phase_changed').some((p) => p.to === 'response');
  if (!reached) return { id: 'AC6', ok: null, detail: 'response に届いていない' };
  const problems: string[] = [];
  if (windows.length !== 1) problems.push(`response_window が ${windows.length} 件`);
  const w = windows[0];
  if (w !== undefined) {
    const actual = w.ended_at - w.started_at - w.overrun_ms;
    if (w.ended_by === 'timer' && Math.abs(actual - w.planned_ms) > 1000) problems.push(`(b) 問いの終わりから時間切れまで ${actual}ms（計画 ${w.planned_ms}ms）`);
    if (w.ended_by !== 'timer' && w.ended_by !== 'woz') problems.push(`(c) ended_by ${w.ended_by}`);
    const plannedSec = data.two_ai?.response_duration_sec;
    if (plannedSec !== undefined && w.planned_ms !== plannedSec * 1000) problems.push(`(f) planned_ms ${w.planned_ms} が設定 ${plannedSec * 1000} と違う`);
    if (w.ended_by === 'woz') return { id: 'AC6', ok: null, detail: 'WoZ で終えた（手順の逸脱）' };
  }
  return row('AC6', problems, w ? `計画 ${w.planned_ms}ms、延長 ${w.overrun_ms}ms、本人の発話 ${w.user_speech_ms}ms` : '');
}

/** in_stage の点の、段の中の生の拍の数（点の開始の前に始まった discussion のターン）。 */
/**
 * 02 が点の前に入れる受けのターン（beat_id が align_<point_id>。点の話者が直前の話者と同じときだけ。両条件で同じ）は、
 * 計画の拍ではないので数えない（02 の stageDone、beatsDone と同じ数え方）。two_ai.generation の beat_id で見分ける。
 */
export function alignTurnIds(events: readonly ResearchEvent[]): Set<string> {
  return new Set(ofType(events, 'two_ai.generation').filter((g) => typeof g.beat_id === 'string' && g.beat_id.startsWith('align_')).map((g) => g.turn_id));
}

export function beatsBeforePoint(events: readonly ResearchEvent[], pointTurnId: string): { stage: number | null; beats: number } {
  const turns = turnStarts(events);
  const start = turns.find((t) => t.turn_id === pointTurnId);
  if (start === undefined) return { stage: null, beats: -1 };
  const stage = start.discussion_stage;
  const align = alignTurnIds(events);
  const beats = new Set(turns.filter((t) => t.discussion_stage === stage && t.turn_kind === 'discussion' && !align.has(t.turn_id) && t.t_monotonic_ms < start.t_monotonic_ms).map((t) => t.turn_id)).size;
  return { stage, beats };
}

/** AC8 と AC14：点は指定の時点で、必ず出る。 */
function ac8and14(data: TwoAiSessionData): AcceptanceRow[] {
  const points = ofType(data.events, 'two_ai.point');
  const p8: string[] = [];
  const p14: string[] = [];
  const reachedEnd = ofType(data.events, 'two_ai.phase_changed').some((p) => p.to === 'response' || p.to === 'end');
  const ids = data.two_ai?.planned_points.map((p) => p.id) ?? [...new Set(points.map((p) => p.point_id))];
  let forced = 0;
  for (const id of ids) {
    const of = points.filter((p) => p.point_id === id);
    if (of.some((p) => p.stage === 'unavailable')) continue;
    if (of.some((p) => p.stage === 'missed')) p14.push(`(a) ${id} が missed`);
    const started = of.find((p) => p.stage === 'started');
    if (started === undefined) {
      if (reachedEnd) p14.push(`(a) ${id} の started がない`);
      continue;
    }
    if (of.some((p) => p.stage === 'forced')) {
      forced += 1;
      continue;
    }
    const trig = started.trigger;
    if ('in_stage' in trig) {
      const { stage, beats } = beatsBeforePoint(data.events, started.turn_id ?? '');
      if (stage !== trig.in_stage) p8.push(`${id}: 段 ${stage}（指定 ${trig.in_stage}）`);
      else if (beats !== trig.after_stage_turn) p8.push(`${id}: 段の ${beats} 拍の後（指定 ${trig.after_stage_turn}）`);
    } else if ('after_turn' in trig) {
      const align = alignTurnIds(data.events);
      const n = new Set(turnStarts(data.events).filter((t) => t.turn_kind === 'discussion' && !align.has(t.turn_id) && t.t_monotonic_ms < started.t_monotonic_ms).map((t) => t.turn_id)).size;
      if (n !== trig.after_turn) p8.push(`${id}: ${n} 拍の後（指定 ${trig.after_turn}）`);
    } else {
      const target = 'at_sec' in trig ? trig.at_sec * 1000 : data.config ? trig.at_frac * data.config.phases.discussion.target_sec * 1000 : null;
      const at = mval(started.content_elapsed_ms);
      if (target !== null && at !== null && Math.abs(at - target) > AT_SEC_TOLERANCE_MS) p8.push(`${id}: 中身の時計 ${at}ms（目標 ${target}ms ±20 秒）`);
    }
  }
  if (forced > 0 && data.two_ai?.evidence_ok_for_comparison === true) p14.push(`(c) forced ${forced} 件なのに evidence_ok_for_comparison が true`);
  return [row('AC8', p8, `点の開始の拍が引き金どおり${forced > 0 ? `（forced ${forced} 件は除外）` : ''}`), row('AC14', p14, `点 ${ids.length} 個が出た、forced ${forced}`)];
}

/** AC9：停止と受け止めの記録の整合。 */
function ac9(data: TwoAiSessionData): AcceptanceRow {
  const problems: string[] = [];
  const episodes = ofType(data.events, 'two_ai.interjection_episode');
  const ids = new Set(ofType(data.events, 'two_ai.interjection').filter((i) => i.stage === 'onset').map((i) => i.interjection_id));
  for (const id of ids) if (episodes.filter((e) => e.interjection_id === id).length !== 1) problems.push(`${id} の episode が 1 件でない`);
  // 話し合いの停止だけ（intake の本人の割り込みで AI の定型が止まるのは 1 対 1 と同じ順番取りで、episode を作らない。§4.4 は話し合いの割り込み）。
  const stops = ofType(data.events, 'speech.interrupted').filter((s) => (s.decision_source === 'vap' || s.decision_source === 'fallback') && phaseOf(s) === 'discussion').length;
  const stopEpisodes = episodes.filter((e) => (e.outcome === 'yielded' || e.outcome === 'backchannel' || e.outcome === 'false_onset') && mval(e.stop_requested_at) !== null && mval(e.stopped_at) !== null).length;
  if (stops !== stopEpisodes) problems.push(`vap/fallback の停止 ${stops} 件と停止を伴う episode ${stopEpisodes} 件が違う`);
  for (const e of episodes.filter((x) => x.outcome === 'false_onset')) {
    if (e.ack !== null) problems.push(`${e.interjection_id}: false_onset に受け止め`);
    const resume = twoAiSpeech(data.events, 'finished').find((s) => s.turn_kind === 'resume' && s.t_monotonic_ms > e.onset_at);
    const bridge = data.config?.fixed.bridge;
    if (resume && bridge && spokenText(resume).startsWith(bridge)) problems.push(`${e.interjection_id}: false_onset の後の resume に戻りの句`);
  }
  if (condition(data) === 'respond_on_spot' && episodes.some((e) => e.outcome === 'onset_no_speech')) problems.push('① に onset_no_speech');
  const counts = ['yielded', 'backchannel', 'false_onset', 'onset_no_speech', 'logged_only', 'abandoned'].map((o) => `${o} ${episodes.filter((e) => e.outcome === o).length}`).join('、');
  return row('AC9', problems, counts);
}

/** AC11：証拠の区分（情報）。 */
function ac11(data: TwoAiSessionData): AcceptanceRow {
  const providers = (data.manifest?.providers ?? {}) as Record<string, { provider_class?: string }>;
  const nonProd = Object.entries(providers).filter(([, p]) => p.provider_class !== 'production').map(([k, p]) => `${k}=${p.provider_class}`);
  return { id: 'AC11', ok: null, detail: nonProd.length === 0 ? '本番のプロバイダ' : `受け入れの証拠に数えない（${nonProd.join('、')}）` };
}

/** AC12：体験の旗の区別。 */
function ac12(data: TwoAiSessionData): AcceptanceRow {
  const problems: string[] = [];
  const m = data.two_ai;
  const fed = ofType(data.events, 'two_ai.interjection_fed');
  const gens = ofType(data.events, 'two_ai.generation');
  if (m !== null) {
    const flag = m.experience.interjection_feeds_generation;
    if (flag.effective !== (flag.requested && m.condition === 'respond_on_spot')) problems.push('(a) effective が requested && ① と違う');
    if (m.exploratory !== flag.effective) problems.push('exploratory と effective が違う');
    if (!flag.effective) {
      if (fed.length > 0) problems.push(`(b) 旗が無効なのに interjection_fed ${fed.length} 件`);
      if (gens.some((g) => g.fed_interjection_ids.length > 0 || g.feed_turn)) problems.push('(b) 旗が無効なのに生成に本人の発言');
      if (gens.some((g) => g.c_ban_lifted)) problems.push('(b) 旗が無効なのに c_ban_lifted');
    } else if (m.evidence_ok_for_comparison) problems.push('(c) 探索のセッションなのに evidence_ok_for_comparison が true');
  } else if (fed.length > 0) {
    problems.push('manifest がなく、interjection_fed がある');
  }
  return row('AC12', problems, m === null ? 'manifest なし' : m.exploratory ? '探索（①′）' : '旗は無効');
}

/** AC13：計画の待ち。 */
function ac13(data: TwoAiSessionData): AcceptanceRow {
  const waits = ofType(data.events, 'two_ai.plan_wait');
  if (waits.length === 0) return { id: 'AC13', ok: true, detail: '待ちなし' };
  const problems: string[] = [];
  const maxWait = data.config?.phases.plan_wait.max_wait_ms ?? null;
  const longest = Math.max(...waits.map((w) => w.waited_ms));
  if (maxWait !== null && longest > maxWait + 1000) problems.push(`(a) 待ち ${longest}ms が上限 ${maxWait}ms ＋ 1 秒を超えた`);
  const fillers = data.config?.fixed.lines.plan_fillers ?? null;
  if (fillers !== null) {
    for (const s of twoAiSpeech(data.events, 'finished').filter((x) => x.turn_kind === 'filler')) {
      if (!fillers.includes(spokenText(s)) && !s.event.endsWith('interrupted')) problems.push(`(b) つなぎの文が plan_fillers と違う`);
    }
  }
  const fallback = waits.some((w) => w.stage === 'fallback_used');
  if (fallback && data.two_ai?.evidence_ok_for_comparison === true) problems.push('(c) 代わりの計画なのに evidence_ok_for_comparison が true');
  return row('AC13', problems, `待ち最大 ${longest}ms${fallback ? '、代わりの計画' : ''}`);
}

/** AC15：4 段と見出し。 */
function ac15(data: TwoAiSessionData): AcceptanceRow {
  const stages = ofType(data.events, 'two_ai.stage');
  const reached = ofType(data.events, 'two_ai.phase_changed').some((p) => p.to === 'response');
  const problems: string[] = [];
  const started = stages.filter((s) => s.edge === 'started').map((s) => s.discussion_stage);
  const ended = stages.filter((s) => s.edge === 'ended').map((s) => s.discussion_stage);
  if (reached) {
    if (started.join() !== '1,2,3,4') problems.push(`(a) started の順 ${started.join(',')}`);
    if (ended.join() !== '1,2,3,4') problems.push(`(a) ended の順 ${ended.join(',')}`);
  }
  const headings = data.script?.stages ?? data.config?.fixed.stage_headings ?? null;
  for (const s of stages) {
    if (headings !== null && s.heading !== headings[s.discussion_stage - 1]) problems.push(`(b) 段 ${s.discussion_stage} の見出しが台本と違う`);
  }
  if (headings !== null && data.two_ai !== null && !sameHash(data.two_ai.stage_headings_sha256, sha256(headings.join('\n')))) {
    // ハッシュの作り方は WP1 の実装に依るので、違っても警告にとどめる（要約の warnings）。
  }
  // (d) 封筒の discussion_stage
  let current: number | null = null;
  for (const e of data.emitted ?? data.events) {
    if (e.event === 'two_ai.stage') {
      current = e.edge === 'started' ? e.discussion_stage : current;
      continue;
    }
    if (phaseOf(e) !== 'discussion' || current === null) continue;
    const env = e.two_ai?.discussion_stage ?? null;
    if (env !== null && env !== current) problems.push(`(d) ${e.event}@${Math.round(e.t_monotonic_ms)} の封筒の段 ${env}（現在 ${current}）`);
  }
  // (e) 核の読み上げ
  const lines = data.config?.fixed.lines;
  if (lines !== undefined) {
    const pattern = new RegExp(`^${lines.core_readback.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{core\\}', '.+')}$`);
    const readbacks = twoAiSpeech(data.events, 'finished').filter((s) => s.turn_kind === 'facilitation' && (pattern.test(spokenText(s)) || spokenText(s) === lines.core_readback_no_core));
    const reachedDiscussion = ofType(data.events, 'two_ai.phase_changed').some((p) => p.to === 'discussion');
    if (reachedDiscussion && readbacks.length !== 1) problems.push(`(e) 核の読み上げ ${readbacks.length} 回`);
  }
  return row('AC15', problems, `段 ${started.join(',')}`);
}

/** AC16：候補の板。 */
function ac16(data: TwoAiSessionData): AcceptanceRow {
  const boards = ofType(data.events, 'two_ai.board');
  const reached = ofType(data.events, 'two_ai.phase_changed').some((p) => p.to === 'response');
  const problems: string[] = [];
  const shown = boards.filter((b) => b.reason === 'shown' && phaseOf(b) === 'discussion');
  const turns = turnStarts(data.events);
  const firstShow = new Map<string, number>();
  for (const b of shown) {
    const newCards = b.cards.filter((c) => !firstShow.has(c.card_id));
    for (const c of newCards) firstShow.set(c.card_id, c.order);
    if (b.trigger_turn_id !== null) {
      const t = turns.find((x) => x.turn_id === b.trigger_turn_id);
      if (t === undefined) problems.push(`(b) カードのターン ${b.trigger_turn_id} が始まっていない`);
      else if (Math.abs(t.t_monotonic_ms - b.t_monotonic_ms) > 20) problems.push(`(b) カードとターンの開始の差 ${Math.round(Math.abs(t.t_monotonic_ms - b.t_monotonic_ms))}ms`);
    }
  }
  const orders = [...firstShow.values()];
  if (reached && orders.join() !== '1,2,3,4') problems.push(`(a) カードの順 ${orders.join(',')}`);
  const rebuilt = boards.filter((b) => b.mode === 'rebuilt');
  if (reached && rebuilt.length === 0 && ofType(data.events, 'two_ai.phase_changed').some((p) => p.to === 'next_step')) problems.push('(d) 作り直しの板がない');
  for (const b of rebuilt) {
    if (b.cards.length !== 4 || b.cards.some((c) => c.variant !== 'corrected')) problems.push('(d) 作り直しの板が訂正後の 4 枚でない');
    // 予備の筋書きの板は汎用の 4 枚（02 §6 の表）。台本と比べるのは台本の計画のときだけ。
    const script = data.two_ai?.plan_source === 'fallback_outline' ? null : data.script?.board;
    if (script) for (const c of b.cards) if (script.find((s) => s.card_id === c.card_id)?.corrected_text !== c.text) problems.push(`(d) 作り直しの ${c.card_id} の文が台本と違う`);
  }
  return row('AC16', problems, `カード ${orders.length} 枚、作り直し ${rebuilt.length > 0 ? 'あり' : 'なし'}`);
}

/** AC17：印のボタン。 */
function ac17(data: TwoAiSessionData): AcceptanceRow {
  const markers = ofType(data.events, 'two_ai.marker');
  const problems: string[] = [];
  const interrupts = ofType(data.events, 'speech.interrupted');
  const onsets = ofType(data.events, 'two_ai.interjection').filter((i) => i.stage === 'onset').map((i) => i.t_monotonic_ms);
  const woz = ofType(data.events, 'woz.override').map((w) => w.t_monotonic_ms);
  for (const m of markers) {
    const t = m.t_monotonic_ms;
    const stops = interrupts.filter((s) => s.interrupted_at >= t && s.interrupted_at - t <= 1000);
    const explained = [...onsets, ...woz].some((x) => Math.abs(x - t) <= 1000 || (x >= t && x <= t + 1000));
    if (stops.length > 0 && !explained) problems.push(`(b) 印 ${m.marker_id} の後 1 秒以内に停止`);
  }
  const minInterval = data.config?.marker.min_interval_ms ?? null;
  if (minInterval !== null) {
    let lastCounted: number | null = null;
    for (const m of markers) {
      const due = lastCounted === null || m.t_monotonic_ms - lastCounted >= minInterval;
      if (m.counted !== due) problems.push(`(d) 印 ${m.marker_id} の counted が ${m.counted}（間隔の規則では ${due}）`);
      if (m.counted) lastCounted = m.t_monotonic_ms;
    }
  }
  const nearWindow = data.config?.marker.near_window_ms ?? null;
  if (nearWindow !== null) {
    for (const ep of ofType(data.events, 'two_ai.interjection_episode')) {
      const near = markers.some((m) => Math.abs(m.t_monotonic_ms - ep.onset_at) <= nearWindow);
      if (near !== ep.near_marker) problems.push(`(e) ${ep.interjection_id} の near_marker が ${ep.near_marker}（印との距離では ${near}）`);
    }
  }
  const orchestratorBasis = [...markers, ...ofType(data.events, 'two_ai.board_picked').filter((p) => p.outcome !== 'timeout')].filter((m) => m.time_basis.source !== 'browser_rtt').length;
  return row('AC17', problems, `印 ${markers.length} 件（数えた ${markers.filter((m) => m.counted).length}）${orchestratorBasis > 0 ? `、時計差なし ${orchestratorBasis} 件` : ''}`);
}

/** AC18：最後の段が両条件で同一（1 本のログで見られる分）。 */
function ac18(data: TwoAiSessionData): AcceptanceRow {
  const reachedNext = ofType(data.events, 'two_ai.phase_changed').some((p) => p.to === 'next_step');
  if (!reachedNext) return { id: 'AC18', ok: null, detail: 'next_step に届いていない' };
  const problems: string[] = [];
  const picks = ofType(data.events, 'two_ai.board_picked').filter((p) => p.outcome === 'picked' || p.outcome === 'timeout');
  if (picks.length !== 1) problems.push(`(e) picked/timeout が ${picks.length} 件`);
  const rebuild = twoAiSpeech(data.events, 'finished').filter((s) => s.turn_kind === 'rebuild');
  // 予備の筋書きの作り直しは汎用の文（02 §3.2-6）。台本と比べるのは台本の計画のときだけ。
  const scripted = data.two_ai?.plan_source === 'fallback_outline' ? null : data.script?.rebuild_turns;
  if (scripted) {
    const texts = rebuild.map((s) => spokenText(s));
    if (texts.join('\n') !== scripted.map((t) => t.text).join('\n')) problems.push('(d) 作り直しの文が台本と違う');
  } else if (rebuild.length === 0) problems.push('(d) 作り直しの発話がない');
  const q = ofType(data.events, 'two_ai.response_window')[0];
  return row('AC18', problems, `問い ${q?.question_played_ms ?? '?'}ms、選択 ${picks[0]?.outcome ?? 'なし'}`);
}

/** AC19：同期の印。 */
function ac19(data: TwoAiSessionData): AcceptanceRow {
  const marks = ofType(data.events, 'two_ai.sync_mark');
  const problems: string[] = [];
  marks.forEach((m, i) => {
    if (m.seq !== i + 1) problems.push(`seq ${m.seq} が ${i + 1} でない`);
  });
  const triggers = marks.map((m) => m.trigger);
  if (new Set(triggers).size !== triggers.length) problems.push(`trigger が重複: ${triggers.join(',')}`);
  const ended = ofType(data.events, 'two_ai.phase_changed').some((p) => p.to === 'end');
  const aborted = ofType(data.events, 'woz.override').some((w) => w.action === 'abort' || w.action === 'advance_phase');
  const full = ['intake', 'stage_1', 'stage_2', 'stage_3', 'stage_4', 'response', 'next_step', 'end'];
  if (ended && !aborted && triggers.join() !== full.join()) problems.push(`8 回の印でない: ${triggers.join(',')}`);
  return row('AC19', problems, `同期の印 ${marks.length} 回`);
}

/** AC20：当日の撤回。 */
function ac20(data: TwoAiSessionData): AcceptanceRow {
  const r = ofType(data.events, 'two_ai.retraction');
  const ended = ofType(data.events, 'two_ai.phase_changed').some((p) => p.to === 'end');
  if (!ended && r.length === 0) return { id: 'AC20', ok: null, detail: 'end に届いていない' };
  const problems: string[] = [];
  if (r.length !== 1) problems.push(`(a) retraction が ${r.length} 件`);
  const ev = r[0];
  const speeches = twoAiSpeech(data.events, 'finished').filter((s) => s.turn_kind === 'retraction');
  if (ev !== undefined) {
    const selfRun = data.two_ai?.self_run ?? null;
    if (selfRun === false && ev.timing !== 'after_measures') problems.push('(b) 研究のセッションなのに after_measures でない');
    if (ev.timing === 'after_measures' && ev.trigger === 'end' && speeches.length > 0) problems.push('(b) after_measures なのに撤回の発話がある');
    if ((ev.timing === 'end_of_session' || ev.trigger === 'aborted') && speeches.length === 0) problems.push('(c)(d) 撤回の発話がない');
    if (ev.lines.length === 0) problems.push('(e) lines が空');
    else if (!sameHash(ev.script_sha256, sha256(ev.lines.map((l) => l.text).join('\n')))) problems.push('(e) lines のハッシュが script_sha256 と違う');
    if (speeches.length > 0) {
      const spoken = speeches.map((s) => spokenText(s)).join('');
      if (spoken !== ev.lines.map((l) => l.text).join('')) problems.push('(e) 撤回の発話の文が lines と違う');
    }
    if (data.two_ai?.retraction.script_sha256 && data.two_ai.retraction.script_sha256 !== ev.script_sha256) problems.push('(e) manifest の script_sha256 が違う');
    // (f)
    const fact = ofType(data.events, 'two_ai.point_exposure').find((p) => p.point_kind === 'fact_slip');
    const unavailable = ofType(data.events, 'two_ai.point').some((p) => p.point_kind === 'fact_slip' && p.stage === 'unavailable');
    let expected: 'spoken' | 'not_spoken' | 'none' | null = null;
    if (unavailable) expected = 'none';
    else if (fact !== undefined) {
      const original = fact.segments.filter((s) => s.variant === 'original' && s.turn_kind === 'point_elaboration').reduce((sum, s) => sum + s.played_ms, 0);
      expected = original > 0 ? 'spoken' : 'not_spoken';
    }
    if (expected !== null && ev.inference_form !== expected) problems.push(`(f) inference_form ${ev.inference_form}（記録からは ${expected}）`);
    if (expected === 'none' && ev.lines.length !== 1) problems.push('(b) fact_slip がない回の撤回は過程の 1 文');
  }
  return row('AC20', problems, ev ? `${ev.timing}、${ev.inference_form}、${ev.lines.length} 行` : '');
}

export interface AcceptanceResult {
  rows: AcceptanceRow[];
  failures: string[];
}

/** 2 体のセッションの自動の検査をすべて回す。 */
export function checkTwoAiAcceptance(data: TwoAiSessionData): AcceptanceResult {
  const rows: AcceptanceRow[] = [
    checkEnvelope(data),
    ac1(data),
    ac2(data),
    ac3(data),
    ac4(data),
    ac5(data),
    ac6(data),
    ac7(data),
    ...ac8and14(data),
    ac9(data),
    { id: 'AC10', ok: null, detail: '既存の test:all と test:e2e（このログでは見ない）' },
    ac11(data),
    ac12(data),
    ac13(data),
    ac15(data),
    ac16(data),
    ac17(data),
    ac18(data),
    ac19(data),
    ac20(data),
    { id: 'AC21', ok: null, detail: '--coding の書き出しで確かめる' },
    { id: 'manual', ok: null, detail: '向き合って見えるか、受け止めの感じ、C の中身（手動）' },
  ].sort((a, b) => order(a.id) - order(b.id));
  if (data.two_ai === null) rows.unshift({ id: 'manifest', ok: data.two_ai_error === null ? null : false, detail: data.two_ai_error ?? 'manifest に two_ai がない' });
  const failures = rows.filter((r) => r.ok === false).map((r) => `${r.id}: ${r.detail}`);
  return { rows, failures };
}

function order(id: string): number {
  if (id === 'manifest') return -2;
  if (id === 'envelope') return -1;
  const m = /^AC(\d+)$/.exec(id);
  return m ? Number(m[1]) : 100;
}

/** 2 本（① と ②）を並べて見る基準（AC2(d)、AC5(d)、AC6(e)(f)、AC8、AC15(b)(c)、AC16(c)(d)、AC18）。 */
export function checkPair(a: TwoAiSessionData, b: TwoAiSessionData): AcceptanceRow[] {
  const rows: AcceptanceRow[] = [];
  const exp = (d: TwoAiSessionData) => new Map(ofType(d.events, 'two_ai.point_exposure').map((p) => [p.point_id, p]));
  const ea = exp(a);
  const eb = exp(b);
  const p2: string[] = [];
  for (const [id, x] of ea) {
    if (x.point_kind === 'fact_slip') continue;
    const y = eb.get(id);
    if (y === undefined) continue;
    const diff = Math.abs(x.exposure_new_ms - y.exposure_new_ms);
    if (diff > 3000 && diff > 0.1 * Math.max(x.exposure_new_ms, y.exposure_new_ms)) p2.push(`${id}: 新しい部分の差 ${diff}ms`);
  }
  rows.push(row('AC2(d)', p2, 'C と対照の推論の新しい部分の差が 10% か 3 秒以内'));
  const beats = (d: TwoAiSessionData) =>
    ofType(d.events, 'two_ai.point').filter((p) => p.stage === 'started').map((p) => [p.point_id, beatsBeforePoint(d.events, p.turn_id ?? '')] as const);
  const ba = new Map(beats(a));
  const p8: string[] = [];
  for (const [id, x] of beats(b)) {
    const y = ba.get(id);
    if (y && (y.stage !== x.stage || y.beats !== x.beats)) p8.push(`${id}: 拍が違う`);
  }
  rows.push(row('AC8(pair)', p8, '各点の開始の拍が同じ'));
  const heads = (d: TwoAiSessionData) => ofType(d.events, 'two_ai.stage').filter((s) => s.edge === 'started').map((s) => s.heading).join('|');
  rows.push(row('AC15(b)', heads(a) === heads(b) ? [] : ['見出しが違う'], '見出しが同じ'));
  const rw = (d: TwoAiSessionData) => ofType(d.events, 'two_ai.response_window')[0];
  const wa = rw(a);
  const wb = rw(b);
  const p6: string[] = [];
  if (wa && wb) {
    if (wa.planned_ms !== wb.planned_ms) p6.push('(f) planned_ms が違う');
    const tol = a.config?.acknowledgment.duration_tolerance_ms ?? ACK_TOLERANCE_MS_DEFAULT;
    if (Math.abs(wa.question_played_ms - wb.question_played_ms) > tol) p6.push('AC18(a) 問いの長さが違う');
  }
  rows.push(row('AC6(f)/AC18(a)', p6, '応答の時間と問いの長さが同じ'));
  const rebuildText = (d: TwoAiSessionData) => twoAiSpeech(d.events, 'finished').filter((s) => s.turn_kind === 'rebuild').map(spokenText).join('\n');
  const rebuiltCards = (d: TwoAiSessionData) => JSON.stringify(ofType(d.events, 'two_ai.board').filter((x) => x.mode === 'rebuilt').at(-1)?.cards.map((c) => c.text) ?? []);
  rows.push(row('AC16(d)/AC18(d)', rebuildText(a) === rebuildText(b) && rebuiltCards(a) === rebuiltCards(b) ? [] : ['作り直しの文か板が違う'], '作り直しの文と板が同じ'));
  return rows;
}

/** AC5(d)：② の本人が話す試走と黙る試走で、AI のターンの順序・文・開始時刻（±50 ms）が同じ。 */
export function checkSilentIdentity(speaking: TwoAiSessionData, silent: TwoAiSessionData): AcceptanceRow {
  const seq = (d: TwoAiSessionData) => twoAiSpeech(d.events, 'finished').filter((s) => phaseOf(s) === 'discussion').map((s) => ({ ai: s.ai_id, kind: s.turn_kind, text: spokenText(s), at: (s as { started_at: number }).started_at }));
  const x = seq(speaking);
  const y = seq(silent);
  const problems: string[] = [];
  if (x.length !== y.length) problems.push(`発話の数 ${x.length} と ${y.length}`);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i]!;
    const q = y[i]!;
    if (p.ai !== q.ai || p.kind !== q.kind || p.text !== q.text) problems.push(`${i} 番目の発話が違う`);
    else if (p.kind !== 'ack' && Math.abs(p.at - q.at) > 50) problems.push(`${i} 番目の開始の差 ${Math.round(Math.abs(p.at - q.at))}ms`);
  }
  return row('AC5(d)', problems, `discussion の発話 ${x.length} 件が同じ順・文・時刻`);
}

export { CONTENT_KINDS };
