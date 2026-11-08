/**
 * 方策の項目を契約のスキーマ（packages/contracts/src/policy.ts の PolicyJa）から動的に列挙する（/tune の編集欄）。
 * 項目名をここに書かないので、契約に項目が増えれば画面にも自動で出る。
 * 記録（record）の節は、今の値にある鍵だけを列挙する（例 completion.thresholds.ja_rules_v1）。
 */
import { z } from 'zod';
import { PolicyHri2025, PolicyJa, type Policy, type TunePolicyLeaf } from '@llm-vap/contracts';

type Schema = { [key: string]: unknown };

export function policyJsonSchema(policy: Policy): Schema {
  return z.toJSONSchema(policy.policy_id === 'ja' ? PolicyJa : PolicyHri2025, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Schema;
}

function variants(schema: Schema): { nullable: boolean; inner: Schema } {
  const anyOf = schema.anyOf as Schema[] | undefined;
  if (!Array.isArray(anyOf)) return { nullable: false, inner: schema };
  const nonNull = anyOf.filter((s) => s.type !== 'null');
  const nullable = nonNull.length !== anyOf.length;
  return { nullable, inner: nonNull.length === 1 ? (nonNull[0] as Schema) : schema };
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function leafOf(path: string, schema: Schema, nullable: boolean, optionalParent: string | null): TunePolicyLeaf | null {
  const description = typeof schema.description === 'string' ? schema.description : null;
  const base = { path, nullable, optional_parent: optionalParent, description };
  if (Array.isArray(schema.enum)) {
    const options = schema.enum.map(String);
    if (options.length <= 1) return null; // リテラル（policy_id など）は変えない
    return { ...base, kind: 'enum', minimum: null, maximum: null, options };
  }
  if ('const' in schema) return null;
  switch (schema.type) {
    case 'number':
    case 'integer':
      return {
        ...base,
        kind: schema.type,
        minimum: num(schema.minimum) ?? num(schema.exclusiveMinimum),
        maximum: num(schema.maximum) ?? num(schema.exclusiveMaximum),
        options: null,
      };
    case 'boolean':
      return { ...base, kind: 'boolean', minimum: null, maximum: null, options: null };
    case 'string':
      return { ...base, kind: 'string', minimum: null, maximum: null, options: null };
    case 'array': {
      const items = schema.items as Schema | undefined;
      if (items?.type === 'string') return { ...base, kind: 'string_array', minimum: null, maximum: null, options: null };
      return null;
    }
    default:
      return null;
  }
}

/** 値の項目を列挙する。$schema と note は編集の対象にしない（来歴の文）。 */
export function policyLeaves(policy: Policy): TunePolicyLeaf[] {
  const out: TunePolicyLeaf[] = [];
  const walk = (schema: Schema, value: unknown, path: string, optionalParent: string | null) => {
    const { nullable, inner } = variants(schema);
    if (inner.type === 'object') {
      const props = inner.properties as Record<string, Schema> | undefined;
      const required = new Set((inner.required as string[] | undefined) ?? []);
      const record = inner.additionalProperties as Schema | boolean | undefined;
      const current = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
      if (props !== undefined) {
        for (const [key, child] of Object.entries(props)) {
          const childPath = path === '' ? key : `${path}.${key}`;
          if (childPath === '$schema' || childPath === 'note') continue;
          const optional = !required.has(key) ? childPath : optionalParent;
          walk(child, current[key], childPath, optional);
        }
      } else if (typeof record === 'object') {
        for (const key of Object.keys(current)) walk(record, current[key], path === '' ? key : `${path}.${key}`, optionalParent);
      }
      return;
    }
    const leaf = leafOf(path, inner, nullable, optionalParent);
    if (leaf !== null) out.push(leaf);
  };
  walk(policyJsonSchema(policy), policy, '', null);
  return out;
}
