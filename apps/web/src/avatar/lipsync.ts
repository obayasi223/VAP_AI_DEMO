/**
 * 語時刻（playback.alignment）＋音量包絡の口（計画 §4.7「語単位の時刻＋音量包絡」）。three に依存しない。
 *
 * 口の開きは常に音量の包絡（VolumeMouthSource）で決め、語時刻は口の形（母音）だけを決める。
 * 語時刻が誤っていても、音が無いところで口が開くことはない。
 *
 * 母音の口形を使うのは、安全に読みが分かるときだけ:
 *  - 語がかな（ひらがな・カタカナ、長音、句読点）だけでできている。漢字・英数字を含む語は読みが分からないので使わない。
 *  - 語時刻が推定（source = estimated_time_proportional）ではない。
 *  - その再生の位置（playback.started／position）を受けている。
 * どれかを満たさない区間は、従来の音量だけの口（aa）に戻す。
 *
 * 語の中のモーラの時刻は語の長さの等分（推定）。ElevenLabs の文字単位の時刻は語へまとめて届くので（D の SpeechGenerator）、
 * 語の両端だけが実測。値（口形の重み、先読み、時定数）は未評価で、人が実音声で見て決める。
 */
import type { PlaybackAlignment, PlaybackEnded, PlaybackPosition, PlaybackStarted } from '@llm-vap/contracts';
import { CLOSED_MOUTH, VolumeMouthSource, type MouthShape, type MouthSource } from './mouth';
import { clamp01 } from './util';

export type Vowel = 'a' | 'i' | 'u' | 'e' | 'o';
/** N は撥音（ん）、Q は促音（っ、口を閉じて溜める）。 */
export type MoraKind = Vowel | 'N' | 'Q';

export interface Mora {
  kind: MoraKind;
  /** ま・ば・ぱ行。子音で唇が閉じる。 */
  labial: boolean;
}

const ROWS: Record<Vowel, string> = {
  a: 'あかさたなはまやらわがざだばぱ',
  i: 'いきしちにひみりぎじぢびぴゐ',
  u: 'うくすつぬふむゆるぐずづぶぷゔ',
  e: 'えけせてねへめれげぜでべぺゑ',
  o: 'おこそとのほもよろをごぞどぼぽ',
};
/** 前のモーラの母音を変える小書き（きゃ、ふぁ など）。 */
const SMALL: Record<string, Vowel> = { ぁ: 'a', ゃ: 'a', ゎ: 'a', ぃ: 'i', ぅ: 'u', ゅ: 'u', ぇ: 'e', ぉ: 'o', ょ: 'o' };
const LABIAL = new Set([...'まみむめもばびぶべぼぱぴぷぺぽ']);
const VOWEL_OF = new Map<string, Vowel>();
for (const [vowel, row] of Object.entries(ROWS) as [Vowel, string][]) for (const ch of row) VOWEL_OF.set(ch, vowel);
/** モーラを持たない記号。語の中にあっても読みの判定を妨げない。 */
const SILENT = /[\s、。，．,.!?！？…‥・「」『』（）()〜~ー－―-]/u;

/** カタカナをひらがなへ。 */
function toHiragana(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x30a1 && code <= 0x30f6) return String.fromCodePoint(code - 0x60);
  return ch;
}

/**
 * かなの語 → モーラの並び。漢字・英数字などを含むと null（読みが分からない）。
 * 記号だけの語は空の配列（ポーズ）。
 */
export function kanaToMorae(text: string): Mora[] | null {
  const morae: Mora[] = [];
  for (const raw of text) {
    const ch = toHiragana(raw);
    if (ch === 'ー' || ch === 'ｰ') {
      const previous = morae[morae.length - 1];
      if (previous && previous.kind !== 'N' && previous.kind !== 'Q') morae.push({ kind: previous.kind, labial: false });
      continue;
    }
    const small = SMALL[ch];
    if (small) {
      const previous = morae[morae.length - 1];
      if (previous && previous.kind !== 'N' && previous.kind !== 'Q') previous.kind = small;
      else morae.push({ kind: small, labial: false });
      continue;
    }
    if (ch === 'ん') {
      morae.push({ kind: 'N', labial: false });
      continue;
    }
    if (ch === 'っ') {
      morae.push({ kind: 'Q', labial: false });
      continue;
    }
    const vowel = VOWEL_OF.get(ch);
    if (vowel) {
      morae.push({ kind: vowel, labial: LABIAL.has(ch) });
      continue;
    }
    if (SILENT.test(ch)) continue;
    return null;
  }
  return morae;
}

export interface VisemeSegment {
  startMs: number;
  endMs: number;
  mora: Mora;
}

/** 語の時刻をモーラ数で等分する（語の中は推定）。読めない語は null。 */
export function wordToSegments(item: { text: string; start_ms: number; end_ms: number }): VisemeSegment[] | null {
  const morae = kanaToMorae(item.text);
  if (morae === null) return null;
  const duration = Math.max(item.end_ms - item.start_ms, 0);
  if (morae.length === 0 || duration === 0) return [];
  const step = duration / morae.length;
  return morae.map((mora, i) => ({ startMs: item.start_ms + i * step, endMs: item.start_ms + (i + 1) * step, mora }));
}

