/**
 * 方策の上書き（開発用の調整画面 /tune が書く config/policy.ja.local.json）。
 *
 *  - 上書きは正本（config/policy.ja.json）との差分だけを持つ JSON。節（オブジェクト）は再帰的に重ね、
 *    値（数、真偽、文字列、null、配列）はそのまま置き換える。節の省略を表す手段はない（消すときは正本を直す）。
 *  - 重ねた結果は契約の Policy で検証する。知らない項目（strictObject）や範囲外の値はここで落ちる。
 *  - policy_id と immutable は変えられない（別の方策にすり替えない）。
 *  - 正本は書き換えない。上書きファイルは git の対象外（.gitignore）。
 *
 * orchestrator は起動時に POLICY_OVERRIDE_FILE を指定したときだけ読む（app/config.ts）。暗黙には読まない。
 */
import { readFileSync } from 'node:fs';
import { Policy, type PolicyOverrideInfo } from '@llm-vap/contracts';

export type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** override を base に重ねた新しい値（base は変えない）。 */
export function mergeOverride(base: unknown, override: unknown): unknown {
  if (!isObject(base) || !isObject(override)) return structuredClone(override);
  const out: JsonObject = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in out && isObject(out[key]) && isObject(value) ? mergeOverride(out[key], value) : structuredClone(value);
  }
  return out;
}

/** edited のうち base と違う所だけ（mergeOverride(base, diff) が edited と同じ値になる）。違いがなければ undefined。 */
export function diffOverride(base: unknown, edited: unknown): unknown {
  if (isObject(base) && isObject(edited)) {
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(edited)) {
      if (!(key in base)) {
        out[key] = structuredClone(value);
        continue;
      }
      const d = diffOverride(base[key], value);
      if (d !== undefined) out[key] = d;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  return JSON.stringify(base) === JSON.stringify(edited) ? undefined : structuredClone(edited);
}

/** 上書きの葉の路（例 turn.start_guard.min_gap_ms）。配列と null は葉。 */
export function overrideKeys(override: unknown, prefix = ''): string[] {
  if (!isObject(override)) return prefix === '' ? [] : [prefix];
  return Object.entries(override).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return isObject(value) && Object.keys(value).length > 0 ? overrideKeys(value, path) : [path];
  });
}

/** 路で値を引く（表示用）。 */
export function valueAt(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split('.')) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

export type OverrideCheck =
  | { ok: true; policy: Policy; keys: string[] }
  | { ok: false; reason: string };

/** 上書きを検証して重ねる。base は検証済みの正本。 */
export function applyOverride(base: Policy, override: unknown): OverrideCheck {
  if (!isObject(override)) return { ok: false, reason: 'override must be a JSON object' };
  for (const fixed of ['policy_id', 'immutable'] as const) {
    if (fixed in override && override[fixed] !== base[fixed]) {
      return { ok: false, reason: `${fixed} cannot be overridden (${String(base[fixed])})` };
    }
  }
  if (base.immutable) return { ok: false, reason: `policy ${base.policy_id} is immutable` };
  const parsed = Policy.safeParse(mergeOverride(base, override));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'policy schema violation' };
  }
  return { ok: true, policy: parsed.data, keys: overrideKeys(override) };
}

/** ファイルを読んで重ねる。読めない・検証に落ちる場合は例外（起動を止める。黙って正本で動かない）。 */
export function loadOverrideFile(base: Policy, file: string): { policy: Policy; info: PolicyOverrideInfo; override: unknown } {
  let override: unknown;
  try {
    override = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`POLICY_OVERRIDE_FILE ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const checked = applyOverride(base, override);
  if (!checked.ok) throw new Error(`POLICY_OVERRIDE_FILE ${file}: ${checked.reason}`);
  return { policy: checked.policy, info: { file, keys: checked.keys }, override };
}

/** 起動ログの1行（値は方策の数値で、秘密は含まない）。 */
export function describeOverride(info: PolicyOverrideInfo, policy: Policy): string {
  const items = info.keys.map((key) => `${key}=${JSON.stringify(valueAt(policy, key))}`);
  return `policy override ${info.file} (${info.keys.length} items): ${items.join(', ') || '(none)'}`;
}
