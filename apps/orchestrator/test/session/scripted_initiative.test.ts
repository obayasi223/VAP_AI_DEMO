/**
 * E2E 用の台本の発話希望（SCRIPTED_INITIATIVE=new_on_input、app/scripted.ts）。本物のプロンプト（initiative-ja-v2）の
 * 入力から返答を作り、本物の parseModelOutput に通ることを見る。発話希望の判断の良し悪しは何も試していない。
 */
import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '@llm-vap/contracts';
import { getPrompt } from '../../src/cognition/initiative/prompt';
import { parseModelOutput } from '../../src/cognition/initiative/model_output';
import { SCRIPTED_CANDIDATE_UTTERANCE, scriptedInitiativeReply } from '../../src/app/scripted';

const prompt = getPrompt('initiative-ja-v2');
function request(input: Parameters<typeof prompt.messages>[0]): LlmRequest {
  return { request_id: 'r', purpose: 'initiative', system: '', messages: prompt.messages(input), response_json_schema: null, transcript_revision: 1 };
}
const seg = (id: number, text: string, final = false) =>
  ({ asr_segment_id: id, is_final: final, stable_text: text, unstable_text: '' }) as unknown as Parameters<typeof prompt.messages>[0]['segments'][number];

describe('台本の発話希望の返答', () => {
  it('候補がなければ、最後の区間の先頭 8 文字を根拠にした NEW', () => {
    const out = parseModelOutput(scriptedInitiativeReply(request({ segments: [seg(1, 'こんにちは、今日はちょっと', true), seg(2, '最近、朝起きるのがつらくて')], candidates: [] })));
    expect(out).toMatchObject({ ok: true, output: { decision: 'NEW', evidence_span: '最近、朝起きるの', evidence_segment_ids: [2], proposed_utterance: SCRIPTED_CANDIDATE_UTTERANCE } });
  });
  it('候補が入力にあれば KEEP（その ID）', () => {
    const candidates = [{ candidate_id: 'c_0001', candidate_version: 1, intent_type: 'CLARIFICATION', evidence_span: '最近、朝起きるの', proposed_utterance: SCRIPTED_CANDIDATE_UTTERANCE }];
    const out = parseModelOutput(scriptedInitiativeReply(request({ segments: [seg(2, '最近、朝起きるのがつらくて')], candidates })));
    expect(out).toMatchObject({ ok: true, output: { decision: 'KEEP', target_candidate_id: 'c_0001' } });
  });
  it('区間がないか短ければ NONE', () => {
    expect(parseModelOutput(scriptedInitiativeReply(request({ segments: [], candidates: [] })))).toMatchObject({ ok: true, output: { decision: 'NONE' } });
    expect(parseModelOutput(scriptedInitiativeReply(request({ segments: [seg(1, 'はい')], candidates: [] })))).toMatchObject({ ok: true, output: { decision: 'NONE' } });
  });
});
