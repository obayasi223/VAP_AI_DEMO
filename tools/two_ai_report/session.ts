/**
 * 2 体のセッションの読み込みと、イベントの引き方（tools/two_ai_report と log_check の 2 体の規則で共有。WP4）。
 * 材料は events.jsonl、manifest.json、（あれば）session_audio_sync.jsonl だけ。WP1 と WP2 の内部に依存しない（05 §5.2）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  ResearchEvent,
  TwoAiManifest,
  TwoAiScript,
  TwoAiSessionConfig,
  type ResearchEventName,
} from '@llm-vap/contracts';

export type Ev<N extends ResearchEventName> = Extract<ResearchEvent, { event: N }>;

export interface AudioSyncAnchor {
  audio_frame: number;
  wav_sample: number;
  t_monotonic_ms: number;
}

export interface TwoAiSessionData {
  dir: string | null;
  session_id: string;
  events: ResearchEvent[];
  /** 出した順（ファイルの順）。封筒は「出した時点」の段階と段なので（06 §4.1）、封筒の検査はこの順で見る。vap.state などは自分の計測の時刻を持ち、出すのが遅れる。 */
  emitted?: ResearchEvent[];
  /** スキーマに通らなかった行の数（log_check が詳しく出す）。 */
  invalid_lines: number;
  manifest: Record<string, unknown> | null;
  two_ai: TwoAiManifest | null;
  two_ai_error: string | null;
  /** 録音の位置と時刻の対応（SAVE_SESSION_AUDIO=1 のときだけ）。 */
  audio: { first_t_monotonic_ms: number; first_audio_frame: number; anchors: AudioSyncAnchor[] } | null;
  /** 検査に使う設定と台本（manifest のパスか、引数で渡したもの）。なければ null。 */
  config: TwoAiSessionConfig | null;
  script: TwoAiScript | null;
  notes: string[];
}

export interface LoadOptions {
  /** 設定と台本のパスの基準（既定は作業ディレクトリ）。 */
  repoRoot?: string;
  config?: TwoAiSessionConfig | null;
  script?: TwoAiScript | null;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 'sha256:<hex>' と '<hex>' の両方を受ける。 */
export function sameHash(recorded: string, hex: string): boolean {
  return recorded === hex || recorded === `sha256:${hex}`;
}

function readJsonl(path: string): { values: unknown[]; bad: number } {
  const values: unknown[] = [];
  let bad = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      bad += 1;
    }
  }
  return { values, bad };
}

