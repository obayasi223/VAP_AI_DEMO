/**
 * 調整画面（/tune）の方策の編集の部品。React に依存しない。
 *
 * 項目の一覧は Node の dev 口が契約のスキーマから列挙したもの（TunePolicyLeaf）。ここに項目名を書かないので、
 * 契約に項目が増えれば編集欄にも自動で出る。閾値の線だけは、既知の路に加えて名前の規則（p_now／PNOW／p_ai など）で拾う。
 */
import type { TunePolicyLeaf } from '@llm-vap/contracts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function getAt(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** 路に値を置いた新しい値（元は変えない）。途中の節がなければ作る。 */
export function setAt<T>(value: T, path: string, next: unknown): T {
  const keys = path.split('.');
  const out = structuredClone(value) as Record<string, unknown>;
  let node = out;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) {
      node[key] = next;
      return;
    }
    const child = node[key];
    if (typeof child !== 'object' || child === null || Array.isArray(child)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  });
  return out as T;
}

/** 路の節を消した新しい値（省略できる節を「省略」に戻す）。 */
export function deleteAt<T>(value: T, path: string): T {
  const keys = path.split('.');
  const out = structuredClone(value) as Record<string, unknown>;
  let node: Record<string, unknown> | undefined = out;
  for (const key of keys.slice(0, -1)) {
    const child: unknown = node?.[key];
    if (typeof child !== 'object' || child === null) return out as T;
    node = child as Record<string, unknown>;
  }
  if (node) delete node[keys[keys.length - 1] as string];
  return out as T;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** base と違う葉の路。 */
export function changedPaths(leaves: TunePolicyLeaf[], base: unknown, edited: unknown): string[] {
  return leaves.filter((l) => !sameJson(getAt(base, l.path), getAt(edited, l.path))).map((l) => l.path);
}

/** 節（最上位の鍵）ごとに並べる。 */
export function groupLeaves(leaves: TunePolicyLeaf[]): { section: string; leaves: TunePolicyLeaf[] }[] {
  const groups = new Map<string, TunePolicyLeaf[]>();
  for (const leaf of leaves) {
    const section = leaf.path.split('.')[0] as string;
    groups.set(section, [...(groups.get(section) ?? []), leaf]);
  }
  return [...groups.entries()].map(([section, items]) => ({ section, leaves: items }));
}

/** 再生（TurnManager の step）に効く節か。initiative.trigger は起動の回数の数え直しに効く。 */
export function replayEffect(path: string): 'turn' | 'initiative_trigger' | 'none' {
  if (path.startsWith('initiative.trigger.')) return 'initiative_trigger';
  if (/^(turn|vap|gaze|completion|similarity|constants|interpretation)\./.test(path)) return 'turn';
  return 'none';
}

/** スライダーの範囲。スキーマに上限がなければ今の値から決める。 */
export function sliderRange(leaf: TunePolicyLeaf, current: number | null, base: number | null): { min: number; max: number; step: number } {
  const min = leaf.minimum ?? 0;
  if (leaf.maximum !== null) {
    const span = leaf.maximum - min;
    return { min, max: leaf.maximum, step: leaf.kind === 'integer' ? 1 : span <= 1 ? 0.01 : span / 200 };
  }
  const ref = Math.max(Math.abs(current ?? 0), Math.abs(base ?? 0));
  const isMs = /_ms$|_MS$|MS_/.test(leaf.path) || leaf.path.includes('TIMEOUTS_MS');
  const max = isMs ? Math.max(2000, Math.ceil((ref * 3) / 100) * 100) : Math.max(10, Math.ceil(ref * 3));
  return { min, max, step: leaf.kind === 'integer' ? 1 : isMs ? 10 : max / 200 };
}

// ---- 閾値の線 ----------------------------------------------------------------

export interface ThresholdLine {
  path: string;
  label: string;
  value: number;
  /** 線の意味（色分け）: yield は譲渡、interrupt は割り込み、guard は開始の慎重化、gaze は視線、other は名前の規則で拾ったもの。 */
  role: 'yield' | 'interrupt' | 'guard' | 'gaze' | 'speaking' | 'other';
}

export interface ThresholdLines {
  p_now: ThresholdLine[];
  p_future: ThresholdLine[];
  vad: ThresholdLine[];
}

const KNOWN: { suffix: string; lane: keyof ThresholdLines; label: string; role: ThresholdLine['role'] }[] = [
  { suffix: 'constants.VAP_PNOW_YIELD', lane: 'p_now', label: '譲渡（L64、超えると）', role: 'yield' },
  { suffix: 'constants.VAP_PNOW_INTERRUPT', lane: 'p_now', label: '割り込み（L59、下回ると）', role: 'interrupt' },
  { suffix: 'constants.VAP_PFUT_YIELD', lane: 'p_future', label: '譲渡（L64、超えると）', role: 'yield' },
  { suffix: 'constants.VAP_PFUT_INTERRUPT', lane: 'p_future', label: '割り込み（L59、下回ると）', role: 'interrupt' },
  { suffix: 'vap.speaking_threshold', lane: 'vad', label: '利用者の発話中（以上）', role: 'speaking' },
  { suffix: 'turn.start_guard.completion_timeout_min_p_ai', lane: 'p_now', label: 'L74 を長く待つ下限（start_guard）', role: 'guard' },
];

function numericLeaves(value: unknown, prefix = ''): { path: string; value: number }[] {
  if (typeof value === 'number') return [{ path: prefix, value }];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => numericLeaves(v, prefix === '' ? k : `${prefix}.${k}`));
}

/** 方策から図に重ねる線を取り出す。既知の路と、名前の規則（p_now／PNOW／p_ai、p_fut／PFUT、vad）で拾った 0〜1 の値。 */
export function thresholdLines(policy: unknown): ThresholdLines {
  const out: ThresholdLines = { p_now: [], p_future: [], vad: [] };
  const seen = new Set<string>();
  for (const leaf of numericLeaves(policy)) {
    const known = KNOWN.find((k) => leaf.path === k.suffix || leaf.path.endsWith(`.${k.suffix}`) || leaf.path === k.suffix.replace(/^turn\./, ''));
    if (known) {
      out[known.lane].push({ path: leaf.path, label: known.label, value: leaf.value, role: known.role });
      seen.add(leaf.path);
    }
  }
  const gazeSignal = getAt(policy, 'gaze.signal');
  const gazeP = getAt(policy, 'gaze.p_threshold');
  if ((gazeSignal === 'p_now' || gazeSignal === 'p_future') && typeof gazeP === 'number') {
    out[gazeSignal].push({ path: 'gaze.p_threshold', label: '視線を逸らす（ポーズ中、下回ると）', value: gazeP, role: 'gaze' });
    seen.add('gaze.p_threshold');
  }
  for (const leaf of numericLeaves(policy)) {
    if (seen.has(leaf.path) || leaf.value < 0 || leaf.value > 1) continue;
    // vocal_cue は既定で動かない別モードなので、調整の図には重ねない。
    if (/similarity|completion\.thresholds|stability|TURNGPT|index|vocal_cue/i.test(leaf.path)) continue;
    const name = leaf.path.split('.').at(-1) ?? '';
    const lane: keyof ThresholdLines | null = /p_fut|PFUT/i.test(name)
      ? 'p_future'
      : /p_now|PNOW|p_ai|vap_min|min_p/i.test(name)
        ? 'p_now'
        : /vad/i.test(name)
          ? 'vad'
          : null;
    if (lane !== null) out[lane].push({ path: leaf.path, label: leaf.path, value: leaf.value, role: 'other' });
  }
  return out;
}
