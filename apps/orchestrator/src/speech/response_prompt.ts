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

export function createResponsePromptBuilder(options: {
  history: ConversationHistoryReader;
  system?: string;
  max_entries?: number;
}): ResponsePromptBuilder {
  const system = options.system ?? DEFAULT_RESPONSE_SYSTEM;
  const maxEntries = options.max_entries ?? 20;
  return (request) => {
    const earlier = options.history
      .snapshot()
      .filter((entry) => !(entry.role === 'user' && entry.segment_id === request.segment_id))
      .slice(-maxEntries);
    return {
      system,
      messages: [
        ...earlier.map((entry): LlmMessage => ({ role: entry.role, text: entry.text })),
        { role: 'user', text: request.text },
      ],
    };
  };
}
