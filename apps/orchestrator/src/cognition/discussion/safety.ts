/**
 * 安全（02 §2.7、00 の「話題の安全」）。
 * - 生成文の検査：(1) 禁止の語、(1b) 人物の語と評価・推測の語が同じ文にある、(2) 二人称、(3) 記号・絵文字・名札（取り除いて使う）、
 *   (4) 計画にない C の語と取り違えた値。
 * - 台帳の段：sensitive に当たる項目と、それを根拠にする項目を、計画と生成の入力から外す。
 * 指導教員や家族への「伝え方」は話題にしてよい（人物の語だけなら通す）。人物の評価・推測と、健康・家族の不和は禁じる。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LedgerItem, ProblemLedger } from './types';
import { splitSentences } from './text';

export const PersonEvaluationPairs = z.strictObject({
  version: z.number().int().min(1),
  note: z.string().optional(),
  person_terms: z.array(z.string().min(1)).min(1),
  evaluation_terms: z.array(z.string().min(1)).min(1),
});
export type PersonEvaluationPairs = z.infer<typeof PersonEvaluationPairs>;

export interface SafetyLists {
  banned_terms: string[];
  person_terms: string[];
  evaluation_terms: string[];
}

/** banned_terms.ja.txt：1 行に 1 語。# から行末は注記。 */
export function parseBannedTerms(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '');
}

export function loadSafetyLists(files: { banned_terms_file: string; person_evaluation_pairs_file: string }, root: string): SafetyLists {
  const banned = parseBannedTerms(readFileSync(path.resolve(root, files.banned_terms_file), 'utf8'));
  const pairs = PersonEvaluationPairs.parse(JSON.parse(readFileSync(path.resolve(root, files.person_evaluation_pairs_file), 'utf8')));
  return { banned_terms: banned, person_terms: pairs.person_terms, evaluation_terms: pairs.evaluation_terms };
}

export type SafetyRule = 'banned_term' | 'person_evaluation' | 'second_person' | 'c_term' | 'slip_value';

export interface SafetyContext {
  /** C の語。c_ban が false（体験の旗）なら照らさない。 */
  c_terms: readonly string[];
  c_ban: boolean;
  /** 取り違えた文と値（この文に出てはいけないもの）。 */
  slip_terms: readonly string[];
}

export const NO_CONTEXT: SafetyContext = { c_terms: [], c_ban: false, slip_terms: [] };

export interface SafetyResult {
  ok: boolean;
  rule: SafetyRule | null;
  matched: string | null;
  /** (3) を取り除いた文。 */
  cleaned: string;
}

const NAME_TAG = /^\s*(?:[AB]|アオイ|ハル|[^\s：:]{1,6})\s*[：:]\s*/u;
const SYMBOLS = /[\p{Extended_Pictographic}*#＊＃•●■□◆◇★☆→←↑↓|｜`~＿_>＞\[\]【】]/gu;
const SECOND_PERSON = /あなた|貴方|君は|君が|君の|君も|君に|お前/u;

/** (3) 記号、絵文字、名札を取り除く。 */
export function cleanSymbols(text: string, nameTags: readonly string[] = []): string {
  let out = text;
  for (const tag of nameTags) {
    const re = new RegExp(`^\\s*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]\\s*`, 'u');
    out = out.replace(re, '');
  }
  if (/^\s*[AB]\s*[：:]/u.test(out)) out = out.replace(NAME_TAG, '');
  out = out.replace(SYMBOLS, '').replace(/^\s*[-・]\s*/gmu, '').replace(/\s*\n\s*/g, '').trim();
  return out;
}

export function checkText(text: string, lists: SafetyLists, ctx: SafetyContext, nameTags: readonly string[] = []): SafetyResult {
  const cleaned = cleanSymbols(text, nameTags);
  const hit = (rule: SafetyRule, matched: string): SafetyResult => ({ ok: false, rule, matched, cleaned });
  for (const term of lists.banned_terms) if (cleaned.includes(term)) return hit('banned_term', term);
  for (const sentence of splitSentences(cleaned)) {
    const person = lists.person_terms.find((t) => sentence.includes(t));
    const evaluation = lists.evaluation_terms.find((t) => sentence.includes(t));
    if (person !== undefined && evaluation !== undefined) return hit('person_evaluation', `${person}+${evaluation}`);
  }
  const second = SECOND_PERSON.exec(cleaned);
  if (second) return hit('second_person', second[0]);
  if (ctx.c_ban) for (const term of ctx.c_terms) if (term !== '' && cleaned.includes(term)) return hit('c_term', term);
  for (const term of ctx.slip_terms) if (term !== '' && cleaned.includes(term)) return hit('slip_value', term);
  return { ok: true, rule: null, matched: null, cleaned };
}

/** 台帳の項目の文が安全でなければ true（人物の評価、禁止の語）。 */
function itemUnsafe(item: LedgerItem, lists: SafetyLists): boolean {
  return !checkText(item.text, lists, NO_CONTEXT).ok || item.evidence.some((e) => !checkText(e.span, lists, NO_CONTEXT).ok);
}

/** sensitive の根拠と重なる根拠を持つか。 */
function overlapsSensitive(item: LedgerItem, ledger: ProblemLedger): boolean {
  return item.evidence.some((e) =>
    ledger.sensitive.some(
      (s) =>
        e.segment_ids.some((id) => s.evidence.segment_ids.includes(id)) &&
        (e.span.includes(s.evidence.span) || s.evidence.span.includes(e.span)),
    ),
  );
}

/**
 * 計画と生成に渡す台帳（sensitive に当たる項目と、それを根拠にする項目を外す）。
 * 外した項目の id を excluded に返す（記録用）。人物の語を含む「伝え方」の項目は残る。
 */
export function safeLedger(ledger: ProblemLedger, lists: SafetyLists): { ledger: ProblemLedger; excluded: string[] } {
  const excluded: string[] = [];
  const keep = <T extends LedgerItem>(item: T): boolean => {
    const bad = overlapsSensitive(item, ledger) || itemUnsafe(item, lists);
    if (bad) excluded.push(item.id);
    return !bad;
  };
  const core = ledger.core !== null && keep(ledger.core) ? ledger.core : null;
  return {
    ledger: {
      ...ledger,
      core,
      options: ledger.options.filter(keep),
      dropped_options: ledger.dropped_options.filter(keep),
      facts: ledger.facts.filter(keep),
      values: ledger.values.filter(keep),
      sensitive: [],
    },
    excluded,
  };
}