/**
 * 母音ごとの口形（音量が最大のときの重み）。VRoid の MTH_I／MTH_E は口角が大きく横へ引かれるので弱める。
 * 日本語の「う」は唇の丸めが小さい。未評価。
 */
export const VOWEL_SHAPES: Record<MoraKind, Readonly<MouthShape>> = {
  a: { ...CLOSED_MOUTH, aa: 1 },
  i: { ...CLOSED_MOUTH, ih: 0.7, aa: 0.1 },
  u: { ...CLOSED_MOUTH, ou: 0.75 },
  e: { ...CLOSED_MOUTH, ee: 0.75, aa: 0.15 },
  o: { ...CLOSED_MOUTH, oh: 0.9 },
  N: { ...CLOSED_MOUTH, ou: 0.15, ih: 0.1 },
  Q: { ...CLOSED_MOUTH },
};

/** 音量だけの口（語時刻が使えない区間）。 */
const VOLUME_ONLY: Readonly<MouthShape> = { ...CLOSED_MOUTH, aa: 1 };

/** 唇音の閉じ。モーラの頭のこの割合（上限 ms）で口を閉じ、母音へ開く。 */
export function labialClosure(elapsedMs: number, segmentMs: number): number {
  const closeMs = Math.min(segmentMs * 0.35, 60);
  if (closeMs <= 0 || elapsedMs >= closeMs) return 1;
  // 頭で 0.1 まで閉じ、開いていく。
  const t = clamp01(elapsedMs / closeMs);
  return 0.1 + 0.9 * t * t;
}

export interface LipSyncOptions {
  /** 口形の目標を先読みする量。唇は音より少し先に動く（調音の先行）。平滑化の遅れも打ち消す。 */
  lookaheadMs: number;
  /** 口形の切り替えの時定数。 */
  shapeSmoothMs: number;
  /** 再生位置の報告がこの間来なければ外挿を止める（位置が分からない＝音量だけに戻す）。 */
  maxExtrapolateMs: number;
  /**
   * 音（AnalyserNode と samples_written は出力へ書いた時点）と、実際に聞こえる時刻の差を口に足す遅れ。
   * 既定 0: 出力遅延（有線で 10〜40ms 程度）と描画の遅れ（1〜2 フレーム）がおおむね打ち消し合う想定。実機で要確認。
   */
  audioDelayMs: number;
  /** 語のすき間でも直前の母音を保つ長さ。 */
  holdGapMs: number;
}

export const DEFAULT_LIPSYNC: LipSyncOptions = {
  lookaheadMs: 35,
  shapeSmoothMs: 28,
  maxExtrapolateMs: 300,
  audioDelayMs: 0,
  holdGapMs: 90,
};

/** 16kHz（PlaybackPosition.samples_written の単位）。 */
const SAMPLES_PER_MS = 16;

interface PlaybackTimeline {
  id: number;
  generation: number;
  segments: VisemeSegment[];
  /** 読めない語、推定の語の区間。ここは音量だけ。 */
  blocked: { startMs: number; endMs: number }[];
  anchor: { posMs: number; atMs: number } | null;
}

export type LipSyncMode = 'volume' | 'alignment';

export type PlaybackAlignmentLike = Pick<PlaybackAlignment, 'audio_playback_id' | 'generation' | 'items' | 'source'>;

/** 口が使う項目だけ。PlaybackStarted／Position／Ended をそのまま渡せる。 */
export type PlaybackReportLike =
  | Pick<PlaybackStarted, 'type' | 'audio_playback_id' | 'generation' | 'client_t_ms'>
  | Pick<PlaybackPosition, 'type' | 'audio_playback_id' | 'generation' | 'client_t_ms' | 'samples_written'>
  | Pick<PlaybackEnded, 'type' | 'audio_playback_id' | 'generation'>;

export class AlignmentMouthSource implements MouthSource {
  private readonly options: LipSyncOptions;
  private readonly timelines = new Map<number, PlaybackTimeline>();
  /** 位置の報告が最後に来た再生。 */
  private activeId: number | null = null;
  private readonly shape: MouthShape = { ...CLOSED_MOUTH };
  private readonly levels: { atMs: number; rms: number }[] = [];
  mode: LipSyncMode = 'volume';

  constructor(
    readonly volume: VolumeMouthSource,
    private readonly now: () => number,
    options: Partial<LipSyncOptions> = {},
  ) {
    this.options = { ...DEFAULT_LIPSYNC, ...options };
  }

  /** 再生音の RMS。遅れを付けないときは VolumeMouthSource へそのまま渡す。 */
  setLevel(rms: number): void {
    if (this.options.audioDelayMs <= 0) {
      this.volume.setLevel(rms);
      return;
    }
    this.levels.push({ atMs: this.now(), rms });
    if (this.levels.length > 256) this.levels.splice(0, this.levels.length - 256);
  }

  closeNow(): void {
    this.levels.length = 0;
    this.volume.closeNow();
  }

