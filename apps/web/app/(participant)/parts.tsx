'use client';

/** 参加者画面の部品（選択肢、お知らせ、マイクの設定）。 */
import type { ReactNode } from 'react';
import styles from './participant.module.css';

export interface ChoicePicker {
  /** radio の name。URL の ?name= と同じ名前にする（E2E は input[name="..."]:checked を読む）。 */
  name: string;
  legend: string;
  testId: string;
  value: string | null;
  options: readonly { value: string; label: string }[];
  onChange: (value: string | null) => void;
}

/** 選択肢の型を保ったまま、1 行の定義にする。増やすときは page.tsx の pickers に足す。 */
export function picker<T extends string>(input: {
  name: string;
  legend: string;
  testId: string;
  value: T | null;
  values: readonly T[];
  label: (value: T) => string;
  onChange: (value: T | null) => void;
}): ChoicePicker {
  return {
    name: input.name,
    legend: input.legend,
    testId: input.testId,
    value: input.value,
    options: input.values.map((value) => ({ value, label: input.label(value) })),
    onChange: (value) => input.onChange(value as T | null),
  };
}

/** 「指定しない」（value=""、未選択は orchestrator の既定に任せる）を先頭に足した radio の並び。 */
export function ChoiceGroup({ choice }: { choice: ChoicePicker }) {
  const options = [{ value: '', label: '指定しない' }, ...choice.options];
  return (
    <fieldset className={styles.choices} data-testid={choice.testId}>
      <legend>{choice.legend}</legend>
      <div className={styles.choiceRow}>
        {options.map((option) => (
          <label key={option.value} className={styles.choice}>
            <input
              type="radio"
              name={choice.name}
              value={option.value}
              checked={(choice.value ?? '') === option.value}
              onChange={() => choice.onChange(option.value === '' ? null : option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function NoticeList({ error, isFake, messages }: { error: string | null; isFake: boolean; messages: string[] }) {
  if (error === null && !isFake && messages.length === 0) return null;
  return (
    <div className={styles.notices}>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {isFake && (
        <p className={styles.warn} data-testid="fake">
          試験用の設定で動いています（本物の音声認識や AI を使っていません）。本番の記録には数えません。
        </p>
      )}
      {messages.map((message) => (
        <p key={message} className={styles.warn}>
          {message}
        </p>
      ))}
    </div>
  );
}

export function MicDetails({ children }: { children: ReactNode }) {
  return (
    <details className={styles.mic}>
      <summary className={styles.foldSummary}>マイクの設定</summary>
      <div className={styles.micBody}>{children}</div>
    </details>
  );
}
