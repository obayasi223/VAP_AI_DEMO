/**
 * 発話希望の遅延の段（修正2、known_gaps §11）。ASR → 判定 → 候補 → 合図 → 描画の各段の分布を出す。
 *
 * 判定1回（initiative の llm.request）ごとに、起動の元になった STT（同じ transcript_revision）をたどる。
 * 測れない段（検証の材料がない、時計が補正されていない）は 0 にせず unmeasured と理由を返す。
 * `computeLatencyReport`（候補ごとの t_content_evidence からの連鎖）とは別の切り方で、NONE を含む全判定を見る。
 *
 * 段:
 *   audio_to_asr         起動の revision の audio_frame_end（元の音声の時刻）→ その STT の受信
 *   asr_stable_wait      その STT の stable_text の全文字が STT の本文に初めて揃った時刻 → 受信（安定の待ちの近似）
 *   asr_to_trigger       STT の受信 → 判定の送信（llm.request の sent_at）
 *   trigger_to_response  判定の送信 → LLM の応答の受信
 *   trigger_to_first_text 判定の送信 → 応答の本文の最初の断片（古いログにはない）
 *   response_to_record   LLM の応答の受信 → 候補の記録（NEW の candidate.state_changed）
 *   record_to_cue_sent   候補の記録 → 合図の送信（signal.sent の吸気）
 *   cue_sent_to_render   合図の送信 → 最初の描画（signal.started、補正済みの時計だけ）
 *   audio_to_cue_sent    元の音声 → 合図の送信（全体）
 *   audio_to_render      元の音声 → 最初の描画（全体）
 *   tts_prepare          候補の音声の準備の開始 → 準備完了（negotiation.decision の candidate_audio）
 *   cue_sent_to_audio_ready 合図の送信 → 候補の音声の準備完了（負なら音声が先に完成）
 */
import type { EventOf, ResearchEvent } from '@llm-vap/contracts';
import { buildFrameClock, latencyStat, type LatencyRow, type LatencySample } from './latency';
import { normalizeForMatch } from './text';

type Stt = EventOf<'stt.interim'> | EventOf<'stt.final'>;

export type JudgementTrigger = 'final' | 'interim' | 'unknown';

export interface InitiativeChainReport {
  rows: LatencyRow[];
  judgements: {
    total: number;
    by_trigger: Record<JudgementTrigger, number>;
    /** 判定の結果。NONE／NEW／KEEP／REVISE／WITHDRAW は initiative.decision、それ以外は棄却の理由。 */
    outcomes: Record<string, number>;
  };
}

class Stage {
  readonly samples: LatencySample[] = [];
  readonly excluded: Record<string, number> = {};

  add(from: number | null | undefined, to: number | null | undefined, uncertainty_ms: number | null = 0): void {
    if (from === null || from === undefined || to === null || to === undefined) return;
    this.samples.push({ ms: to - from, uncertainty_ms });
  }

  exclude(reason: string): void {
    this.excluded[reason] = (this.excluded[reason] ?? 0) + 1;
  }
}

const isStt = (event: ResearchEvent): event is Stt => event.event === 'stt.interim' || event.event === 'stt.final';

/** stable_text の全文字（正規化後）が同じ ASR 区間の本文に初めて揃った STT の受信時刻。 */
function stableFirstSeen(stt: readonly Stt[], target: Stt): number | null {
  const stable = normalizeForMatch(target.stable_text);
  if (stable.length === 0) return null;
  for (const event of stt) {
    if (event.asr_segment_id !== target.asr_segment_id) continue;
    if (event.t_monotonic_ms > target.t_monotonic_ms) break;
    if (normalizeForMatch(event.text).startsWith(stable)) return event.t_monotonic_ms;
  }
  return null;
}

const INTENT_STAGES = ['audio_to_asr', 'asr_stable_wait', 'asr_to_trigger', 'trigger_to_response', 'trigger_to_first_text'] as const;

