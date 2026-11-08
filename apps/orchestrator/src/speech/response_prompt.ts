/**
 * 通常応答の LLM 入力の組み立て。応答文の質はここでは評価しない。
 * 履歴には進行中の発話の interim が入っていることがあるので、同じ segment の分を除いてから入力文を足す。
 */
import type {
  ConversationHistoryReader,
  LlmMessage,
  PrepareRequest,
} from '@llm-vap/contracts';

export const RESPONSE_PROMPT_VERSION = 'response_prompt_v1';

export const DEFAULT_RESPONSE_SYSTEM = [
  'あなたは人と声で会話している日本語の話し相手です。',
  '返答はそのまま音声で読み上げられます。1〜2文の話し言葉で簡潔に答え、',
  '記号、箇条書き、絵文字は使いません。',
].join('');

export interface ResponsePrompt {
  system: string;
  messages: LlmMessage[];
}

export type ResponsePromptBuilder = (request: PrepareRequest) => ResponsePrompt;

/** 保留中の発話希望を通常応答の材料として渡すプロンプトの版（negotiation_wiring が initiative.response_material に残す）。 */
export const PENDING_MATERIAL_PROMPT_VERSION = 'pending_material_v1';

/** 通常応答の材料（保留中の発話希望の内容）。準備の時点で手元にあるものだけ。応答を待たせない。 */
export interface PendingResponseMaterial {
  intent_type: string;
  proposed_utterance: string;
}

function pendingMaterialInstruction(material: PendingResponseMaterial): string {
  return [
    '次は、あなたが相手の話を聞いている間に言いたいと思って保留していた内容です。',
    '今の返答に自然に活かせるときだけ使ってください。合わなければ、使わずに無視してください（必ず言う必要はありません）。',
    `言いたかった内容（種別 ${material.intent_type}）: ${material.proposed_utterance}`,
  ].join('');
}

export function createResponsePromptBuilder(options: {
  history: ConversationHistoryReader;
  system?: string;
  max_entries?: number;
  /** 通常応答の材料。null は渡すものがない。 */
  pending_material?: (request: PrepareRequest) => PendingResponseMaterial | null;
}): ResponsePromptBuilder {
  const system = options.system ?? DEFAULT_RESPONSE_SYSTEM;
  const maxEntries = options.max_entries ?? 20;
  return (request) => {
    const earlier = options.history
      .snapshot()
      .filter((entry) => !(entry.role === 'user' && entry.segment_id === request.segment_id))
      .slice(-maxEntries);
    const material = options.pending_material?.(request) ?? null;
    return {
      system: material ? `${system}\n\n${pendingMaterialInstruction(material)}` : system,
      messages: [
        ...earlier.map((entry): LlmMessage => ({ role: entry.role, text: entry.text })),
        { role: 'user', text: request.text },
      ],
    };
  };
}
