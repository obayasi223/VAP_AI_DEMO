/**
 * 台本から作る手書きの逐次 ASR。実 ASR ではない。provider と model_version にも明記する。
 *
 * 形は tools/provider_probe/out/ の `long`（asia-northeast1）の1サンプル（ja.wav の8秒と、その繰り返し）に寄せた:
 *  - 音声に対する遅れ 約 300ms
 *  - 約 1.8 秒ごとに、全文が 0.9 で末尾に「。」が付いた結果が一瞬届き、次の結果で 0.9 の範囲が縮む
 *  - 持続する 0.9 の範囲は、1つ前の瞬間の位置まで
 *  - final は長い間（段落の切れ目）で出る
 * 話す速さや認識の誤りの出方は実音声と違う。ここでの結果で §4.5a の関門は通らない。
 */
import { absent, present } from '@llm-vap/contracts';
import type { SttPart } from '@llm-vap/contracts';
import type { SttEvent } from '../../../apps/orchestrator/src/cognition/initiative/transcript_view';
import { buildSttEvent } from './stt_events';
import type { SttEventContext } from './stt_events';

export const HANDWRITTEN_PROVIDER = 'handwritten_not_real_asr';
export const HANDWRITTEN_MODEL = 'handwritten-v1-not-asr';

export interface HandwrittenOptions {
  chars_per_second: number;
  sentence_pause_ms: number;
  paragraph_pause_ms: number;
  lag_ms: number;
  revision_interval_ms: number;
  flash_interval_ms: number;
  start_delay_ms: number;
}

export const HANDWRITTEN_DEFAULTS: HandwrittenOptions = {
  chars_per_second: 6,
  sentence_pause_ms: 350,
  paragraph_pause_ms: 1100,
  lag_ms: 300,
  revision_interval_ms: 240,
  flash_interval_ms: 1800,
  start_delay_ms: 500,
};

interface TimedChar {
  ch: string;
  at_ms: number;
}

const SENTENCE_END = /[。？！]/u;
const PUNCT = /[、。？！]/u;

/** 各文字がいつ発話されるか。句読点は読まれた文字の直後に同じ時刻で付く。 */
function timeline(paragraph: string, startMs: number, o: HandwrittenOptions): { chars: TimedChar[]; endMs: number } {
  const perChar = 1000 / o.chars_per_second;
  let t = startMs;
  const chars: TimedChar[] = [];
  for (const ch of paragraph) {
    if (!PUNCT.test(ch)) t += perChar;
    chars.push({ ch, at_ms: t });
    if (SENTENCE_END.test(ch)) t += o.sentence_pause_ms;
    else if (ch === '、') t += o.sentence_pause_ms / 2;
  }
  return { chars, endMs: t };
}

export function generateHandwrittenAsr(
  text: string,
  session_id: string,
  min_stability: number,
  options: Partial<HandwrittenOptions> = {},
): SttEvent[] {
  const o = { ...HANDWRITTEN_DEFAULTS, ...options };
  const ctx: SttEventContext = {
    session_id,
    provider: HANDWRITTEN_PROVIDER,
    model_version: HANDWRITTEN_MODEL,
    stream_id: 'handwritten',
    min_stability,
    wall_origin_ms: Date.parse('2026-11-08T00:00:00.000Z'),
  };
  const events: SttEvent[] = [];
  let revision = 0;
  let cursor = o.start_delay_ms;
  const frame = (ms: number) => Math.round(ms * 16);
  const paragraphs = text.split('\n').filter((p) => p.length > 0);

  paragraphs.forEach((paragraph, asr_segment_id) => {
    const { chars, endMs } = timeline(paragraph, cursor, o);
    const frameStart = frame(cursor);
    const heardAt = (t: number) => chars.filter((c) => c.at_ms <= t - o.lag_ms).map((c) => c.ch).join('');
    let lastFlashMs = cursor;
    let flashes: string[] = [];
    let lastHeard = '';
    for (let t = cursor + o.revision_interval_ms; t < endMs + o.lag_ms; t += o.revision_interval_ms) {
      const heard = heardAt(t);
      if (heard.length === 0) continue;
      const isFlash = t - lastFlashMs >= o.flash_interval_ms && heard !== flashes.at(-1);
      if (!isFlash && heard === lastHeard) continue;
      lastHeard = heard;
      let parts: SttPart[];
      if (isFlash) {
        lastFlashMs = t;
        parts = [{ text: `${heard.replace(/[、。？！]+$/u, '')}。`, stability: present(0.9) }];
        flashes.push(heard);
      } else {
        const persisted = flashes.at(-2) ?? '';
        const rest = heard.slice(persisted.length);
        parts = persisted
          ? [
              { text: persisted, stability: present(0.9) },
              { text: rest, stability: present(0.01) },
            ]
          : [{ text: rest, stability: present(0.01) }];
      }
      revision += 1;
      events.push(
        buildSttEvent(ctx, {
          kind: 'interim',
          t_ms: t,
          parts,
          revision,
          asr_segment_id,
          frame_start: frameStart,
          frame_end: frame(t - o.lag_ms),
          precision: 'result_end_offset',
          words: absent('interim_words_unavailable'),
        }),
      );
    }
    revision += 1;
    const finalAt = endMs + o.paragraph_pause_ms * 0.6;
    events.push(
      buildSttEvent(ctx, {
        kind: 'final',
        t_ms: finalAt,
        parts: [{ text: paragraph, stability: absent('provider_unset_marker_0.0') }],
        revision,
        asr_segment_id,
        frame_start: frameStart,
        frame_end: frame(endMs),
        precision: 'result_end_offset',
        words: absent('handwritten_has_no_word_offsets'),
      }),
    );
    flashes = [];
    cursor = endMs + o.paragraph_pause_ms;
  });
  return events;
}