function tryLoad<T>(path: string | null, parse: (v: unknown) => T, root: string, notes: string[], label: string): T | null {
  if (path === null) return null;
  const full = isAbsolute(path) ? path : resolve(root, path);
  if (!existsSync(full)) {
    notes.push(`${label} が見つからない: ${path}`);
    return null;
  }
  try {
    return parse(JSON.parse(readFileSync(full, 'utf8')));
  } catch (error) {
    notes.push(`${label} が読めない: ${path}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    return null;
  }
}

/** 値から作る（試験と試走）。 */
export function sessionFromValues(rawEvents: unknown[], manifest: Record<string, unknown> | null, options: LoadOptions = {}, dir: string | null = null): TwoAiSessionData {
  const events: ResearchEvent[] = [];
  let invalid = 0;
  for (const raw of rawEvents) {
    const parsed = ResearchEvent.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
    else invalid += 1;
  }
  const emitted = [...events];
  events.sort((a, b) => a.t_monotonic_ms - b.t_monotonic_ms);
  const notes: string[] = [];
  let two_ai: TwoAiManifest | null = null;
  let two_ai_error: string | null = null;
  const rawTwoAi = manifest?.two_ai;
  if (rawTwoAi !== undefined) {
    const parsed = TwoAiManifest.safeParse(rawTwoAi);
    if (parsed.success) two_ai = parsed.data;
    else two_ai_error = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join(' / ');
  }
  const root = options.repoRoot ?? process.cwd();
  const config = options.config !== undefined ? options.config : tryLoad(two_ai?.config_file ?? null, (v) => TwoAiSessionConfig.parse(v), root, notes, '設定');
  const script = options.script !== undefined ? options.script : tryLoad(two_ai?.script_file ?? null, (v) => TwoAiScript.parse(v), root, notes, '台本');
  return {
    dir,
    session_id: events[0]?.session_id ?? String(manifest?.session_id ?? 'unknown'),
    events,
    emitted,
    invalid_lines: invalid,
    manifest,
    two_ai,
    two_ai_error,
    audio: null,
    config,
    script,
    notes,
  };
}

/** <session>/ か events.jsonl を読む。 */
export async function loadTwoAiSession(input: string, options: LoadOptions = {}): Promise<TwoAiSessionData> {
  const info = await stat(input);
  const dir = info.isDirectory() ? input : dirname(input);
  const eventsPath = info.isDirectory() ? join(dir, 'events.jsonl') : input;
  const { values, bad } = readJsonl(eventsPath);
  const manifestPath = join(dir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>) : null;
  const data = sessionFromValues(values, manifest, options, dir);
  data.invalid_lines += bad;
  const syncPath = join(dir, 'session_audio_sync.jsonl');
  if (existsSync(syncPath)) {
    const { values: records } = readJsonl(syncPath);
    const start = records.find((r) => (r as { type?: string }).type === 'start') as { first_t_monotonic_ms: number; first_audio_frame: number } | undefined;
    if (start !== undefined) {
      data.audio = {
        first_t_monotonic_ms: start.first_t_monotonic_ms,
        first_audio_frame: start.first_audio_frame,
        anchors: records.filter((r) => (r as { type?: string }).type === 'anchor') as AudioSyncAnchor[],
      };
    }
  }
  return data;
}

// ---- 引き方 ----------------------------------------------------------------------

export function ofType<N extends ResearchEventName>(events: readonly ResearchEvent[], name: N): Ev<N>[] {
  return events.filter((e): e is Ev<N> => e.event === name);
}

export function mval<T>(m: { value: T | null } | null | undefined): T | null {
  return m === null || m === undefined ? null : m.value;
}

export type TwoAiSpeech = (Ev<'speech.started'> | Ev<'speech.ended'> | Ev<'speech.interrupted'>) & {
  origin: 'two_ai_turn';
  ai_id: 'A' | 'B';
  turn_id: string;
  turn_kind: string;
  point_id: string | null;
};

export function twoAiSpeech(events: readonly ResearchEvent[], which: 'started' | 'finished'): TwoAiSpeech[] {
  return events.filter((e) => {
    if (which === 'started' ? e.event !== 'speech.started' : e.event !== 'speech.ended' && e.event !== 'speech.interrupted') return false;
    return (e as { origin?: string }).origin === 'two_ai_turn';
  }) as TwoAiSpeech[];
}

export function spokenText(e: TwoAiSpeech): string {
  return 'spoken_text' in e ? (e as { spoken_text: string }).spoken_text : '';
}

export function playedMs(e: TwoAiSpeech): number {
  return 'samples_written' in e ? (e as { samples_written: number }).samples_written / 16 : 0;
}

export function phaseOf(e: ResearchEvent): string | null {
  return e.two_ai?.phase ?? null;
}

/** 段階の区間（two_ai.phase_changed から）。 */
export function phaseSpans(events: readonly ResearchEvent[]): { phase: string; started_at: number; ended_at: number | null }[] {
  const changes = ofType(events, 'two_ai.phase_changed');
  return changes.map((c, i) => ({ phase: c.to, started_at: c.t_monotonic_ms, ended_at: changes[i + 1]?.t_monotonic_ms ?? null }));
}

/** 取り違えの文と値。台本、なければ計画の凍結の全文から探す。 */
export function slipTexts(data: TwoAiSessionData): { point_id: string; slip_statement: string; slip_value: string; correct_statement: string } | null {
  const fromScript = data.script?.planned_points.find((p) => p.kind === 'fact_slip' && p.slip !== null);
  if (fromScript?.slip) return { point_id: fromScript.id, ...fromScript.slip };
  for (const plan of ofType(data.events, 'two_ai.plan')) {
    const found = findSlip(plan.plan, null);
    if (found !== null) return found;
  }
  return null;
}

function findSlip(value: unknown, pointId: string | null): { point_id: string; slip_statement: string; slip_value: string; correct_statement: string } | null {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const f = findSlip(v, pointId);
      if (f !== null) return f;
    }
    return null;
  }
  const o = value as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : pointId;
  if (typeof o.slip_statement === 'string' && typeof o.slip_value === 'string') {
    return { point_id: id ?? 'fact_slip', slip_statement: o.slip_statement, slip_value: o.slip_value, correct_statement: typeof o.correct_statement === 'string' ? o.correct_statement : '' };
  }
  for (const v of Object.values(o)) {
    const f = findSlip(v, id);
    if (f !== null) return f;
  }
  return null;
}

/** orchestrator の時刻 → 録音の始まりからの ms（録音がなければ null）。 */
export function audioOffsetMs(data: TwoAiSessionData, t: number): number | null {
  const a = data.audio;
  if (a === null) return null;
  const before = a.anchors.filter((x) => x.t_monotonic_ms <= t).at(-1) ?? a.anchors[0];
  if (before === undefined) return Math.round(t - a.first_t_monotonic_ms);
  return Math.round(before.wav_sample / 16 + (t - before.t_monotonic_ms));
}

/** 音声の枠の位置 → orchestrator の時刻（録音の対応がなければ null）。 */
export function frameToMonotonic(data: TwoAiSessionData, frame: number): number | null {
  const a = data.audio;
  if (a === null) return null;
  const before = a.anchors.filter((x) => x.audio_frame <= frame).at(-1) ?? a.anchors[0];
  if (before === undefined) return a.first_t_monotonic_ms + (frame - a.first_audio_frame) / 16;
  return before.t_monotonic_ms + (frame - before.audio_frame) / 16;
}

export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function isTwoAiManifest(manifest: Record<string, unknown> | null): boolean {
  return manifest?.mode === 'two_ai';
}
