/**
 * 02 の設定ファイルの読み込み（人格、点の文型、予備の筋書き、安全の一覧）。正本は zod（06 §9.4）で、読み込みで parse する。
 * セッションの設定と台本の読み込みは WP1／WP4（ここは 02 の持ち物のファイルだけ）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TwoAiFallbackOutline, TwoAiPersonas, TwoAiPointTemplates, type TwoAiSessionConfig } from '@llm-vap/contracts';
import { loadSafetyLists, type SafetyLists } from './safety';

export interface DiscussionAssets {
  personas: TwoAiPersonas;
  templates: TwoAiPointTemplates;
  outline: TwoAiFallbackOutline;
  safety: SafetyLists;
}

export const DEFAULT_ASSET_FILES = {
  personas: 'config/two_ai/personas.ja.json',
  templates: 'config/two_ai/point_templates.ja.json',
  outline: 'config/two_ai/fallback_outline.ja.json',
} as const;

function readJson(root: string, file: string): unknown {
  return JSON.parse(readFileSync(path.resolve(root, file), 'utf8'));
}

/** root はリポジトリの根。personas_file は台本の personas_file（なければ既定）。 */
export function loadDiscussionAssets(root: string, config: TwoAiSessionConfig, personas_file: string = DEFAULT_ASSET_FILES.personas): DiscussionAssets {
  return {
    personas: TwoAiPersonas.parse(readJson(root, personas_file)),
    templates: TwoAiPointTemplates.parse(readJson(root, DEFAULT_ASSET_FILES.templates)),
    outline: TwoAiFallbackOutline.parse(readJson(root, DEFAULT_ASSET_FILES.outline)),
    safety: loadSafetyLists(config.safety, root),
  };
}
