/**
 * probe の合成の材料（02 §5 の手動の確認）。架空の人物「タナカさん」（転職するか今の会社に残るか）。
 * sessions/ の実会話は使っていない。助言者や家族の評価は含めない（00 の安全の範囲）。
 */
import type { Utterance } from '../../../apps/orchestrator/src/cognition/discussion/ledger';

export const PROFILE = { aspect: 'どの道を選ぶか', user_name: 'タナカ', user_name_reading: 'たなか' } as const;

export const UTTERANCES: Utterance[] = [
  { segment_id: 1, text: '今の会社に残るか、転職するかで迷っています。' },
  { segment_id: 2, text: '仕事の内容は好きなんですけど、もっと新しいことに挑戦したい気持ちもあって。' },
  { segment_id: 3, text: '独立も少し考えたんですが、準備が足りないのでやめました。' },
  { segment_id: 4, text: '面接は来月の10日で、今の契約の更新は3月です。' },
  { segment_id: 5, text: 'いちばん気になっているのは、決めたあとで戻れなくなることです。' },
  { segment_id: 6, text: '引っ越しが要るかどうかも、まだ分かっていません。' },
];

export const LEDGER_OUTPUT = {
  core: { id: 'core_1', text: '決めたあとで戻れなくなること', evidence: [{ span: '決めたあとで戻れなくなること', segment_ids: [5] }] },
  options: [
    { id: 'opt_1', text: '今の会社に残る', evidence: [{ span: '今の会社に残る', segment_ids: [1] }] },
    { id: 'opt_2', text: '転職する', evidence: [{ span: '転職する', segment_ids: [1] }] },
  ],
  dropped_options: [
    { id: 'drop_1', text: '独立', reason: '準備が足りない', evidence: [{ span: '独立も少し考えたんですが、準備が足りないのでやめました', segment_ids: [3] }] },
  ],
  facts: [
    { id: 'fact_1', text: '面接は来月の10日', kind: 'date', slip_eligible: true, evidence: [{ span: '面接は来月の10日', segment_ids: [4] }] },
    { id: 'fact_2', text: '今の契約の更新は3月', kind: 'date', slip_eligible: true, evidence: [{ span: '今の契約の更新は3月', segment_ids: [4] }] },
  ],
  values: [
    { id: 'val_1', text: '仕事の内容は好き', evidence: [{ span: '仕事の内容は好き', segment_ids: [2] }] },
    { id: 'val_2', text: '新しいことに挑戦したい', evidence: [{ span: '新しいことに挑戦したい', segment_ids: [2] }] },
  ],
  sensitive: [],
};

/** 計画が取り違えを作れなかったときに (e) で使う中立の取り違え。 */
export const DEFAULT_SLIP = { slip_statement: '面接は来月の20日', correct_statement: '面接は来月の10日', slip_value: '20日', correct_value: '10日' } as const;

export interface CorrectionCase {
  utterance: string;
  /** 正解（取り違えを正しているか）。 */
  corrects: boolean;
}

/**
 * 架空の訂正の発話（訂正と反論を半々）。correct_value／slip_value を差し込んで n 件作る（決定的）。
 */
export function correctionCases(slip: { slip_value: string; correct_value: string }, n = 30): CorrectionCase[] {
  const c = slip.correct_value;
  const s = slip.slip_value;
  const corrections = [
    `いや、${c}です。`,
    `${s}じゃなくて${c}ですね。`,
    `あ、${c}だったと思います。`,
    `ちょっと違って、${c}です。`,
    `${c}のはずです。`,
    `えっと、${s}ではなく${c}です。`,
    `それ、${c}ですよ。`,
    `日にちは${c}ですね。`,
  ];
  const rebuttals = [
    'いや、残る方が安全とは限らないと思います。',
    'そこはそんなに気にしていないです。',
    'うーん、挑戦したいのはお金のためではないです。',
    'いや、戻れないとまでは思っていないです。',
    'それより仕事の中身の方が大事です。',
    'ちょっと違って、迷っているのは時期のほうです。',
    '引っ越しは問題ないと思います。',
    'いや、独立はもう考えていないです。',
  ];
  const out: CorrectionCase[] = [];
  for (let i = 0; i < n; i++) {
    const list = i % 2 === 0 ? corrections : rebuttals;
    out.push({ utterance: list[Math.floor(i / 2) % list.length]!, corrects: i % 2 === 0 });
  }
  return out;
}
