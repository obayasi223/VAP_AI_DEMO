/**
 * sessions/<id>/ を読み、評価画面の形（ReviewSession）にする。絞り込みもここ（純粋な関数）。
 *
 * 会話の種類（共同思考／コンパニオン）は、判定のイベント（二段判定の conversation_kind）が1種類ならそれ、
 * なければ manifest の項目。どちらにも無ければ persona_id を「persona: <id>」として代わりに出す（推測で種類を割り当てない）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { assemble } from './assemble';
import type { ItemFilter, ReviewItem, ReviewSession, SessionMeta } from './model';
import { collect, conversationLabel, parseJsonl, str } from './readers';

export { conversationLabel };

export const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const AUDIO_EXTENSIONS = new Set(['.wav', '.webm', '.ogg', '.oga', '.mp3', '.m4a', '.flac']);

type Manifest = Record<string, unknown>;

function readManifest(dir: string, warnings: string[]): Manifest {
  const file = path.join(dir, 'manifest.json');
  if (!existsSync(file)) {
    warnings.push('manifest.json がありません。');
    return {};
  }
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof value === 'object' && value !== null ? (value as Manifest) : {};
  } catch {
    warnings.push('manifest.json を読めません（書き込みの途中かもしれません）。');
    return {};
  }
}

function conversationTypeOf(manifest: Manifest): { conversation_type: string; persona_id: string | null } {
  const initiative = (manifest.initiative ?? {}) as Record<string, unknown>;
  const persona_id = str(initiative.persona_id) ?? str(manifest.persona_id);
  for (const candidate of [manifest.conversation_kind, initiative.conversation_kind, manifest.conversation_type, initiative.conversation_type]) {
    const value = str(candidate);
    if (value !== null) return { conversation_type: conversationLabel(value), persona_id };
  }
  return { conversation_type: persona_id === null ? '（記録なし）' : `persona: ${persona_id}`, persona_id };
}

function manifestHasKind(manifest: Manifest): boolean {
  const initiative = (manifest.initiative ?? {}) as Record<string, unknown>;
  return [manifest.conversation_kind, initiative.conversation_kind, manifest.conversation_type, initiative.conversation_type].some((v) => str(v) !== null);
}

export function listAudioFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()));
}

export function loadSession(dir: string): ReviewSession {
  const session_id = path.basename(dir);
  const warnings: string[] = [];
  const parsed = parseJsonl(readFileSync(path.join(dir, 'events.jsonl'), 'utf8'));
  if (parsed.invalid > 0) warnings.push(`読めない行が ${parsed.invalid} 行あります。`);
  const manifest = readManifest(dir, warnings);
  const initiative = (manifest.initiative ?? {}) as Record<string, unknown>;
  const fromManifest = conversationTypeOf(manifest);
  const persona_id = fromManifest.persona_id;
  const default_prompt_version = str(initiative.prompt_version);
  const condition = str(manifest.condition);
  const collected = collect(parsed.events);
  const kinds = [...new Set(collected.decisions.flatMap((d) => (d.conversation_kind === null ? [] : [conversationLabel(d.conversation_kind)])))];
  // 判定の記録が1種類ならそれが実際に使った種類。manifest と違うなら残す。複数なら判定ごとに見る（セッションの表示は manifest のまま）。
  if (kinds.length > 1) warnings.push(`判定に複数の会話の種類があります（${kinds.join('、')}）。`);
  const conversation_type = kinds.length === 1 ? (kinds[0] as string) : fromManifest.conversation_type;
  if (kinds.length === 1 && manifestHasKind(manifest) && kinds[0] !== fromManifest.conversation_type) {
    warnings.push(`manifest の会話の種類（${fromManifest.conversation_type}）と判定の記録（${kinds[0] as string}）が違います。判定の記録を使います。`);
  }
  const { items, lines, hasAudioMap } = assemble(collected, { session_id, condition, conversation_type, default_prompt_version });
  const prompt_versions = [...new Set([...items.flatMap((i) => i.prompt_versions), ...(default_prompt_version === null ? [] : [default_prompt_version])])];
  const meta: SessionMeta = {
    session_id,
    started_wall_clock: str(manifest.started_wall_clock),
    condition,
    conversation_type,
    persona_id,
    prompt_versions,
    audio_files: listAudioFiles(dir),
  };
  return { meta, items, lines, has_audio_map: hasAudioMap, warnings };
}

export function listSessionDirs(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .filter((id) => SESSION_ID.test(id) && existsSync(path.join(sessionsDir, id, 'events.jsonl')))
    .sort((a, b) => b.localeCompare(a));
}

export function eventsStamp(dir: string): string {
  const stat = statSync(path.join(dir, 'events.jsonl'));
  return `${stat.mtimeMs}:${stat.size}`;
}

// ---- 絞り込み ------------------------------------------------------------------

export function itemMatches(item: ReviewItem, filter: ItemFilter): boolean {
  if (filter.conversation_type && item.conversation_type !== filter.conversation_type) return false;
  if (filter.prompt_version && !item.prompt_versions.includes(filter.prompt_version)) return false;
  return true;
}

export function filterItems(items: ReviewItem[], filter: ItemFilter): ReviewItem[] {
  return items.filter((item) => itemMatches(item, filter));
}

export function sessionMatches(meta: SessionMeta, filter: ItemFilter): boolean {
  if (filter.conversation_type && meta.conversation_type !== filter.conversation_type) return false;
  if (filter.prompt_version && !meta.prompt_versions.includes(filter.prompt_version)) return false;
  return true;
}

export function filterOptions(metas: SessionMeta[]): { conversation_types: string[]; prompt_versions: string[] } {
  return {
    conversation_types: [...new Set(metas.map((m) => m.conversation_type))].sort(),
    prompt_versions: [...new Set(metas.flatMap((m) => m.prompt_versions))].sort(),
  };
}
