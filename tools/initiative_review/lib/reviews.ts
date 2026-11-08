/**
 * 評価の保存。sessions/<id>/initiative_review/<評価者>.json（sessions/ ごと git の対象外）。
 * 評価者ごとに別のファイルにして、複数人の評価が混ざらないようにする。一致度の計算は持たない。
 * 同じ評価者のファイルを2つの画面で同時に編集したときは revision の不一致で 409 にする（黙って上書きしない）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { SESSION_ID } from './session';

export const REVIEW_FORMAT = 'initiative_review/1';

// ①内容の妥当性（その立場で言う価値があるか）。NONE の判定では「言わない判断の妥当性」として読む。
const CONTENT_VALUES = ['valid', 'partly', 'invalid', 'cannot_judge'] as const;
// ②申し出る時点の適切さ。wait_until_end は「話し終わってからで十分」（計画 §4.5a の「今申し出る必要性」に対応）。
const TIMING_VALUES = ['good', 'early', 'late', 'wait_until_end', 'cannot_judge', 'not_applicable'] as const;
// ③待機・撤回の妥当性。
const WAIT_VALUES = ['appropriate', 'should_have_spoken_sooner', 'should_have_withdrawn', 'should_not_have_withdrawn', 'cannot_judge', 'not_applicable'] as const;

export type ContentRating = (typeof CONTENT_VALUES)[number];
export type TimingRating = (typeof TIMING_VALUES)[number];
export type WaitRating = (typeof WAIT_VALUES)[number];

export interface ItemSnapshot {
  kind: string;
  t_ms: number;
  headline: string;
  prompt_versions: string[];
  conversation_type: string;
}

export interface ItemReview {
  content: ContentRating | null;
  timing: TimingRating | null;
  wait_withdraw: WaitRating | null;
  notes: string;
  updated_at: string;
  /** 何を評価したかの控え。ログの読み方が変わっても評価と判定を対応づけられるようにする。 */
  snapshot: ItemSnapshot;
}

/** 判定が NONE の区間でも、「ここで言いたいことがあったはず」を内容で書く印。 */
export interface MissedMark {
  id: string;
  /** 印を付けた会話の時刻（t_monotonic_ms）。 */
  t_ms: number;
  /** 起点の判定（一覧の鍵）。会話の行から付けたときは null。 */
  anchor_item_key: string | null;
  /** 起点の会話の行（TranscriptLine.id）。 */
  anchor_line_id: string | null;
  /** 言いたかった内容（必須）。 */
  content: string;
  /** いつ言うべきだったかの覚え書き。 */
  timing_note: string;
  created_at: string;
  updated_at: string;
}

export interface ReviewDocument {
  format: typeof REVIEW_FORMAT;
  session_id: string;
  reviewer: string;
  revision: number;
  updated_at: string;
  items: Record<string, ItemReview>;
  missed: MissedMark[];
}

export class ReviewConflict extends Error {
  constructor(readonly current: ReviewDocument) {
    super('review revision conflict');
  }
}

export class ReviewInvalid extends Error {}

const MAX_NOTES = 20000;
const MAX_ITEMS = 5000;
const MAX_MISSED = 2000;

function fail(message: string): never {
  throw new ReviewInvalid(message);
}

export function normalizeReviewer(raw: unknown): string {
  if (typeof raw !== 'string') fail('reviewer must be a string');
  const name = raw.normalize('NFC').trim();
  if (name === '') fail('reviewer is empty');
  if (name.length > 40) fail('reviewer is too long');
  if (encodeURIComponent(name).length > 200) fail('reviewer is too long');
  return name;
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function stringOf(value: unknown, what: string, limit: number): string {
  if (typeof value !== 'string') fail(`${what} must be a string`);
  if (value.length > limit) fail(`${what} is too long`);
  return value;
}

function optionalEnum<T extends readonly string[]>(value: unknown, values: T, what: string): T[number] | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !values.includes(value)) fail(`${what} has an unknown value: ${String(value)}`);
  return value as T[number];
}

function finiteNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${what} must be a number`);
  return value;
}

function snapshotOf(value: unknown): ItemSnapshot {
  const o = asObject(value, 'snapshot');
  if (!Array.isArray(o.prompt_versions)) fail('snapshot.prompt_versions must be an array');
  return {
    kind: stringOf(o.kind, 'snapshot.kind', 40),
    t_ms: finiteNumber(o.t_ms, 'snapshot.t_ms'),
    headline: stringOf(o.headline, 'snapshot.headline', 400),
    prompt_versions: o.prompt_versions.map((v) => stringOf(v, 'prompt_version', 200)),
    conversation_type: stringOf(o.conversation_type, 'snapshot.conversation_type', 200),
  };
}

function itemOf(value: unknown): ItemReview {
  const o = asObject(value, 'item');
  return {
    content: optionalEnum(o.content, CONTENT_VALUES, 'content'),
    timing: optionalEnum(o.timing, TIMING_VALUES, 'timing'),
    wait_withdraw: optionalEnum(o.wait_withdraw, WAIT_VALUES, 'wait_withdraw'),
    notes: stringOf(o.notes ?? '', 'notes', MAX_NOTES),
    updated_at: stringOf(o.updated_at, 'updated_at', 40),
    snapshot: snapshotOf(o.snapshot),
  };
}

function missedOf(value: unknown): MissedMark {
  const o = asObject(value, 'missed');
  const content = stringOf(o.content, 'missed.content', MAX_NOTES);
  if (content.trim() === '') fail('missed.content is empty');
  return {
    id: stringOf(o.id, 'missed.id', 80),
    t_ms: finiteNumber(o.t_ms, 'missed.t_ms'),
    anchor_item_key: o.anchor_item_key === null || o.anchor_item_key === undefined ? null : stringOf(o.anchor_item_key, 'missed.anchor_item_key', 200),
    anchor_line_id: o.anchor_line_id === null || o.anchor_line_id === undefined ? null : stringOf(o.anchor_line_id, 'missed.anchor_line_id', 80),
    content,
    timing_note: stringOf(o.timing_note ?? '', 'missed.timing_note', MAX_NOTES),
    created_at: stringOf(o.created_at, 'missed.created_at', 40),
    updated_at: stringOf(o.updated_at, 'missed.updated_at', 40),
  };
}

export class ReviewStore {
  constructor(private readonly sessionsDir: string) {}

  private dir(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) fail('bad session id');
    const root = path.resolve(this.sessionsDir);
    const dir = path.join(root, sessionId);
    if (path.dirname(dir) !== root || !existsSync(path.join(dir, 'events.jsonl'))) fail('unknown session');
    return path.join(dir, 'initiative_review');
  }

  private file(sessionId: string, reviewer: string): string {
    return path.join(this.dir(sessionId), `${encodeURIComponent(reviewer)}.json`);
  }

  /** この記録の評価者の名前（他の人の評価の中身は返さない）。 */
  reviewers(sessionId: string): string[] {
    const dir = this.dir(sessionId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => decodeURIComponent(name.slice(0, -'.json'.length)))
      .sort();
  }

  load(sessionId: string, rawReviewer: unknown): ReviewDocument | null {
    const reviewer = normalizeReviewer(rawReviewer);
    const file = this.file(sessionId, reviewer);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as ReviewDocument;
  }

  /** 保存。baseRevision が現在の revision と違えば ReviewConflict。 */
  save(sessionId: string, rawReviewer: unknown, body: unknown, baseRevision: number): ReviewDocument {
    const reviewer = normalizeReviewer(rawReviewer);
    const input = asObject(body, 'body');
    const itemsInput = asObject(input.items ?? {}, 'items');
    const entries = Object.entries(itemsInput);
    if (entries.length > MAX_ITEMS) fail('too many items');
    const items: Record<string, ItemReview> = {};
    for (const [key, value] of entries) {
      stringOf(key, 'item key', 200);
      items[key] = itemOf(value);
    }
    const missedInput = input.missed ?? [];
    if (!Array.isArray(missedInput)) fail('missed must be an array');
    if (missedInput.length > MAX_MISSED) fail('too many missed marks');
    const missed = missedInput.map(missedOf);
    if (new Set(missed.map((m) => m.id)).size !== missed.length) fail('missed ids must be unique');

    const current = this.load(sessionId, reviewer);
    if ((current?.revision ?? 0) !== baseRevision) {
      throw new ReviewConflict(
        current ?? { format: REVIEW_FORMAT, session_id: sessionId, reviewer, revision: 0, updated_at: '', items: {}, missed: [] },
      );
    }
    const document: ReviewDocument = {
      format: REVIEW_FORMAT,
      session_id: sessionId,
      reviewer,
      revision: baseRevision + 1,
      updated_at: new Date().toISOString(),
      items,
      missed: [...missed].sort((a, b) => a.t_ms - b.t_ms),
    };
    const dir = this.dir(sessionId);
    mkdirSync(dir, { recursive: true });
    const file = this.file(sessionId, reviewer);
    const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      renameSync(temporary, file);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    return document;
  }
}
