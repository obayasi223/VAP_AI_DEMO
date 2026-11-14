// 要約、--recall、--post、--coding のスナップショットと性質（04 T1、AC19〜AC21）。合成のログ（架空）だけを使う。
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSyntheticSession, writeSyntheticSession, type SyntheticOptions } from '../../../fixtures/two_ai/synthetic_session';
import { runReport } from '../cli';
import { blindCode, buildCoding, codingFiles } from '../coding';
import { buildRecallRows } from '../recall';
import { buildSummary, renderSummaryMarkdown } from '../report';
import { buildPostItems, buildRetraction } from '../retraction';
import { sessionFromValues, sha256 } from '../session';

function data(options: SyntheticOptions) {
  const s = buildSyntheticSession(options);
  return sessionFromValues(s.events, s.manifest, { config: s.config, script: s.script });
}
const USER_TEXTS = ['いや、締切は 2 月末です。', '才能の話じゃなくて、締切の話なんです。', '締切の日付は、2 月末で合っています。', '博士課程に進むか'];

describe('two_ai_summary', () => {
  it('① の要約：接触秒数、訂正、撤回、受け入れ基準が出る', () => {
    const s = buildSummary(data({ condition: 'respond_on_spot' }));
    expect(s.acceptance.filter((r) => r.ok === false)).toEqual([]);
    const f = s.points.find((p) => p.point_id === 'fact1')!;
    expect(f.heard_original_inference).toBe(false);
    expect(f.played_ms_by_variant.corrected).toBeGreaterThan(0);
    expect(s.points.find((p) => p.point_id === 'C1')!.heard_original_inference).toBeNull();
    expect(s.script_switch).toMatchObject({ switched: true, trigger: 'auto_confirmed' });
    expect(s.script_switch_detail).toMatchObject({ resume_dropped: true, slip_after_uptake: 0 });
    expect(s.retraction).toMatchObject({ timing: 'end_of_session', done_in_session: true, inference_form: 'not_spoken' });
    expect(s.interjections.correction_hold).toMatchObject({ n: 1, corrected: 1, timeout: 0 });
    expect(s.sync_marks.n).toBe(8);
    expect(s.stages.map((x) => x.stage)).toEqual([1, 2, 3, 4]);
    expect(s.board.picked).toMatchObject({ card_id: 'card_3', depends_on: 'framing_C' });
    expect(s.user_utterances).toEqual({ intake: 1, discussion: 2, response: 1, closing: 0 });
    expect(s.evidence_ok).toBe(false);
  });

  it('② の要約：止まらず、記録だけ、元の推論を聞いた', () => {
    const s = buildSummary(data({ condition: 'respond_at_end' }));
    expect(s.interjections).toMatchObject({ episodes: 2, logged_only: 2, yielded: 0, correction_hold: null });
    expect(s.points.find((p) => p.point_id === 'fact1')!.heard_original_inference).toBe(true);
    expect(s.retraction.inference_form).toBe('spoken');
    expect(s.script_switch).toBeNull();
  });

  it('保留の時間切れ（研究のセッション）：timeout、after_measures', () => {
    const s = buildSummary(data({ condition: 'respond_on_spot', self_run: false, correction: 'hold_timeout' }));
    expect(s.interjections.correction_hold).toMatchObject({ timeout: 1, corrected: 0 });
    expect(s.retraction).toMatchObject({ timing: 'after_measures', done_in_session: false, inference_form: 'not_spoken' });
    expect(s.points.find((p) => p.point_id === 'fact1')!.complete).toBe(false);
  });

  it('探索（①′）は先頭に出て、比較の証拠から外れる', () => {
    const s = buildSummary(data({ condition: 'respond_on_spot', feeds: true }));
    expect(s.experience.exploratory).toBe(true);
    expect(s.evidence_ok_for_comparison).toBe(false);
    expect(s.experience.feed_turns).toHaveLength(1);
    expect(renderSummaryMarkdown(s).split('\n').slice(0, 4).join('\n')).toContain('探索（①′）');
  });

  it('Markdown に本人の発話の本文が出ない（スナップショット）', () => {
    const md = renderSummaryMarkdown(buildSummary(data({ condition: 'respond_on_spot' })));
    for (const t of USER_TEXTS) expect(md).not.toContain(t);
    expect(md).toMatchSnapshot();
  });
});

describe('--recall', () => {
  it('段の境界 8 行、同期の印 8 行、印と ① の onset の行が出る（AC19）', () => {
    const rows = buildRecallRows(data({ condition: 'respond_on_spot' }));
    expect(rows.filter((r) => r.kind === 'stage')).toHaveLength(8);
    expect(rows.filter((r) => r.kind === 'sync').map((r) => r.trigger)).toEqual(['intake', 'stage_1', 'stage_2', 'stage_3', 'stage_4', 'response', 'next_step', 'end']);
    expect(rows.filter((r) => r.kind === 'marker')).toHaveLength(2);
    expect(rows.filter((r) => r.kind === 'onset')).toHaveLength(2);
    expect(buildRecallRows(data({ condition: 'respond_at_end' })).filter((r) => r.kind === 'onset')).toHaveLength(0);
    expect(rows).toMatchSnapshot();
  });
});

