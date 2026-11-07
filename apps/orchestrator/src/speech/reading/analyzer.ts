/**
 * 形態素解析（kuromoji 0.1.2、IPADIC）。辞書の読み込みは起動時に1回（main が initReading で呼ぶ）。
 * 読み込みに 0.7 秒前後、メモリは 300MB 余り（実測、docs は DEPENDENCIES_LOCK.md）。解析は 1 文 1ms 未満。
 * 読みは辞書の推定で、文脈による読み分け（何＝なに／なん）は誤りうる。
 */
import { createRequire } from 'node:module';
import path from 'node:path';

export interface ReadingToken {
  surface: string;
  /** 入力の中の位置（UTF-16 の単位）。 */
  start: number;
  pos: string;
  pos1: string;
  pos2: string;
  /** 辞書の読み（カタカナ、表記どおり: 東京＝トウキョウ、は＝ハ）。未知語は null。 */
  reading: string | null;
  /** 発音（カタカナ: 東京＝トーキョー、は＝ワ）。未知語は null。 */
  pronunciation: string | null;
  known: boolean;
}

export interface ReadingAnalyzer {
  readonly name: string;
  tokenize(text: string): ReadingToken[];
}

interface KuromojiToken {
  surface_form: string;
  word_position: number;
  pos: string;
  pos_detail_1: string;
  pos_detail_2: string;
  reading?: string;
  pronunciation?: string;
  word_type: string;
}

const asReading = (value: string | undefined): string | null => (value && value !== '*' ? value : null);

export async function loadKuromojiAnalyzer(): Promise<ReadingAnalyzer> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('kuromoji');
  const dicPath = path.join(path.dirname(entry), '..', 'dict');
  const kuromoji = (await import('kuromoji')).default as unknown as {
    builder(options: { dicPath: string }): {
      build(callback: (error: Error | null, tokenizer: { tokenize(text: string): KuromojiToken[] }) => void): void;
    };
  };
  const tokenizer = await new Promise<{ tokenize(text: string): KuromojiToken[] }>((resolve, reject) => {
    kuromoji.builder({ dicPath }).build((error, built) => (error ? reject(error) : resolve(built)));
  });
  return {
    name: 'kuromoji-0.1.2-ipadic',
    tokenize(text: string): ReadingToken[] {
      if (text === '') return [];
      // word_position に頼らず、表層を入力の中で順に探して位置を決める（空白などの読み飛ばしに備える）。
      let cursor = 0;
      return tokenizer.tokenize(text).map((t) => {
        const found = text.indexOf(t.surface_form, cursor);
        const start = found >= 0 ? found : cursor;
        cursor = start + t.surface_form.length;
        return { t, start };
      }).map(({ t, start }) => ({
        surface: t.surface_form,
        start,
        pos: t.pos,
        pos1: t.pos_detail_1,
        pos2: t.pos_detail_2,
        reading: asReading(t.reading),
        pronunciation: asReading(t.pronunciation),
        known: t.word_type === 'KNOWN',
      }));
    },
  };
}
