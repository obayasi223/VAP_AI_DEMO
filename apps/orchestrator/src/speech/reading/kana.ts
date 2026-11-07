/** かなの判定と変換。形態素解析の読み（カタカナ）を口形と TTS の文へ使うための小物。 */

const HIRAGANA = /^[ぁ-ゖゝゞ]$/u;
const KATAKANA = /^[ァ-ヺヽヾ]$/u;
/** 長音と小書き。口形の区切りで前の字に付ける。 */
const ATTACHED = /^[ーｰぁぃぅぇぉゃゅょゎァィゥェォャュョヮ]$/u;
const KANJI = /\p{Script=Han}|[々〆ヶ]/u;

export function isKanaChar(ch: string): boolean {
  return HIRAGANA.test(ch) || KATAKANA.test(ch) || ch === 'ー' || ch === 'ｰ';
}

export function isAttachedKana(ch: string): boolean {
  return ATTACHED.test(ch);
}

export function hasKanji(text: string): boolean {
  return KANJI.test(text);
}

export function toKatakana(text: string): string {
  return text.replace(/[ぁ-ゖ]/gu, (c) => String.fromCodePoint((c.codePointAt(0) as number) + 0x60));
}

export function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/gu, (c) => String.fromCodePoint((c.codePointAt(0) as number) - 0x60));
}

/** 全部がかな（長音を含む）か。 */
export function isAllKana(text: string): boolean {
  if (text === '') return false;
  for (const ch of text) if (!isKanaChar(ch)) return false;
  return true;
}
