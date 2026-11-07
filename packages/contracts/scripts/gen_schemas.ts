/** zod から JSON Schema と言語共通の固定サンプルを生成する。`npm run gen:schemas`。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINARY_FIXTURES, INVALID_FIXTURES, VALID_FIXTURES } from '../src/fixtures';
import { SCHEMAS, toJsonSchema, type SchemaName } from '../src/schema_registry';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

for (const name of Object.keys(SCHEMAS) as SchemaName[]) {
  writeJson(join(root, 'schemas', `${name}.schema.json`), toJsonSchema(name));
}
writeJson(join(root, 'fixtures', 'contract_fixtures.json'), {
  note: 'Generated from src/fixtures.ts. Synthetic values for schema checks, not measurements.',
  valid: VALID_FIXTURES,
  invalid: INVALID_FIXTURES,
  binary: BINARY_FIXTURES,
});
console.log(`wrote ${Object.keys(SCHEMAS).length} schemas and fixtures`);
