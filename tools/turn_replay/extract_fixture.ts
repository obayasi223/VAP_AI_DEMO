/**
 * 実セッションの events.jsonl から、TurnManager の再生に要る最小限を抜き出す（docs/known_gaps.md §10）。
 *
 *   npx tsx tools/turn_replay/extract_fixture.ts sessions/<id>/events.jsonl fixtures/turn_replay/<id>.json
 *
 * 利用者の発話文は書き出さない。残すのは時刻、VAP の値（vad と AI 側の p）、STT の結果ごとの
 * 正規化後の文字数と、その時点の文で求めた ja_rules_v1 の p（推定器は文から決まるので、ここで計算して残す）、
 * AI の発話の開始と終わりの時刻、準備の遅れ（prefetch.started から ready まで）だけ。
 * AI の発話文も残さない（推定器の「直前の AI の発話が質問か」はここで評価済み）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { scoreJaRules } from '../../apps/orchestrator/src/cognition/completion/ja_rules';
import { normalizeForSimilarity } from '../../apps/orchestrator/src/cognition/similarity';

type Event = Record<string, unknown> & { event: string; t_monotonic_ms: number };

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  console.error('usage: extract_fixture.ts <events.jsonl> <out.json>');
  process.exit(2);
}

const events = readFileSync(input, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as Event);

const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;
const ms = (x: number) => Math.round(x * 10) / 10;

const history: { role: 'assistant'; text: string }[] = [];
/** segment ごとの ASR 区間の文（積み上げ。TurnManager の userTextFor と同じ規則）。 */
const segments = new Map<number, { asr: number; closed: string; current: string }>();

const vap: number[][] = [];
const stt: unknown[] = [];
const speech: { audio_playback_id: number; started_ms: number; ended_ms: number | null; audio_frame_start: number }[] = [];
const prefetchStarted = new Map<number, number>();
const prefetchLatencyMs: number[] = [];
/** 実際に準備した revision（再生で同じ revision から準備するため）と、その準備の遅れ。 */
const prepares: { segment_id: number; transcript_revision: number; started_ms: number; latency_ms: number | null }[] = [];
let sessionId = '';
let policyId = '';

for (const e of events) {
  sessionId ||= String(e.session_id ?? '');
  const t = e.t_monotonic_ms;
  switch (e.event) {
    case 'vap.state': {
      const vad = e.vad as [number, number];
      const pNow = e.p_now as [number, number];
      const pFut = e.p_future as [number, number];
      vap.push([ms(t), e.audio_frame as number, round(vad[0]), round(vad[1]), round(pNow[1]), round(pFut[1])]);
      break;
    }
    case 'stt.interim':
    case 'stt.final': {
      const seg = e.segment_id as number;
      const asr = e.asr_segment_id as number;
      const text = e.text as string;
      const prev = segments.get(seg);
      const buf =
        prev === undefined
          ? { asr, closed: '', current: text }
          : prev.asr !== asr
            ? { asr, closed: prev.closed + prev.current, current: text }
            : { ...prev, current: text };
      segments.set(seg, buf);
      const partial = buf.closed + buf.current;
      stt.push({
        t_ms: ms(t),
        is_final: e.event === 'stt.final',
        segment_id: seg,
        asr_segment_id: asr,
        transcript_revision: e.transcript_revision,
        audio_frame_end: e.audio_frame_end,
        /** この ASR 区間の文の正規化後の文字数（区間ごと。連結しない）。 */
        chars: [...normalizeForSimilarity(text)].length,
        /** segment の積み上げ文で求めた ja_rules_v1 の p。空なら null。 */
        completion_p: normalizeForSimilarity(partial) === '' ? null : scoreJaRules(history, partial).p,
      });
      break;
    }
    case 'speech.started':
      speech.push({
        audio_playback_id: e.audio_playback_id as number,
        started_ms: ms(t),
        ended_ms: null,
        audio_frame_start: e.audio_frame as number,
      });
      break;
    case 'speech.ended': {
      const s = speech.find((x) => x.audio_playback_id === e.audio_playback_id);
      if (s) s.ended_ms = ms(t);
      history.push({ role: 'assistant', text: String(e.spoken_text ?? '') });
      break;
    }
    case 'prefetch.started':
      prefetchStarted.set(e.audio_playback_id as number, t);
      prepares.push({
        segment_id: e.segment_id as number,
        transcript_revision: e.transcript_revision as number,
        started_ms: ms(t),
        latency_ms: null,
      });
      break;
    case 'prefetch.ready': {
      const started = prefetchStarted.get(e.audio_playback_id as number);
      if (started !== undefined) {
        prefetchLatencyMs.push(Math.round(t - started));
        const p = prepares.find((x) => x.transcript_revision === e.transcript_revision && x.segment_id === e.segment_id);
        if (p) p.latency_ms = Math.round(t - started);
      }
      break;
    }
    case 'turn.allowed':
      policyId ||= String(e.policy_id ?? '');
      break;
  }
}

const sorted = [...prefetchLatencyMs].sort((a, b) => a - b);
const fixture = {
  session_id: sessionId,
  policy_id: policyId,
  source: 'sessions/<session_id>/events.jsonl (not in git)',
  note:
    'Extracted by tools/turn_replay/extract_fixture.ts. No user or AI utterance text: times, VAP values, per-result normalized char counts and ja_rules_v1 p only.',
  vap_columns: ['t_ms', 'audio_frame', 'vad0', 'vad1', 'p_now_ai', 'p_future_ai'],
  vap,
  stt,
  speech,
  prepares,
  prefetch_latency_ms: { median: sorted[Math.floor(sorted.length / 2)] ?? null, values: prefetchLatencyMs },
};
writeFileSync(output, `${JSON.stringify(fixture)}\n`);
console.log(`wrote ${output}: vap=${vap.length} stt=${stt.length} speech=${speech.length}`);
