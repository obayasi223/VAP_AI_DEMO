/** 素材の場所と読み込み。InitiativeMonitor の判定はここに置かない（apps/orchestrator/src/cognition/initiative/）。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PolicyJa, SttFinalEvent, SttInterimEvent } from '@llm-vap/contracts';
import { parsePersona } from '../../../apps/orchestrator/src/cognition/initiative/persona';
import type { InitiativePersona } from '../../../apps/orchestrator/src/cognition/initiative/persona';
import type { SttEvent } from '../../../apps/orchestrator/src/cognition/initiative/transcript_view';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const FIXTURES = join(ROOT, 'fixtures', 'initiative');
export const HANDWRITTEN_DIR = join(FIXTURES, 'handwritten');
export const RECORDED_DIR = join(FIXTURES, 'recorded');
export const RUNS_DIR = join(FIXTURES, 'runs');
export const RECORDINGS_DIR = join(ROOT, 'recordings', 'initiative');

export type Outcome =
  | 'no_candidate'
  | 'no_candidate_or_withdrawn'
  | 'candidate_kept'
  | 'candidate_any'
  | 'not_applicable_until_g3';

export interface InjectSpec {
  correct: string;
  wrong: string;
  stage: 'unstable' | 'stable';
  hold_ms: number;
}

export interface Scenario {
  id: string;
  kind: 'counterexample' | 'validation' | 'held_out';
  title: string;
  expected: { outcome: Outcome; layer: string; gate: string; summary: string };
  reading_note?: string;
  text?: string;
  read_as?: string;
  handwritten_only?: boolean;
  inject?: InjectSpec;
  persona?: string;
}

export function loadScenarios(): Scenario[] {
  const raw = JSON.parse(readFileSync(join(FIXTURES, 'scenarios.ja.json'), 'utf8')) as { scenarios: Scenario[] };
  return raw.scenarios;
}

export function scenarioText(scenario: Scenario, all: readonly Scenario[]): string {
  const source = scenario.read_as ? all.find((s) => s.id === scenario.read_as) : scenario;
  if (!source?.text) throw new Error(`scenario ${scenario.id} has no text`);
  return source.text;
}

export function loadPersona(scenario: Scenario | null): InitiativePersona {
  const path = scenario?.persona ? join(ROOT, scenario.persona) : join(ROOT, 'config', 'persona.ja.json');
  return parsePersona(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadPolicy(): PolicyJa {
  return PolicyJa.parse(JSON.parse(readFileSync(join(ROOT, 'config', 'policy.ja.json'), 'utf8')));
}

/** §3.5 の stt.* の JSONL を読む。契約に合わない行があれば行番号つきで失敗する。 */
export function readSttJsonl(path: string): SttEvent[] {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, index) => {
    const raw = JSON.parse(line) as { event?: string };
    const schema = raw.event === 'stt.final' ? SttFinalEvent : SttInterimEvent;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error(`${path}:${index + 1}: ${parsed.error.message}`);
    return parsed.data;
  });
}

export function writeJsonl(path: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function sttPath(origin: 'handwritten' | 'recorded', id: string, take = 1): string {
  return origin === 'handwritten'
    ? join(HANDWRITTEN_DIR, `${id}.not_real_asr.stt.jsonl`)
    : join(RECORDED_DIR, `${id}.take${take}.stt.jsonl`);
}

export { existsSync };
