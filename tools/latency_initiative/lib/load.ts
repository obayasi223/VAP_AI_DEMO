/** 引数のパス（セッションの親、セッション、events.jsonl、glob）を読み、候補ごとの遅延にする。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { analyzeSession, type CandidateLatency, type RawEvent } from './analyze';

const GLOB_CHARS = /[*?[\]{}]/;

async function isFile(target: string): Promise<boolean> {
  return fs.stat(target).then((s) => s.isFile(), () => false);
}

async function isDirectory(target: string): Promise<boolean> {
  return fs.stat(target).then((s) => s.isDirectory(), () => false);
}

/** 1 つの引数を events.jsonl のパスの列へ展開する。 */
export async function resolveEventFiles(arg: string): Promise<string[]> {
  if (GLOB_CHARS.test(arg)) {
    const matches: string[] = [];
    for await (const entry of fs.glob(arg)) matches.push(entry);
    const nested = await Promise.all(matches.sort().map((m) => resolvePlain(m)));
    return nested.flat();
  }
  return resolvePlain(arg);
}

async function resolvePlain(target: string): Promise<string[]> {
  if (await isFile(target)) return path.basename(target) === 'events.jsonl' ? [target] : [];
  if (!(await isDirectory(target))) return [];
  const direct = path.join(target, 'events.jsonl');
  if (await isFile(direct)) return [direct];
  const entries = await fs.readdir(target, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const inner = path.join(target, entry.name, 'events.jsonl');
    if (await isFile(inner)) found.push(inner);
  }
  return found;
}

export async function loadEvents(file: string): Promise<RawEvent[]> {
  const content = await fs.readFile(file, 'utf8');
  const events: RawEvent[] = [];
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) continue;
    events.push(JSON.parse(line) as RawEvent);
  }
  return events;
}

export async function analyzePaths(args: readonly string[]): Promise<{ files: string[]; rows: CandidateLatency[] }> {
  const files: string[] = [];
  for (const arg of args) files.push(...(await resolveEventFiles(arg)));
  const unique = [...new Set(files)];
  const rows: CandidateLatency[] = [];
  for (const file of unique) rows.push(...analyzeSession(await loadEvents(file)));
  return { files: unique, rows };
}