  addAlignment(message: PlaybackAlignmentLike): void {
    const timeline = this.timeline(message.audio_playback_id, message.generation);
    if (timeline === null) return;
    const estimated = message.source === 'estimated_time_proportional';
    for (const item of message.items) {
      const segments = estimated ? null : wordToSegments(item);
      if (segments === null) timeline.blocked.push({ startMs: item.start_ms, endMs: item.end_ms });
      else timeline.segments.push(...segments);
    }
    timeline.segments.sort((a, b) => a.startMs - b.startMs);
  }

  /** playback.started／position／ended（Worker が Node へ送った報告、onSent で届く）。 */
  onPlaybackReport(report: PlaybackReportLike): void {
    if (report.type === 'playback.ended') {
      this.timelines.delete(report.audio_playback_id);
      if (this.activeId === report.audio_playback_id) this.activeId = null;
      return;
    }
    const timeline = this.timeline(report.audio_playback_id, report.generation);
    if (timeline === null) return;
    const posMs = report.type === 'playback.position' ? report.samples_written / SAMPLES_PER_MS : 0;
    timeline.anchor = { posMs, atMs: report.client_t_ms };
    this.activeId = report.audio_playback_id;
  }

  /** 世代が新しければ作り直し、古ければ null（棄てる）。 */
  private timeline(id: number, generation: number): PlaybackTimeline | null {
    const existing = this.timelines.get(id);
    if (existing && existing.generation > generation) return null;
    if (existing && existing.generation === generation) return existing;
    const created: PlaybackTimeline = { id, generation, segments: [], blocked: [], anchor: null };
    this.timelines.set(id, created);
    // 古い再生を溜めない。
    if (this.timelines.size > 8) {
      const oldest = [...this.timelines.keys()].sort((a, b) => a - b)[0];
      if (oldest !== undefined && oldest !== id) this.timelines.delete(oldest);
    }
    return created;
  }

  /** 今聞こえている（と見なす）再生位置。分からなければ null。 */
  playbackPositionMs(): number | null {
    if (this.activeId === null) return null;
    const anchor = this.timelines.get(this.activeId)?.anchor;
    if (!anchor) return null;
    const since = this.now() - anchor.atMs;
    if (since > this.options.maxExtrapolateMs) return null;
    return anchor.posMs + Math.max(since, 0) - this.options.audioDelayMs;
  }

  /** 位置 t の口形の目標と、語時刻を使えたか。 */
  targetAt(positionMs: number | null): { shape: Readonly<MouthShape>; aligned: boolean; closure: number } {
    if (positionMs === null || this.activeId === null) return { shape: VOLUME_ONLY, aligned: false, closure: 1 };
    const timeline = this.timelines.get(this.activeId);
    if (!timeline) return { shape: VOLUME_ONLY, aligned: false, closure: 1 };
    const t = positionMs + this.options.lookaheadMs;
    if (timeline.blocked.some((b) => t >= b.startMs && t < b.endMs)) return { shape: VOLUME_ONLY, aligned: false, closure: 1 };
    let last: VisemeSegment | null = null;
    for (const segment of timeline.segments) {
      if (segment.startMs > t) break;
      last = segment;
      if (t < segment.endMs) {
        const closure = segment.mora.labial ? labialClosure(t - segment.startMs, segment.endMs - segment.startMs) : 1;
        return { shape: VOWEL_SHAPES[segment.mora.kind], aligned: true, closure };
      }
    }
    if (last && t - last.endMs < this.options.holdGapMs) return { shape: VOWEL_SHAPES[last.mora.kind], aligned: true, closure: 1 };
    return { shape: VOLUME_ONLY, aligned: false, closure: 1 };
  }

  update(dtMs: number): MouthShape {
    if (this.options.audioDelayMs > 0) this.feedDelayedLevel();
    // 開きは音量の包絡（aa に開きの量が入っている）。
    const open = this.volume.update(dtMs).aa;
    const target = this.targetAt(this.playbackPositionMs());
    this.mode = target.aligned ? 'alignment' : 'volume';
    const k = this.options.shapeSmoothMs <= 0 ? 1 : 1 - Math.exp(-Math.max(dtMs, 0) / this.options.shapeSmoothMs);
    const amount = open * target.closure;
    for (const key of ['aa', 'ih', 'ou', 'ee', 'oh'] as const) {
      const goal = target.shape[key] * amount;
      this.shape[key] += (goal - this.shape[key]) * k;
      if (this.shape[key] < 1e-3) this.shape[key] = 0;
    }
    // 包絡が閉じたら形の平滑化を待たずに閉じる（発話停止と同時に閉じる）。
    if (open === 0) Object.assign(this.shape, CLOSED_MOUTH);
    return { ...this.shape };
  }

  /** 遅らせた音量を VolumeMouthSource へ渡す。 */
  private feedDelayedLevel(): void {
    const due = this.now() - this.options.audioDelayMs;
    let latest: { atMs: number; rms: number } | null = null;
    while (this.levels.length > 0 && (this.levels[0]?.atMs ?? Infinity) <= due) latest = this.levels.shift() ?? null;
    if (latest) this.volume.setLevel(latest.rms);
  }
}
