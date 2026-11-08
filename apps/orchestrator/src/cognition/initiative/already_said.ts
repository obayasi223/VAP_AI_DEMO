/**
 * AI がすでに話した内容との照合と、通常応答の材料の反映の推定（docs/initiative_v3_design.md §9）。コードの文字の比較だけで、LLM は使わない。
 *
 * - 「すでに話した」は revise_min_utterance_similarity と同じ文字 2-gram のコサイン。長い応答の中の一文だけが同じ場合を拾うため、発話全体と文ごとの大きい方を見る。
 * - 「反映の推定」は材料の文字 2-gram が話した文にどれだけ含まれるか（包含率）。応答は材料より長いのが普通なので、長さで下がるコサインは主にしない。
 *   ひらがなだけの 2-gram（です、ます、ください など）は内容を示さないので、内容の字（漢字、カタカナ、英数字）を含む 2-gram を数える。
 * どちらも文の一致であって、意味の同一性や、言い換えでの反映は測れない。推定は推定と名付けて記録し、確定として扱わない。
 */
import type { HistoryEntry } from '@llm-vap/contracts';
import { SIMILARITY_METHOD, charNgramCosine, normalizeForSimilarity } from '../similarity';

export const ALREADY_SAID_METHOD = `${SIMILARITY_METHOD};max_of_whole_and_sentences`;

const SENTENCE_END = /[。．！？!?\n]+/u;

export interface AlreadySaidScore {
  method: string;
  similarity: number;
  /** 最も似ていた部分（発話全体か一文）。 */
  matched_text: string;
}

export interface AlreadySaidMatch extends AlreadySaidScore {
  threshold: number;
  audio_playback_id: number;
  origin: 'response' | 'candidate';
}

/** 発話全体と文ごとに比べ、最も似ている部分の値を返す。話した文が空なら similarity 0。 */
export function alreadySaidScore(utterance: string, spoken: string): AlreadySaidScore {
  const parts = [spoken, ...spoken.split(SENTENCE_END).map((s) => s.trim())].filter((s) => s.length > 0);
  let best: AlreadySaidScore = { method: ALREADY_SAID_METHOD, similarity: 0, matched_text: '' };
  for (const part of parts) {
    const similarity = charNgramCosine(utterance, part);
    if (similarity > best.similarity) best = { method: ALREADY_SAID_METHOD, similarity, matched_text: part };
  }
  return best;
}

/** この発話で話した部分と比べて、基準以上なら一致の情報を返す。 */
export function matchSpoken(
  utterance: string,
  spoken: string,
  ctx: { threshold: number; audio_playback_id: number; origin: 'response' | 'candidate' },
): AlreadySaidMatch | null {
  const score = alreadySaidScore(utterance, spoken);
  return score.similarity >= ctx.threshold ? { ...score, threshold: ctx.threshold, audio_playback_id: ctx.audio_playback_id, origin: ctx.origin } : null;
}

/** セッションの AI の発話（実際に話した部分）の新しい順に比べて、最初に基準を超えたものを返す。 */
export function findAlreadySaid(utterance: string, entries: readonly HistoryEntry[], threshold: number): AlreadySaidMatch | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.role !== 'assistant') continue;
    const match = matchSpoken(utterance, entry.text, {
      threshold,
      audio_playback_id: entry.audio_playback_id,
      origin: entry.origin.kind,
    });
    if (match) return match;
  }
  return null;
}

export const REFLECTION_METHOD = 'char_bigram_containment:v1';
/** 内容の字を含む 2-gram がこれ未満なら、全部の 2-gram で測る（短い文やひらがなだけの文）。 */
const MIN_CONTENT_BIGRAMS = 3;
/** 内容の字（漢字、カタカナ、英数字）。ひらがなだけの 2-gram を内容として数えない。 */
const CONTENT_CHAR = /[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9]/u;

function bigrams(text: string): string[] {
  const chars = [...normalizeForSimilarity(text)];
  return chars.length < 2 ? (chars.length === 1 ? [chars[0]!] : []) : Array.from({ length: chars.length - 1 }, (_, i) => chars[i]! + chars[i + 1]!);
}

export interface ReflectionEstimate {
  method: string;
  basis: 'content_bigrams' | 'all_bigrams';
  containment: number;
  cosine: number;
  threshold: number;
  material_bigrams: number;
  matched_bigrams: number;
}

/** 材料の文字 2-gram が話した文に含まれる割合。反映の推定で、確定ではない。 */
export function estimateReflection(material: string, spoken: string, threshold: number): { estimated_reflected: boolean; estimate: ReflectionEstimate } {
  const all = [...new Set(bigrams(material))];
  const content = all.filter((b) => CONTENT_CHAR.test(b));
  const basis = content.length >= MIN_CONTENT_BIGRAMS ? 'content_bigrams' : 'all_bigrams';
  const used = basis === 'content_bigrams' ? content : all;
  const spokenSet = new Set(bigrams(spoken));
  const matched = used.filter((b) => spokenSet.has(b)).length;
  const containment = used.length === 0 ? 0 : matched / used.length;
  return {
    estimated_reflected: containment >= threshold,
    estimate: {
      method: REFLECTION_METHOD,
      basis,
      containment,
      cosine: charNgramCosine(material, spoken),
      threshold,
      material_bigrams: used.length,
      matched_bigrams: matched,
    },
  };
}
