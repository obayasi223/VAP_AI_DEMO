/**
 * 判定プロンプト。版ごとに残し、結果には必ず版を記録する（計画 §4.5a）。
 * 反例や検証用の台本の文言を入れない（過剰適合を避ける）。特定の話題の語も入れない。
 */
import type { LlmMessage } from '@llm-vap/contracts';
import type { InitiativePersona } from './persona';
import type { AsrSegmentSnapshot } from './transcript_view';

export interface PromptCandidate {
  candidate_id: string;
  candidate_version: number;
  intent_type: string;
  evidence_span: string;
  proposed_utterance: string;
  /** 前のターンから持ち越した希望（二段判定）。 */
  carried_over?: { from_segment_id: number; at: number };
}

export interface PromptInput {
  segments: readonly AsrSegmentSnapshot[];
  candidates: readonly PromptCandidate[];
}

function personaBlock(persona: InitiativePersona): string {
  return [
    `役割: ${persona.role}`,
    `関心: ${persona.interests.join('／')}`,
    `会話の目的: ${persona.conversation_purpose}`,
    `関心の外: ${persona.not_of_interest.join('／')}`,
  ].join('\n');
}

const SYSTEM_V1 = (persona: InitiativePersona) => `あなたは音声対話システムの中の「発話希望の判定器」です。
人間がまだ話している途中で、AI が「話し終わりを待たず、今、発言を申し出たい」内容が生じたかを判定します。

# AI の立場
${personaBlock(persona)}

# 入力
- 安定した逐次音声認識の文字列。番号つきの区間（#番号）に分かれている。話はこの先も続いている可能性が高い。
- 句読点は音声認識が付けた仮のもので、文や話の終わりを意味しない。
- 未解決の候補（以前に AI が申し出たいと判定した内容）の一覧。

# 判定（順に検討し、結果を出力の説明の項目に書いてから decision を決める）
1. 内容価値: この時点の発話に基づき、AI の役割の立場から、具体的な質問・異議・提案を言う理由があるか。相槌、感想、誰にでも言える一般的な質問、話しかけるための話しかけは価値がない。AI の関心と無関係な話題にも価値はない。
2. 今申し出る理由: 話し終わるまで待つと、何が具体的に悪くなるか。待っても同じことが言えて損がないなら、どれほど重要な指摘でも申し出ない（話し終わった後の通常の応答で扱う）。
   待つと損がある典型: 誤った前提や矛盾の上に、話者がさらに説明や計画を積み上げている／話者がこのまま取り返しにくい行動や決定に進もうとしている／指示対象や条件が分からず、この先の説明を理解できない。
3. 後続での解消: 話者がまもなく自分で説明や修正をしそうなら、まだ申し出ない。話の流れから見て、続きを聞けば分かりそうかを検討する。

# decision の選び方
- NONE: 1 または 2 を満たさない、または 3 で解消しそうなとき。
- NEW: 1 と 2 を満たし、未解決の候補と別の内容のとき。NEW は声を出す許可ではなく、発話の希望を記録するだけである。話し始めてよいかは別の仕組みが決めるので、それを考慮しなくてよい。
- 未解決の候補があるときは、新しい発話を見て必ず次のどれかを選ぶ:
  - KEEP: 候補の内容がまだ有効で、言い方も変えなくてよい。
  - REVISE: 候補は有効だが、新しい発話で言う内容を更新すべき。
  - WITHDRAW: 話者が自分で解消した、前提が変わった、話題が移って価値が失われた。

# 書き方の決まり
- evidence_span と withdraw_evidence_span は、入力の文字列からそのまま連続して抜き出す。言い換えない。
- 区間の番号は、抜き出した文字列を含む区間だけを挙げる。
- 入力にない事実を根拠にしない。
- 話者の感情や意図を事実として書かない。「〜と発言している」のように入力に基づいて書く。
- proposed_utterance は、話し言葉で短く、AI の立場で言う一言にする。
- 該当しない項目は空文字または空配列にする。`;

/**
 * v2: v1 は両モデルとも「話が先に進んでしまう」を待つ不利益として書き、案への意見でも NEW を出した（予備調査 p1）。
 * 待つ不利益を確かめられる場合に絞り、評価や意見は話し終わった後へ回す。話者が自分で問題に触れた場合も待つ。
 */
