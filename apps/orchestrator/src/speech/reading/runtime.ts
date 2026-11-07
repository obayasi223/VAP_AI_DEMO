/**
 * 読みの設定と、起動時に1回だけ読み込む解析器（SpeechGenerator の既定）。
 *  - LIPSYNC_READING: 口形の読み（playback.alignment の reading）。既定 1（有効）。0 で止める。
 *  - TTS_READING_MODE: TTS へ送る文の読みの変換。off（既定）／risky（R1〜R3 の語だけひらがな）／all（漢字と数を全部ひらがな）。
 *    実験の結果（tools/provider_probe/README.md の reading_tts）が出るまで既定は off。
 * 解析器の読み込みに失敗したら、口形は従来どおり（表記がかなの語だけ）、TTS の文は変換しない。
 */
import { loadKuromojiAnalyzer, type ReadingAnalyzer } from './analyzer';
import type { TtsReadingMode } from './pieces';
import type { ReadingTrackOptions } from './track';

export interface ReadingConfig {
  lip: boolean;
  tts_mode: TtsReadingMode;
}

export const DEFAULT_READING_CONFIG: ReadingConfig = { lip: true, tts_mode: 'off' };

export function readReadingConfig(env: NodeJS.ProcessEnv = process.env): ReadingConfig {
  const lipRaw = env.LIPSYNC_READING?.trim();
  const lip = lipRaw === undefined || lipRaw === '' ? true : lipRaw === '1' || lipRaw.toLowerCase() === 'true';
  const modeRaw = (env.TTS_READING_MODE ?? '').trim();
  if (modeRaw !== '' && modeRaw !== 'off' && modeRaw !== 'risky' && modeRaw !== 'all') {
    throw new Error(`TTS_READING_MODE must be off, risky or all, got ${modeRaw}`);
  }
  return { lip, tts_mode: modeRaw === '' ? 'off' : (modeRaw as TtsReadingMode) };
}

let sharedAnalyzer: ReadingAnalyzer | null = null;
let sharedConfig: ReadingConfig = DEFAULT_READING_CONFIG;

export interface ReadingInitResult {
  config: ReadingConfig;
  analyzer: string | null;
  load_ms: number | null;
  /** 1文の解析の時間（読み込み直後の1回目を除いた 5 回の最大）。 */
  sample_tokenize_ms: number | null;
  error: string | null;
}

/** 起動時に1回。設定を読み、必要なら辞書を読み込む。 */
export async function initReading(env: NodeJS.ProcessEnv = process.env): Promise<ReadingInitResult> {
  sharedConfig = readReadingConfig(env);
  if (!sharedConfig.lip && sharedConfig.tts_mode === 'off') {
    sharedAnalyzer = null;
    return { config: sharedConfig, analyzer: null, load_ms: null, sample_tokenize_ms: null, error: null };
  }
  const began = performance.now();
  try {
    const analyzer = await loadKuromojiAnalyzer();
    const load_ms = performance.now() - began;
    const sample = 'そうですね、東京駅の近くで三百円の切手を二枚買いました。';
    analyzer.tokenize(sample); // 1回目は遅い（JIT）。応答の前に済ませる。
    let worst = 0;
    for (let i = 0; i < 5; i += 1) {
      const t = performance.now();
      analyzer.tokenize(sample);
      worst = Math.max(worst, performance.now() - t);
    }
    sharedAnalyzer = analyzer;
    return { config: sharedConfig, analyzer: analyzer.name, load_ms, sample_tokenize_ms: worst, error: null };
  } catch (error) {
    sharedAnalyzer = null;
    return {
      config: sharedConfig,
      analyzer: null,
      load_ms: null,
      sample_tokenize_ms: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** SpeechGenerator の既定。initReading の前は解析器なし（従来どおり）。 */
export function sharedReadingOptions(): ReadingTrackOptions {
  return { analyzer: sharedAnalyzer, tts_mode: sharedConfig.tts_mode, lip: sharedConfig.lip };
}