export function computeInitiativeChain(events: readonly ResearchEvent[]): InitiativeChainReport {
  const stt = events.filter(isStt).sort((a, b) => a.t_monotonic_ms - b.t_monotonic_ms);
  const sttByRevision = new Map<number, Stt>();
  for (const event of stt) if (!sttByRevision.has(event.transcript_revision)) sttByRevision.set(event.transcript_revision, event);

  const frameClock = buildFrameClock(events);
  const responses = new Map<string, EventOf<'llm.response'>>();
  const decisions = new Map<string, EventOf<'initiative.decision'>>();
  const stateChanges: EventOf<'candidate.state_changed'>[] = [];
  const firstCue = new Map<string, EventOf<'signal.sent'>>();
  const firstRender = new Map<string, EventOf<'signal.started'>>();
  const audio = new Map<string, { preparing?: number; ready?: number }>();
  const rejected: Record<string, number> = {};
  const discardedByRevision = new Map<number, string>();

  for (const event of events) {
    switch (event.event) {
      case 'llm.response':
        if (event.purpose === 'initiative') responses.set(event.request_id, event);
        break;
      case 'initiative.decision':
        decisions.set(event.request_id, event);
        break;
      case 'initiative.discarded':
        if (!discardedByRevision.has(event.input_transcript_revision)) discardedByRevision.set(event.input_transcript_revision, event.reason);
        break;
      case 'candidate.state_changed':
        if (event.from === null && event.cause_source === 'model_decision') stateChanges.push(event);
        break;
      case 'signal.sent':
        if (event.phase === 'inhale' && !firstCue.has(event.candidate_id)) firstCue.set(event.candidate_id, event);
        break;
      case 'signal.started':
        if (event.phase === 'inhale' && !firstRender.has(event.candidate_id)) firstRender.set(event.candidate_id, event);
        break;
      case 'negotiation.decision': {
        if (event.stage !== 'candidate_audio' || event.candidate_id.value === null) break;
        const key = `${event.candidate_id.value}@${event.candidate_version.value}`;
        const entry = audio.get(key) ?? {};
        if (event.outcome === 'audio_preparing' && entry.preparing === undefined) entry.preparing = event.t_monotonic_ms;
        if (event.outcome === 'audio_ready' && entry.ready === undefined) entry.ready = event.t_monotonic_ms;
        audio.set(key, entry);
        break;
      }
      default:
        break;
    }
  }

  const stageFor = new Map<string, Stage>();
  const stage = (id: string, trigger: JudgementTrigger | null): Stage => {
    const key = `${id}|${trigger ?? 'all'}`;
    let found = stageFor.get(key);
    if (!found) {
      found = new Stage();
      stageFor.set(key, found);
    }
    return found;
  };

  const requests = events.filter((e): e is EventOf<'llm.request'> => e.event === 'llm.request' && e.purpose === 'initiative');
  const by_trigger: Record<JudgementTrigger, number> = { final: 0, interim: 0, unknown: 0 };
  const outcomes: Record<string, number> = {};

  for (const request of requests) {
    const source = sttByRevision.get(request.transcript_revision);
    const trigger: JudgementTrigger = source === undefined ? 'unknown' : source.event === 'stt.final' ? 'final' : 'interim';
    by_trigger[trigger] += 1;

    const decision = decisions.get(request.request_id);
    const outcome =
      decision?.decision ??
      (discardedByRevision.has(request.transcript_revision) ? `discarded:${(discardedByRevision.get(request.transcript_revision) as string).split(':').slice(0, 2).join(':')}` : 'no_result');
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;

    for (const scope of [null, trigger] as const) {
      const row = <T extends typeof INTENT_STAGES[number]>(id: T) => stage(id, scope);
      if (source !== undefined) {
        const mapped = frameClock.toMs(source.audio_frame_end);
        if ('reason' in mapped) row('audio_to_asr').exclude(mapped.reason);
        else row('audio_to_asr').add(mapped.t_ms, source.t_monotonic_ms, mapped.uncertainty_ms);
        const first = stableFirstSeen(stt, source);
        if (first === null) row('asr_stable_wait').exclude('no_stable_text');
        else row('asr_stable_wait').add(first, source.t_monotonic_ms);
        row('asr_to_trigger').add(source.t_monotonic_ms, request.sent_at);
      } else {
        for (const id of ['audio_to_asr', 'asr_stable_wait', 'asr_to_trigger'] as const) row(id).exclude('stt_revision_missing');
      }
      const response = responses.get(request.request_id);
      if (response === undefined) row('trigger_to_response').exclude('llm_response_missing');
      else if (response.output.value === null) row('trigger_to_response').exclude('llm_failed');
      else {
        row('trigger_to_response').add(response.sent_at, response.received_at);
        if (response.first_text_at !== undefined) row('trigger_to_first_text').add(response.sent_at, response.first_text_at);
        else row('trigger_to_first_text').exclude('first_text_at_not_in_log');
      }
    }
  }

  // 候補の段（NEW の後）。
  for (const change of stateChanges) {
    if (change.cause_source !== 'model_decision' || change.decision !== 'NEW') continue;
    const response = responses.get(change.request_id);
    const decision = decisions.get(change.request_id);
    if (response !== undefined) stage('response_to_record', null).add(response.received_at, change.t_monotonic_ms);
    const decided_at = decision !== undefined && 'decided_at' in decision ? decision.decided_at : change.t_monotonic_ms;
    const cue = firstCue.get(change.candidate_id);
    if (cue === undefined) {
      stage('record_to_cue_sent', null).exclude('no_signal_sent');
      continue;
    }
    stage('record_to_cue_sent', null).add(decided_at, cue.sent_at);
    const started = firstRender.get(change.candidate_id);
    if (started === undefined) stage('cue_sent_to_render', null).exclude('no_signal_started');
    else if (!started.visible) stage('cue_sent_to_render', null).exclude('signal_not_visible');
    else if (started.time_basis.source !== 'browser_rtt') stage('cue_sent_to_render', null).exclude('endpoint_clock_uncorrected');
    else stage('cue_sent_to_render', null).add(cue.sent_at, started.started_at, started.time_basis.uncertainty_ms.value);

    // 全体。起動の元の音声から。
    const request = requests.find((r) => r.request_id === change.request_id);
    const source = request ? sttByRevision.get(request.transcript_revision) : undefined;
    if (source !== undefined) {
      const mapped = frameClock.toMs(source.audio_frame_end);
      if (!('reason' in mapped)) {
        stage('audio_to_cue_sent', null).add(mapped.t_ms, cue.sent_at, mapped.uncertainty_ms);
        if (started !== undefined && started.visible && started.time_basis.source === 'browser_rtt') {
          stage('audio_to_render', null).add(mapped.t_ms, started.started_at, mapped.uncertainty_ms);
        }
      }
    }
    const audioEntry = audio.get(`${change.candidate_id}@${change.candidate_version}`);
    if (audioEntry?.ready !== undefined) stage('cue_sent_to_audio_ready', null).add(cue.sent_at, audioEntry.ready);
  }
  for (const entry of audio.values()) {
    if (entry.preparing !== undefined && entry.ready !== undefined) stage('tts_prepare', null).add(entry.preparing, entry.ready);
  }

  // 主な棄却の件数は outcomes に含まれない理由もあるので、candidate.rejected を別に集める。
  for (const event of events) {
    if (event.event === 'candidate.rejected') {
      const key = `${event.reason}${event.details[0] && !event.details[0].includes('=') ? `:${event.details[0]}` : ''}`;
      rejected[key] = (rejected[key] ?? 0) + 1;
    }
  }
  for (const [reason, n] of Object.entries(rejected)) outcomes[`candidate.rejected:${reason}`] = n;

  const CHAIN_IDS = [
    'audio_to_asr',
    'asr_stable_wait',
    'asr_to_trigger',
    'trigger_to_response',
    'trigger_to_first_text',
    'response_to_record',
    'record_to_cue_sent',
    'cue_sent_to_render',
    'audio_to_cue_sent',
    'audio_to_render',
    'tts_prepare',
    'cue_sent_to_audio_ready',
  ] as const;
  const rows: LatencyRow[] = [];
  for (const id of CHAIN_IDS) {
    const scopes: (JudgementTrigger | null)[] = (INTENT_STAGES as readonly string[]).includes(id) ? [null, 'final', 'interim', 'unknown'] : [null];
    for (const scope of scopes) {
      const s = stageFor.get(`${id}|${scope ?? 'all'}`);
      if (scope !== null && s === undefined) continue; // 種類ごとの行は標本があるときだけ。
      const data = s ?? new Stage();
      rows.push({
        id,
        from: 'see_initiative_chain_ts',
        to: id,
        group: 'chain',
        breakdown: scope === null ? null : `trigger:${scope}`,
        stat: latencyStat(data.samples, data.excluded, scope === null ? 'no_samples_in_log' : `no_${scope}_trigger_samples`),
      });
    }
  }
  return { rows, judgements: { total: requests.length, by_trigger, outcomes } };
}

export function isInitiativeChainRelevant(event: ResearchEvent): boolean {
  switch (event.event) {
    case 'stt.interim':
    case 'stt.final':
    case 'llm.request':
    case 'llm.response':
    case 'initiative.decision':
    case 'initiative.discarded':
    case 'candidate.state_changed':
    case 'candidate.rejected':
    case 'signal.sent':
    case 'signal.started':
    case 'negotiation.decision':
      return true;
    case 'audio.health':
      return event.reporter === 'browser';
    default:
      return false;
  }
}