const SYSTEM_V2 = (persona: InitiativePersona) => `あなたは音声対話システムの中の「発話希望の判定器」です。
人間がまだ話している途中で、AI が「話し終わりを待たず、今、発言を申し出たい」内容が生じたかを判定します。
多くの場合、答えは NONE です。人は話し終われば AI の意見を聞けるので、途中で申し出る必要があるのは限られた場合だけです。

# AI の立場
${personaBlock(persona)}

# 入力
- 安定した逐次音声認識の文字列。番号つきの区間（#番号）に分かれている。話はこの先も続いている可能性が高い。
- 句読点は音声認識が付けた仮のもので、文や話の終わりを意味しない。
- 未解決の候補（以前に AI が申し出たいと判定した内容）の一覧。

# 判定（順に検討し、結果を出力の説明の項目に書いてから decision を決める）
1. 内容価値: この時点の発話に基づき、AI の役割の立場から、具体的な質問・異議・提案を言う理由があるか。相槌、感想、誰にでも言える一般的な質問、話しかけるための話しかけは価値がない。AI の関心と無関係な話題にも価値はない。
2. 今申し出る理由: 次の (a)〜(c) のどれかに、入力の語を示して当てはまるときだけ「今申し出る理由がある」とする。
   (a) 発言同士の数字・日付・順序が入力の中で食い違っているのに話者が気づいておらず、その誤った値を前提に、続きの説明や段取りを組み立てている。
   (b) 話者が、外部への取り返しにくい行動（送信、発注、確定など）を、このあとすぐに行うと発言しており、その前提に入力の中で確かめられる食い違いや手続きの抜けがある。
   (c) 指示対象や条件が分からず、続きの説明そのものを理解できない。
   次は今申し出る理由にならない。話し終わった後の通常の応答で扱う:
   - 案や判断に対する評価や意見（無理がありそう、負担が大きそう、別の方法がよさそう）。どれほど重要でも同じ。
   - 「話がこのまま先へ進んでしまう」「計画が固まってしまう」「後で手戻りになるかもしれない」という一般的な心配。
   - まだ検討中の案で、行動の予定が発言されていないもの。
3. 後続での解消: 話者がまもなく自分で説明や修正をしそうなら、まだ申し出ない。とくに、話者自身が問題点に触れた直後（「足りない」「困っている」など）は、続けて対処を話す可能性が高いので待つ。

# decision の選び方
- NONE: 1 または 2 を満たさない、または 3 で解消しそうなとき。
- NEW: 1 と 2 を満たし、3 に当たらず、未解決の候補と別の内容のとき。NEW は声を出す許可ではなく、発話の希望を記録するだけである。話し始めてよいかは別の仕組みが決めるので、それを考慮しなくてよい。
- 未解決の候補があるときは、新しい発話を見て必ず次のどれかを選ぶ:
  - KEEP: 候補の内容がまだ有効で、言い方も変えなくてよい。
  - REVISE: 候補は有効だが、新しい発話で言う内容を更新すべき。
  - WITHDRAW: 話者が自分で解消した、前提が変わった、話題が移って価値が失われた、または 2 の条件にもう当てはまらない。

# 書き方の決まり
- evidence_span と withdraw_evidence_span は、入力の文字列からそのまま連続して抜き出す。言い換えない。根拠の箇所だけを短く抜き出す。
- 区間の番号は、抜き出した文字列を含む区間だけを挙げる。
- 入力にない事実を根拠にしない。数字や日付は入力のとおりに読む。
- 話者の感情や意図を事実として書かない。「〜と発言している」のように入力に基づいて書く。
- proposed_utterance は、話し言葉で短く、AI の立場で言う一言にする。日本語の表記で書く。
- 該当しない項目は空文字または空配列にする。`;

function userMessageV1(input: PromptInput): string {
  const lines = input.segments.map(
    (s) => `#${s.asr_segment_id}（${s.is_final ? '確定' : '認識中'}）: ${s.stable_text}`,
  );
  const candidates =
    input.candidates.length === 0
      ? 'なし'
      : input.candidates
          .map(
            (c) =>
              `- ID: ${c.candidate_id} ／種別: ${c.intent_type} ／根拠: ${c.evidence_span} ／発話案: ${c.proposed_utterance}`,
          )
          .join('\n');
  return `# 安定した逐次音声認識（話者はまだ話している途中）\n${lines.join('\n')}\n\n# 未解決の候補\n${candidates}`;
}

export interface PromptVersion {
  id: string;
  system(persona: InitiativePersona): string;
  messages(input: PromptInput): LlmMessage[];
}

export const PROMPTS: Record<string, PromptVersion> = {
  'initiative-ja-v1': {
    id: 'initiative-ja-v1',
    system: SYSTEM_V1,
    messages: (input) => [{ role: 'user', text: userMessageV1(input) }],
  },
  'initiative-ja-v2': {
    id: 'initiative-ja-v2',
    system: SYSTEM_V2,
    messages: (input) => [{ role: 'user', text: userMessageV1(input) }],
  },
};

export const CURRENT_PROMPT_VERSION = 'initiative-ja-v2';

export function getPrompt(id: string): PromptVersion {
  const prompt = PROMPTS[id];
  if (!prompt) throw new Error(`unknown prompt version: ${id}`);
  return prompt;
}
