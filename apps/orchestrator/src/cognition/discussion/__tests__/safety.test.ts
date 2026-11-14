import { describe, expect, it } from 'vitest';
import { loadDiscussionAssets } from '../assets';
import { emptyLedger, mergeLedgerOutput } from '../ledger';
import { checkText, cleanSymbols, NO_CONTEXT, safeLedger } from '../safety';
import { FICTIONAL, REPO_ROOT, testConfig } from './helpers';

const lists = loadDiscussionAssets(REPO_ROOT, testConfig()).safety;

describe('safety（02 §2.7）', () => {
  it('禁止の語に当たる', () => {
    expect(checkText('それは性格の問題かもしれません。', lists, NO_CONTEXT).rule).toBe('banned_term');
    expect(checkText('体調のことも気になりますね。', lists, NO_CONTEXT).rule).toBe('banned_term');
  });

  it('人物の語だけなら通し、評価・推測の語と同じ文なら止める（伝え方は話題にしてよい）', () => {
    expect(checkText('指導教員にいつ切り出すかを決めておくとよさそうです。', lists, NO_CONTEXT).ok).toBe(true);
    expect(checkText('指導教員は厳しいので、反対しそうですね。', lists, NO_CONTEXT).rule).toBe('person_evaluation');
    // 別の文なら当たらない
    expect(checkText('先生に話す日を決めます。厳しい日程ですね。', lists, NO_CONTEXT).ok).toBe(true);
  });

  it('二人称に当たる', () => {
    expect(checkText('あなたはどう思いますか。', lists, NO_CONTEXT).rule).toBe('second_person');
  });

  it('記号、絵文字、名札は取り除いて使う', () => {
    expect(cleanSymbols('アオイ：**なるほど**😀、そうですね。', ['アオイ'])).toBe('なるほど、そうですね。');
    expect(cleanSymbols('A: 順番に考えます。')).toBe('順番に考えます。');
  });

  it('C の語と取り違えた値（c_ban が false なら C の語は照らさない）', () => {
    const ctx = { c_terms: ['期待との距離'], c_ban: true, slip_terms: ['12月末'] };
    expect(checkText('期待との距離が大事です。', lists, ctx).rule).toBe('c_term');
    expect(checkText('期待との距離が大事です。', lists, { ...ctx, c_ban: false }).ok).toBe(true);
    expect(checkText('締切は12月末でした。', lists, { ...ctx, c_ban: false }).rule).toBe('slip_value');
  });

  it('sensitive の根拠と重なる項目は、計画の材料から外す', () => {
    const utterances = [...FICTIONAL.utterances, { segment_id: 7, text: '最近は体調がよくなくて、親とも喧嘩していて。' }];
    const output = {
      ...FICTIONAL.ledger_output,
      values: [{ id: 'val_x', text: '親とうまくやりたい', evidence: [{ span: '親とも喧嘩していて', segment_ids: [7] }] }],
      sensitive: [{ kind: 'family_conflict', span: '親とも喧嘩していて', segment_ids: [7] }],
    };
    const merged = mergeLedgerOutput(emptyLedger({ aspect: 'x', user_name: 'サトウ', user_name_reading: 'サトウ' }), output, utterances)!;
    const { ledger, excluded } = safeLedger(merged.ledger, lists);
    expect(excluded).toContain('val_x');
    expect(ledger.values.map((v) => v.id)).not.toContain('val_x');
    expect(ledger.options.length).toBe(2);
  });
});
