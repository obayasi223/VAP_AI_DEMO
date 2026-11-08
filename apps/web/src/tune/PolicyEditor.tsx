'use client';

/**
 * 方策の編集。項目は契約のスキーマ（dev サーバの /dev/policy の leaves）から作るので、方策に項目が増えれば自動で並ぶ。
 * 数値はスライダーと数値の欄、真偽はチェック、列挙は選択、null を許す葉は「null」のチェック、省略できる節は「節を使う」のチェック。
 * 元の値と違う葉は色を付け、再生に効くかどうかの札を付ける。
 */
import { useMemo, useState } from 'react';
import type { TunePolicyLeaf } from '@llm-vap/contracts';
import { changedPaths, deleteAt, getAt, groupLeaves, replayEffect, sameJson, setAt, sliderRange } from './policy_edit';
import styles from './tune.module.css';

const EFFECT_TAG: Record<ReturnType<typeof replayEffect>, string> = {
  turn: '再生に効く',
  initiative_trigger: '起動の回数だけ数え直す',
  none: '再生では効かない',
};

function NumberLeaf({ leaf, value, base, onChange }: { leaf: TunePolicyLeaf; value: number; base: number | null; onChange: (v: number) => void }) {
  const range = sliderRange(leaf, value, base);
  return (
    <div className={styles.leafInput}>
      <input
        type="range"
        min={range.min}
        max={Math.max(range.max, value)}
        step={range.step}
        value={value}
        aria-label={leaf.path}
        onChange={(e) => onChange(leaf.kind === 'integer' ? Math.round(Number(e.target.value)) : Number(e.target.value))}
      />
      <input
        type="number"
        value={value}
        step={leaf.kind === 'integer' ? 1 : 'any'}
        min={leaf.minimum ?? undefined}
        max={leaf.maximum ?? undefined}
        aria-label={`${leaf.path} の値`}
        onChange={(e) => {
          if (e.target.value === '') return;
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(leaf.kind === 'integer' ? Math.round(n) : n);
        }}
      />
    </div>
  );
}

function LeafEditor({
  leaf,
  edited,
  base,
  onChange,
}: {
  leaf: TunePolicyLeaf;
  edited: unknown;
  base: unknown;
  onChange: (next: unknown) => void;
}) {
  const value = getAt(edited, leaf.path);
  const baseValue = getAt(base, leaf.path);
  const changed = !sameJson(value, baseValue);
  const set = (v: unknown) => onChange(setAt(edited, leaf.path, v));
  let input: React.ReactNode;
  if (value === undefined) input = <span className={styles.muted}>（節が省かれている）</span>;
  else if (value === null && leaf.nullable)
    input = (
      <span className={styles.muted}>
        null
      </span>
    );
  else if (leaf.kind === 'number' || leaf.kind === 'integer')
    input = <NumberLeaf leaf={leaf} value={typeof value === 'number' ? value : 0} base={typeof baseValue === 'number' ? baseValue : null} onChange={set} />;
  else if (leaf.kind === 'boolean') input = <input type="checkbox" checked={value === true} aria-label={leaf.path} onChange={(e) => set(e.target.checked)} />;
  else if (leaf.kind === 'enum')
    input = (
      <select value={String(value)} aria-label={leaf.path} onChange={(e) => set(e.target.value)}>
        {(leaf.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  else if (leaf.kind === 'string_array')
    input = (
      <input
        className={styles.input}
        value={Array.isArray(value) ? value.join('、') : ''}
        aria-label={leaf.path}
        onChange={(e) =>
          set(
            e.target.value
              .split(/[、,]/)
              .map((s) => s.trim())
              .filter((s) => s !== ''),
          )
        }
      />
    );
  else input = <input className={styles.input} value={String(value)} aria-label={leaf.path} onChange={(e) => set(e.target.value)} />;

  return (
    <div className={changed ? styles.leafChanged : styles.leaf} data-path={leaf.path}>
      <div className={styles.leafHead}>
        <span className={styles.path}>{leaf.path.split('.').slice(1).join('.') || leaf.path}</span>
        <span className={styles.tag}>{EFFECT_TAG[replayEffect(leaf.path)]}</span>
        {changed ? <span className={styles.tag}>元: {JSON.stringify(baseValue) ?? '（なし）'}</span> : null}
        {leaf.nullable && value !== undefined ? (
          <label className={styles.muted}>
            <input
              type="checkbox"
              checked={value === null}
              onChange={(e) => {
                if (e.target.checked) set(null);
                else set(baseValue !== null && baseValue !== undefined ? baseValue : (leaf.minimum ?? 0));
              }}
            />
            null
          </label>
        ) : null}
      </div>
      {input}
      {leaf.description ? <div className={styles.muted}>{leaf.description}</div> : null}
    </div>
  );
}

export function PolicyEditor({
  leaves,
  edited,
  base,
  fallback,
  onChange,
}: {
  leaves: TunePolicyLeaf[];
  edited: unknown;
  /** 比べる元（記録の方策など）。 */
  base: unknown;
  /** 省いた節を戻すときの値（今の方策）。 */
  fallback: unknown;
  onChange: (next: unknown) => void;
}) {
  const [filter, setFilter] = useState('');
  const changed = useMemo(() => changedPaths(leaves, base, edited), [leaves, base, edited]);
  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const shown = f === '' ? leaves : leaves.filter((l) => l.path.toLowerCase().includes(f) || (l.description ?? '').toLowerCase().includes(f));
    return groupLeaves(shown);
  }, [leaves, filter]);

  return (
    <div data-testid="policy-editor">
      <div className={styles.row}>
        <input className={styles.input} style={{ minWidth: 0, flex: 1 }} placeholder="項目を絞る（例 start_guard、VAP_PNOW）" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <p className={styles.muted}>
        変えた項目: {changed.length === 0 ? 'なし' : changed.join('、')}
      </p>
      {groups.map(({ section, leaves: items }) => {
        let lastParent: string | null = null;
        return (
          <div key={section}>
            <div className={styles.section}>{section}</div>
            {items.map((leaf) => {
              const parent = leaf.optional_parent;
              const head =
                parent !== null && parent !== lastParent ? (
                  <label key={`opt:${parent}`} className={styles.muted} style={{ display: 'block' }}>
                    <input
                      type="checkbox"
                      checked={getAt(edited, parent) !== undefined}
                      onChange={(e) => {
                        if (e.target.checked) {
                          const restore = getAt(base, parent) ?? getAt(fallback, parent);
                          if (restore !== undefined) onChange(setAt(edited, parent, restore));
                        } else onChange(deleteAt(edited, parent));
                      }}
                    />
                    節 <span className={styles.path}>{parent}</span> を使う（省くと既定の動き）
                  </label>
                ) : null;
              lastParent = parent;
              return (
                <div key={leaf.path}>
                  {head}
                  <LeafEditor leaf={leaf} edited={edited} base={base} onChange={onChange} />
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