describe('--post と retraction.md', () => {
  it('撤回の文は lines から書き、ハッシュが合う', () => {
    const d = data({ condition: 'respond_on_spot', self_run: false, correction: 'hold_timeout' });
    const r = buildRetraction(d);
    expect(r.hash_ok).toBe(true);
    expect(r.markdown).toContain('事後の測度');
    expect(r.markdown).toContain('12 月末');
    const lines = d.events.find((e) => e.event === 'two_ai.retraction') as { lines: { text: string }[]; script_sha256: string };
    expect(sha256(lines.lines.map((l) => l.text).join('\n'))).toBe(lines.script_sha256);
  });

  it('ハッシュが合わなければ不一致と出す', () => {
    const s = buildSyntheticSession({ condition: 'respond_at_end' });
    const r = s.events.find((e) => e.event === 'two_ai.retraction')!;
    r.script_sha256 = 'x';
    expect(buildRetraction(sessionFromValues(s.events, s.manifest, { config: s.config, script: s.script })).hash_ok).toBe(false);
  });

  it('事後の項目：推論への同意 2 項目、段ごとの AI の文、本人の文は出ない', () => {
    const post = buildPostItems(data({ condition: 'respond_on_spot' }));
    expect(post).toContain('冬の合同説明会は、会場に行かずに');
    expect(post).toContain('研究科の説明会への質問は');
    expect(post).toContain('### 段 3 もう一歩の掘り下げ');
    for (const t of USER_TEXTS) expect(post).not.toContain(t);
  });
});

describe('--coding（AC21）', () => {
  it('(a)(b)(c)(d)：発話と印が時刻の順に 1 行ずつ、段の表 6 行、CSV に本文がない', () => {
    for (const condition of ['respond_on_spot', 'respond_at_end'] as const) {
      const d = data({ condition });
      const out = buildCoding(d);
      const finals = d.events.filter((e) => e.event === 'stt.final' && e.two_ai?.phase !== 'intake').length;
      const markers = d.events.filter((e) => e.event === 'two_ai.marker').length;
      expect(out.utterances.filter((r) => r.row_kind === 'utterance')).toHaveLength(finals);
      expect(out.utterances.filter((r) => r.row_kind === 'marker')).toHaveLength(markers);
      const times = out.utterances.map((r) => r.t_monotonic_ms as number);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(out.stages.map((s) => s.stage)).toEqual(['1', '2', '3', '4', 'response', 'closing']);
      expect(out.intake_utterances).toBe(1);
      const files = codingFiles(out);
      for (const t of USER_TEXTS) {
        expect(files['coding_utterances.csv']).not.toContain(t);
        expect(files['coding_stages.csv']).not.toContain(t);
      }
      expect(files['coding_texts.jsonl']).toContain('締切');
      const discussion = out.utterances.find((r) => r.row_kind === 'utterance' && r.phase === 'discussion')!;
      expect(discussion).toMatchObject({ stage: 1, prev_point_id: 'fact1', text_ref: expect.stringMatching(/^stt:\d+$/) });
      expect(typeof discussion.t_content_ms).toBe('number');
      expect(discussion.outcome).toBe(condition === 'respond_on_spot' ? 'yielded' : 'logged_only');
      expect(discussion.correction).toBe(condition === 'respond_on_spot' ? 'switched' : 'rejected');
      expect(out.stages.find((s) => s.stage === '3')!.sync_flash_monotonic_ms).not.toBeNull();
    }
  });

  it('(e) --blind：条件が空、ID が符号、本文の参照も符号つき', () => {
    const d = data({ condition: 'respond_on_spot' });
    const out = buildCoding(d, { blind: true });
    const code = blindCode(d.session_id);
    expect(out.utterances.every((r) => r.condition === '' && r.session_id === code)).toBe(true);
    expect(out.stages.every((r) => r.condition === '' && r.session_id === code)).toBe(true);
    expect(JSON.stringify(out)).not.toContain(d.session_id);
    expect(out.texts[0]!.text_ref.startsWith(`${code}:stt:`)).toBe(true);
  });

  it('スナップショット', () => {
    expect(codingFiles(buildCoding(data({ condition: 'respond_on_spot' })))).toMatchSnapshot();
  });
});

describe('cli（runReport）', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'two-ai-report-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('① と ② の 2 本から要約、並べ、書き出しをすべて書く', async () => {
    const a = await writeSyntheticSession(join(dir, 'a'), buildSyntheticSession({ condition: 'respond_on_spot' }));
    const b = await writeSyntheticSession(join(dir, 'b'), buildSyntheticSession({ condition: 'respond_at_end' }));
    const result = await runReport([a, b], { pair: true, recall: true, post: true, coding: true });
    expect(result.ok).toBe(true);
    for (const name of ['two_ai_summary.json', 'two_ai_summary.md', 'recall_points.csv', 'post_items.md', 'retraction.md', 'coding/coding_utterances.csv']) {
      expect(result.written).toContain(join(a, name));
    }
    expect(await readFile(join(a, 'two_ai_pair.md'), 'utf8')).toContain('AC2(d)');
    const blind = await runReport([a, b], { coding: true, blind: true, out: join(dir, 'blind') });
    const csvText = await readFile(join(dir, 'blind', 'coding_utterances.csv'), 'utf8');
    expect(csvText).not.toContain('respond_on_spot');
    expect(csvText).not.toContain('synthetic_');
    expect(blind.written).toContain(join(dir, 'blind', 'coding_texts.jsonl'));
  });
});
