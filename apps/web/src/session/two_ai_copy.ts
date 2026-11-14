/**
 * 2 体のモードの参加者向けの文（docs/design/two_ai/03 §3.4、初案）。
 * 案内は Node の two_ai.phase の instruction_key で引く。鍵にも文にも条件名を含めない（試験で確かめる）。
 * 鍵の正本は設定（config/two_ai/session.ja.json の display.instruction_keys）。discussion の 2 つの鍵だけが
 * 条件で違い、他の段の文は同じ。文言は未確定（研究者が口頭でも同じ内容を伝える前提）。
 */

/** 案内の文（instruction_key → 文）。 */
export const INSTRUCTION_COPY: Readonly<Record<string, string>> = {
  intake: 'いま迷っていることを、思いつくままに話してください。AI が聞き手になります。',
  discussion_a:
    'これから 2 人の AI が、あなたの話について話し合います。話し合いの途中でも、いつでも話しかけてかまいません。話しかけても、話しかけなくてもかまいません。',
  discussion_b:
    'これから 2 人の AI が、あなたの話について話し合います。この時間は聞く時間です。話し合いの後に、必ずあなたが話す時間があります。',
  response: '話し合いを聞いて思ったことを、自由に話してください。',
  next_step: '最後に、板の中から次の一歩を 1 枚選びましょう。',
  end: 'おつかれさまでした。研究者の案内をお待ちください。',
};

/** 03 の初案の別名（設定の鍵が変わっても文が出るように）。 */
const INSTRUCTION_ALIASES: Readonly<Record<string, string>> = {
  discussion_speak_anytime: 'discussion_a',
  discussion_listen_first: 'discussion_b',
};

/** 案内の文。知らない鍵と null は null（画面に案内を出さない。研究画面の記録で分かる）。 */
export function instructionText(key: string | null): string | null {
  if (key === null) return null;
  const resolved = INSTRUCTION_ALIASES[key] ?? key;
  return Object.prototype.hasOwnProperty.call(INSTRUCTION_COPY, resolved) ? (INSTRUCTION_COPY[resolved] as string) : null;
}

/** 画面の固定の文（両条件で同じ）。 */
export const UI_COPY = {
  /** 印のボタンの文字。 */
  marker_button: '言いたい',
  next_step_pick: 'この中から、次の一歩を 1 枚選んでください。',
  board_title: '次の一歩の候補',
  board_empty: 'まだ候補はありません。',
  picked: '選びました',
  start_title: '2 人の AI と話します',
  start_label: 'はじめる',
  stop_label: '終了する',
  stopped_title: '終わりました',
  failed_title: 'はじめられませんでした',
  preparing: '準備中…',
  avatar_failed: 'この AI の姿を表示できません。会話は続きます。',
  speaking_badge: '話しています',
  not_ready: '2 体のモードの準備ができていません。研究者に知らせてください。',
  wrong_mode: '1 対 1 の Node につながっています。2 体のモードでははじめられません。研究者に知らせてください。',
} as const;

/** 名札の既定（Node から labels が届くまで）。 */
export const DEFAULT_LABELS = { A: 'A さん', B: 'B さん' } as const;

/** 文と鍵の全部（試験で条件名が出ないことを確かめる）。 */
export function allCopyStrings(): string[] {
  return [
    ...Object.keys(INSTRUCTION_COPY),
    ...Object.values(INSTRUCTION_COPY),
    ...Object.keys(INSTRUCTION_ALIASES),
    ...Object.keys(UI_COPY),
    ...Object.values(UI_COPY),
    ...Object.values(DEFAULT_LABELS),
  ];
}
