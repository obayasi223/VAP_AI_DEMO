import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PolicyJa } from '@llm-vap/contracts';
import { ScriptedLlmProvider } from '@llm-vap/testkit';
import {
  JA_RULES_ESTIMATOR,
  JaRulesTurnCompletionEstimator,
  LLM_COMPLETION_ESTIMATOR,
  LlmTurnCompletionEstimator,
  NO_ESTIMATOR,
  completionPrepareThreshold,
  createCompletionEstimator,
  scoreJaRules,
} from '../src/cognition/completion';
import { auc, summarize } from '../src/cognition/completion/evaluate';

const rule = (text: string, history: string[] = []) =>
  scoreJaRules(history.map((t) => ({ role: 'assistant' as const, text: t })), text).p;

describe('代替 A（文末形態の規則）', () => {
  it('順序: 接続助詞 < 予告 < 言い切り < 質問', () => {
    const connective = rule('雨が降っていたので');
    const preface = rule('話が三つあります');
    const statement = rule('私は犬が好きです');
    const question = rule('明日の会議は何時からですか');
    expect(connective).toBeLessThan(preface);
    expect(preface).toBeLessThan(statement);
    expect(statement).toBeLessThan(question);
  });

  it('句読点に依存しない（ASR の末尾の句読点は変動する）', () => {
    expect(rule('雨が降っていたので。')).toBe(rule('雨が降っていたので'));
    expect(rule('これいくらですか？')).toBe(rule('これいくらですか'));
  });

  it('名詞の「の」と活用語の「の」、質問でない「か」を分ける', () => {
    expect(rule('駅から歩いて十分くらいの')).toBeLessThan(0.3);
    expect(rule('なんでそう思ったの')).toBeGreaterThan(0.5);
    expect(rule('りんごとか')).toBeLessThan(0.3);
    expect(rule('混んでてさ')).toBeLessThan(0.3);
  });

  it('直前の相手の質問への答えは上がる', () => {
    expect(rule('三時からです', ['会議は何時からですか'])).toBeGreaterThan(rule('三時からです'));
  });

  it('空の入力は null と理由（偽の値を入れない）', async () => {
    const estimate = await new JaRulesTurnCompletionEstimator().estimate([], '  。');
    expect(estimate.p).toEqual({ value: null, null_reason: 'empty_partial' });
  });
});

describe('代替 B（LLM）の IF', () => {
  const estimator = (text: string) =>
    new LlmTurnCompletionEstimator(new ScriptedLlmProvider({ responder: () => text }));

  it('JSON の p を返し、用途は completion', async () => {
    const llm = new ScriptedLlmProvider({ responder: () => '{"p":0.8}' });
    const estimate = await new LlmTurnCompletionEstimator(llm).estimate([], 'どう思いますか', {
      transcript_revision: 7,
    });
    expect(estimate).toEqual({ p: { value: 0.8 }, estimator: LLM_COMPLETION_ESTIMATOR });
    expect(llm.requests[0]?.purpose).toBe('completion');
    expect(llm.requests[0]?.transcript_revision).toBe(7);
  });

  it('文脈は省略でき、signal を要求へ渡す', async () => {
    const llm = new ScriptedLlmProvider({ responder: () => '{"p":0.8}' });
    const controller = new AbortController();
    await new LlmTurnCompletionEstimator(llm).estimate([], 'どう思いますか', { signal: controller.signal });
    expect(llm.requests[0]?.transcript_revision).toBe(0);
    expect(llm.requests[0]?.signal).toBe(controller.signal);
  });

  it('形式の違反と失敗は null と理由', async () => {
    expect((await estimator('not json').estimate([], 'x')).p.value).toBeNull();
    expect((await estimator('{"p":1.5}').estimate([], 'x')).p.value).toBeNull();
    const failing = new LlmTurnCompletionEstimator(
      new ScriptedLlmProvider({
        responder: () => {
          throw new Error('boom');
        },
      }),
    );
    expect((await failing.estimate([], 'x')).p).toEqual({ value: null, null_reason: 'llm_failed: boom' });
  });
});

describe('policy の閾値表と推定器の選択', () => {
  const policy = PolicyJa.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../../../config/policy.ja.json'), 'utf8')),
  );

  it('既定の推定器の閾値を推定器ごとの表から読む', () => {
    expect(policy.completion.estimator).toBe(JA_RULES_ESTIMATOR);
    expect(completionPrepareThreshold(policy.completion)).toBe(
      policy.completion.thresholds[JA_RULES_ESTIMATOR]?.prepare_threshold,
    );
    expect(createCompletionEstimator(policy.completion).name).toBe(JA_RULES_ESTIMATOR);
  });

  it('推定器なしは null と理由、知らない名前は例外', async () => {
    const none = createCompletionEstimator({ estimator: null, thresholds: {} });
    expect(none.name).toBe(NO_ESTIMATOR);
    expect((await none.estimate([], 'x')).p.value).toBeNull();
    expect(completionPrepareThreshold({ estimator: null, thresholds: {} })).toBeNull();
    expect(() => createCompletionEstimator({ estimator: 'turngpt', thresholds: {} })).toThrow(/unknown/);
    expect(() => createCompletionEstimator({ estimator: LLM_COMPLETION_ESTIMATOR, thresholds: {} })).toThrow(
      /LlmProvider/,
    );
  });
});

describe('評価の指標', () => {
  it('auc は同点を 0.5 と数える', () => {
    expect(auc([1], [0])).toBe(1);
    expect(auc([0], [1])).toBe(0);
    expect(auc([0.5], [0.5])).toBe(0.5);
    expect(auc([], [1])).toBeNull();
  });

  it('発火は閾値を超えたものだけ、null は別に数える', () => {
    const summary = summarize(
      [
        { id: 'a', category: 'question_end', p: 0.3 },
        { id: 'b', category: 'question_end', p: 0.31 },
        { id: 'c', category: 'continues', p: null, null_reason: 'x' },
      ],
      0.3,
    );
    expect(summary.categories.question_end?.fire_rate).toBe(0.5);
    expect(summary.null_count).toBe(1);
    expect(summary.categories.continues?.n).toBe(0);
  });
});
