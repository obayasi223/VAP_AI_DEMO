/**
 * 2 体のモードの設定・台本・人格・点の文型・予備の筋書きの読み込み（docs/design/two_ai/01 §3.1 の 1、06 §9）。
 * 起動時に設定と config/two_ai/scripts/ の台本をすべて（*.json と *.local.json）読み、契約と validatePointSchedule で検査する。
 * 合格した台本を script_id の表に入れる。不合格の台本は理由を残して表から外す。設定か既定の台本が不合格なら ok: false
 * （server は接続ごとに ws.close(1011, 理由)。黙って既定で動かない）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { TwoAiFallbackOutline, TwoAiPersonas, TwoAiPointTemplates, TwoAiScript, TwoAiSessionConfig, validatePointSchedule } from '@llm-vap/contracts';
import type { PointScheduleCheck } from '@llm-vap/contracts';
import { DEFAULT_ASSET_FILES } from '../cognition/discussion/assets';

export interface LoadedScript {
  script: TwoAiScript;
  /** リポジトリの根からの相対パス。 */
  file: string;
  sha256: string;
  schedule: PointScheduleCheck;
}

export interface TwoAiSettings {
  root: string;
  config: TwoAiSessionConfig;
  config_file: string;
  config_sha256: string;
  scripts: ReadonlyMap<string, LoadedScript>;
  /** TWO_AI_SCRIPT の台本。未指定なら null（arm で選ぶ）。 */
  default_script_id: string | null;
  /** 表から外した台本とその理由（起動ログ）。 */
  rejected: { file: string; reason: string }[];
}

export type TwoAiSettingsResult = { ok: true; settings: TwoAiSettings } | { ok: false; reason: string; rejected: { file: string; reason: string }[] };

export const DEFAULT_TWO_AI_CONFIG = 'config/two_ai/session.ja.json';
export const TWO_AI_SCRIPTS_DIR = 'config/two_ai/scripts';

export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function rel(root: string, file: string): string {
  return path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
}

function issues(error: unknown): string {
  if (error && typeof error === 'object' && 'issues' in error && Array.isArray((error as { issues: unknown[] }).issues)) {
    return (error as { issues: { path?: unknown[]; message?: string }[] }).issues
      .slice(0, 3)
      .map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? ''}`)
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

/** 台本 1 本の検査（契約、own は *.local.json、人格のファイルの存在、点の日程）。 */
export function checkScript(root: string, file: string, config: TwoAiSessionConfig, templates: TwoAiPointTemplates): { ok: true; loaded: LoadedScript } | { ok: false; reason: string } {
  let text: string;
  try {
    text = readFileSync(path.resolve(root, file), 'utf8');
  } catch (error) {
    return { ok: false, reason: `unreadable: ${issues(error)}` };
  }
  let script: TwoAiScript;
  try {
    script = TwoAiScript.parse(JSON.parse(text));
  } catch (error) {
    return { ok: false, reason: `contract: ${issues(error)}`.slice(0, 300) };
  }
  if (script.kind === 'own' && !file.endsWith('.local.json')) return { ok: false, reason: 'own scripts must be *.local.json' };
  if (!existsSync(path.resolve(root, script.personas_file))) return { ok: false, reason: `personas_file not found: ${script.personas_file}` };
  const schedule = validatePointSchedule(config, script.planned_points, templates, null);
  if (!schedule.ok) return { ok: false, reason: `point_schedule: ${schedule.reason ?? 'not ok'}` };
  return { ok: true, loaded: { script, file: rel(root, file), sha256: sha256Of(text), schedule } };
}

export function loadTwoAiSettings(input: { root: string; config_path: string | null; script_path: string | null }): TwoAiSettingsResult {
  const { root } = input;
  const config_file = rel(root, input.config_path ?? DEFAULT_TWO_AI_CONFIG);
  let configText: string;
  let config: TwoAiSessionConfig;
  try {
    configText = readFileSync(path.resolve(root, config_file), 'utf8');
    config = TwoAiSessionConfig.parse(JSON.parse(configText));
  } catch (error) {
    return { ok: false, reason: `two_ai config invalid (${config_file}): ${issues(error)}`.slice(0, 300), rejected: [] };
  }
  let templates: TwoAiPointTemplates;
  try {
    templates = TwoAiPointTemplates.parse(JSON.parse(readFileSync(path.resolve(root, DEFAULT_ASSET_FILES.templates), 'utf8')));
    TwoAiPersonas.parse(JSON.parse(readFileSync(path.resolve(root, DEFAULT_ASSET_FILES.personas), 'utf8')));
    TwoAiFallbackOutline.parse(JSON.parse(readFileSync(path.resolve(root, DEFAULT_ASSET_FILES.outline), 'utf8')));
  } catch (error) {
    return { ok: false, reason: `two_ai assets invalid: ${issues(error)}`.slice(0, 300), rejected: [] };
  }
  const scripts = new Map<string, LoadedScript>();
  const rejected: { file: string; reason: string }[] = [];
  const dir = path.resolve(root, TWO_AI_SCRIPTS_DIR);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  const candidates = files.map((f) => `${TWO_AI_SCRIPTS_DIR}/${f}`);
  const wanted = input.script_path === null ? null : rel(root, input.script_path);
  if (wanted !== null && !candidates.includes(wanted)) candidates.push(wanted);
  let default_script_id: string | null = null;
  for (const file of candidates) {
    const checked = checkScript(root, file, config, templates);
    if (!checked.ok) {
      rejected.push({ file, reason: checked.reason });
      if (file === wanted) return { ok: false, reason: `TWO_AI_SCRIPT invalid (${file}): ${checked.reason}`, rejected };
      continue;
    }
    const id = checked.loaded.script.script_id;
    if (scripts.has(id)) {
      rejected.push({ file, reason: `duplicate script_id ${id}` });
      if (file === wanted) return { ok: false, reason: `TWO_AI_SCRIPT duplicates script_id ${id}`, rejected };
      continue;
    }
    scripts.set(id, checked.loaded);
    if (file === wanted) default_script_id = id;
  }
  return { ok: true, settings: { root, config, config_file, config_sha256: sha256Of(configText), scripts, default_script_id, rejected } };
}
