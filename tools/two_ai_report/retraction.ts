/**
 * 撤回の文（retraction.md）と事後の項目（post_items.md）（--post。04 D、1-6、AC20）。
 * 撤回の文は two_ai.retraction.lines からだけ書く（計画を読み直さない、closing.ts を呼ばない。05 §5.2 の m9）。
 * 本人の発話の本文は載せない。
 */
import { ofType, sameHash, sha256, twoAiSpeech, spokenText, type TwoAiSessionData } from './session';

export interface RetractionDoc {
  markdown: string;
  hash_ok: boolean | null;
}

export function buildRetraction(data: TwoAiSessionData): RetractionDoc {
  const r = ofType(data.events, 'two_ai.retraction')[0];
  if (r === undefined) return { markdown: '# 当日の撤回\n\nこのセッションには two_ai.retraction がない（end に届いていない）。\n', hash_ok: null };
  const hash = sha256(r.lines.map((l) => l.text).join('\n'));
  const ok = r.lines.length > 0 && sameHash(r.script_sha256, hash);
  const out = [
    '# 当日の撤回',
    '',
    `- セッション：${data.session_id}`,
    `- 時機：${r.timing === 'after_measures' ? '事後の測度の後に研究者が読む（after_measures）' : 'セッションの end で AI が話した（end_of_session）'}${r.trigger === 'aborted' ? '（中止）' : ''}`,
    `- 推論の文の形：${r.inference_form}`,
    `- ハッシュ：${ok ? '一致' : `不一致（記録 ${r.script_sha256}、lines から ${hash}）`}`,
    '',
    r.timing === 'after_measures' ? '事後の測度（確信度、核、推論への同意、再認、刺激再生）を終えてから、次の文を読む。' : '次の文はセッションの中で話した。',
    '',
    ...r.lines.map((l) => `> ${l.text}`),
    '',
  ];
  return { markdown: out.join('\n'), hash_ok: r.lines.length === 0 ? false : ok };
}

/** 並べる順はセッションの ID から決めて固定（04 D）。 */
function orderFromId(id: string): boolean {
  return parseInt(sha256(id).slice(0, 2), 16) % 2 === 0;
}

export function buildPostItems(data: TwoAiSessionData): string {
  const out: string[] = ['# 事後の項目（研究者用。参加者に見せない）', '', `セッション：${data.session_id}`, ''];
  out.push('## 1. 推論への同意（2 項目）', '');
  const script = data.script;
  const inferences = (script?.planned_points ?? [])
    .filter((p) => (p.kind === 'fact_slip' || p.kind === 'control_inference') && p.inference !== null)
    .map((p) => ({ id: p.id, kind: p.kind, conclusion: p.inference!.conclusion }));
  const unavailable = new Set(ofType(data.events, 'two_ai.point').filter((p) => p.stage === 'unavailable').map((p) => p.point_id));
  const items = inferences.filter((i) => !unavailable.has(i.id));
  if (items.length === 0) out.push('推論の文が分からない（台本が読めないか、点が作れなかった）。', '');
  else {
    const ordered = orderFromId(data.session_id) ? items : [...items].reverse();
    ordered.forEach((i, n) => out.push(`${n + 1}. 「${i.conclusion}」に、どのくらい同意しますか。（1 まったく同意しない 〜 7 とても同意する）`));
    out.push('', `（内部の対応：${ordered.map((i, n) => `${n + 1}=${i.kind}`).join('、')}。参加者に見せない）`, '');
  }
  out.push('## 2. 段ごとの AI の発話（再認の問いを作る材料）', '');
  const speeches = twoAiSpeech(data.events, 'finished').filter((s) => s.two_ai?.phase === 'discussion' && ['discussion', 'point', 'point_elaboration', 'resume'].includes(s.turn_kind));
  for (const stage of [1, 2, 3, 4]) {
    const heading = ofType(data.events, 'two_ai.stage').find((s) => s.discussion_stage === stage)?.heading ?? '';
    out.push(`### 段 ${stage}${heading ? ` ${heading}` : ''}`, '');
    for (const s of speeches.filter((x) => x.two_ai?.discussion_stage === stage)) out.push(`- ${s.ai_id}（${s.turn_kind}${s.point_id ? `、${s.point_id}` : ''}）：${spokenText(s)}`);
    out.push('');
  }
  out.push('## 3. 撤回の文', '', 'retraction.md を参照（測度の後に読む）。', '');
  return out.join('\n');
}
