/**
 * 受け止め・保留のつなぎ・最後の段の問いの音声の合成と保持（docs/design/two_ai/06 §5、01 §3.1 の 5）。
 * 開始時に各 AI の声で 1 回だけ合成する。毎回同じ音声を使うので、受け止めの長さが条件と回でそろう（AC1）。
 * 再生は SpeechGeneratorImpl.prepareCached（TTS の文脈を使わない）。
 */
import { createHash } from 'node:crypto';
import { ttsContextId } from '@llm-vap/contracts';
import type { AiId, TtsChunk, TtsConnection } from '@llm-vap/contracts';
import type { CachedSpeechAudio } from '../speech/speech_generator';
import { ttsTextFor } from '../speech/speech_generator';

export interface AckBank {
  /** 開始時に各 AI の声で 1 回だけ合成する。失敗（1 回の再試行の後）なら reject し、セッションを作らない。 */
  synthesize(templates: { id: string; text: string }[], slots: Record<AiId, TtsConnection>): Promise<void>;
  get(ai_id: AiId, template_id: string): CachedSpeechAudio;
  /** selection（fixed_first／round_robin）に従う次の受け止めの定型。 */
  nextTemplateId(ai_id: AiId): string;
  /** manifest の ack_templates（受け止め・hold_bridge・closing_question のすべて）。 */
  manifestEntries(): { id: string; text_sha256: string; synthesized_ms: Record<AiId, number> }[];
}

export interface AckBankOptions {
  /** 受け止めの定型の ID（nextTemplateId の対象。hold_bridge と closing_question は含めない）。 */
  ack_ids: readonly string[];
  selection: 'fixed_first' | 'round_robin';
  /** 1 つの合成の上限。 */
  timeout_ms?: number;
  /** 再生 ID の空間を再生の ID と分ける（合成の文脈 ID に使うだけ。ブラウザへは送らない）。 */
  first_synthesis_id?: number;
  preferred_sample_rate_hz?: number;
}

const SYNTH_TIMEOUT_MS = 15_000;

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 1 つの文を 1 つの文脈で合成し、chunk を集める。 */
async function synthesizeOne(tts: TtsConnection, text: string, id: number, timeout_ms: number): Promise<CachedSpeechAudio> {
  const target = { audio_playback_id: id, generation: 0 };
  const context_id = ttsContextId(id, 0);
  const chunks: TtsChunk[] = [];
  let unsubscribe: (() => void) | null = null;
  let unsubscribeLost: (() => void) | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ack_synthesis_timeout:${timeout_ms}ms`)), timeout_ms);
      unsubscribe = tts.onChunk((chunk) => {
        if (chunk.context_id !== context_id) return;
        chunks.push(chunk);
        if (chunk.is_last) {
          clearTimeout(timer);
          resolve();
        }
      });
      unsubscribeLost =
        tts.onContextLost?.((lost) => {
          if (lost.context_id !== context_id) return;
          clearTimeout(timer);
          reject(new Error(`ack_synthesis_lost:${lost.reason}`));
        }) ?? null;
      try {
        const context = tts.openContext(target);
        context.sendText(ttsTextFor(text));
        context.flush();
        context.endInput();
      } catch (error) {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } finally {
    (unsubscribe as (() => void) | null)?.();
    (unsubscribeLost as (() => void) | null)?.();
  }
  const withAudio = chunks.filter((c) => c.pcm.length > 0 || c.is_last);
  const samples = withAudio.reduce((a, c) => a + c.pcm.length, 0);
  if (samples === 0) throw new Error('ack_synthesis_no_audio');
  const rate = withAudio.find((c) => c.pcm.length > 0)?.sample_rate_hz ?? 24000;
  if (withAudio.some((c) => c.pcm.length > 0 && c.sample_rate_hz !== rate)) throw new Error('ack_synthesis_sample_rate_changed');
  return {
    text,
    sample_rate_hz: rate,
    pcm: withAudio.map((c) => c.pcm),
    alignment: withAudio.map((c) => c.alignment.value ?? null),
    samples,
    synthesized_ms: samples / (rate / 1000),
  };
}

export function createAckBank(options: AckBankOptions): AckBank {
  const store = new Map<string, CachedSpeechAudio>();
  const texts = new Map<string, string>();
  const order = new Map<AiId, number>([
    ['A', 0],
    ['B', 0],
  ]);
  let nextId = options.first_synthesis_id ?? 900_000;
  const key = (ai: AiId, id: string) => `${ai}:${id}`;
  return {
    async synthesize(templates, slots) {
      const timeout = options.timeout_ms ?? SYNTH_TIMEOUT_MS;
      for (const ai of ['A', 'B'] as const) {
        for (const t of templates) {
          texts.set(t.id, t.text);
          let last: unknown = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              store.set(key(ai, t.id), await synthesizeOne(slots[ai], t.text, nextId++, timeout));
              last = null;
              break;
            } catch (error) {
              last = error;
            }
          }
          if (last !== null) throw new Error(`ack_synthesis_failed:${ai}:${t.id}:${last instanceof Error ? last.message : String(last)}`);
        }
      }
    },
    get(ai_id, template_id) {
      const audio = store.get(key(ai_id, template_id));
      if (audio === undefined) throw new Error(`ack_bank: no audio for ${ai_id}:${template_id}`);
      return audio;
    },
    nextTemplateId(ai_id) {
      const ids = options.ack_ids;
      if (ids.length === 0) throw new Error('ack_bank: no acknowledgment templates');
      if (options.selection === 'fixed_first') return ids[0] as string;
      const i = order.get(ai_id) ?? 0;
      order.set(ai_id, i + 1);
      return ids[i % ids.length] as string;
    },
    manifestEntries() {
      return [...texts.entries()].map(([id, text]) => ({
        id,
        text_sha256: sha256(text),
        synthesized_ms: { A: Math.round(store.get(key('A', id))?.synthesized_ms ?? 0), B: Math.round(store.get(key('B', id))?.synthesized_ms ?? 0) },
      }));
    },
  };
}
