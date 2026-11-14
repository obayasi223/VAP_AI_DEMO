/**
 * セッション後の要約（two_ai_summary.json／.md。04 D）と ① ② の並べ（--pair）。
 * orchestrator は呼ばない（05 §5.2 の m9）。研究者が npm run report:two_ai で作る。試走と T2 の試験はこの関数を直接呼ぶ。
 * 本人の発話の本文は載せない（件数、STT の ID、時刻だけ。本文は --coding）。
 */
import { checkPair, checkTwoAiAcceptance, type AcceptanceRow } from './acceptance';
import { mval, ofType, phaseOf, quantile, spokenText, twoAiSpeech, type TwoAiSessionData } from './session';
import { stageSpans } from './timeline';

const r1 = (x: number | null) => (x === null ? null : Math.round(x));

function stat(values: number[]): { median: number | null; p90: number | null; max: number | null; n: number } {
  return { median: r1(quantile(values, 0.5)), p90: r1(quantile(values, 0.9)), max: values.length ? Math.max(...values) : null, n: values.length };
}

export type TwoAiSummary = ReturnType<typeof buildSummary>;

export function buildSummary(data: TwoAiSessionData) {
  const ev = data.events;
  const m = data.two_ai;
  const warnings: string[] = [...data.notes];
  if (data.invalid_lines > 0) warnings.push(`スキーマに通らない行 ${data.invalid_lines} 件（log_check で確かめる）`);
  if (data.two_ai_error) warnings.push(`manifest の two_ai が読めない: ${data.two_ai_error}`);
  const providers = (data.manifest?.providers ?? {}) as Record<string, { provider?: string; provider_class?: string }>;
  const provider_classes = Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, v.provider_class ?? 'unknown']));
  const evidence_ok = Object.keys(providers).length > 0 && Object.values(provider_classes).every((c) => c === 'production');

  const changes = ofType(ev, 'two_ai.phase_changed');
  const lastT = ev.at(-1)?.t_monotonic_ms ?? 0;
  const phases = changes.map((c, i) => {
    const end = changes[i + 1]?.t_monotonic_ms ?? lastT;
    return { phase: c.to, started_at: c.t_monotonic_ms, ended_at: end, duration_sec: Math.round((end - c.t_monotonic_ms) / 100) / 10, planned_sec: mval(c.planned_duration_ms) === null ? null : mval(c.planned_duration_ms)! / 1000 };
  });

  const pointEvents = ofType(ev, 'two_ai.point');
  const exposures = ofType(ev, 'two_ai.point_exposure');
  const episodes = ofType(ev, 'two_ai.interjection_episode');
  const turns = ofType(ev, 'two_ai.turn');
  const pointIds = [...new Set([...(m?.planned_points.map((p) => p.id) ?? []), ...pointEvents.map((p) => p.point_id)])];
  const points = pointIds.map((id) => {
    const started = pointEvents.find((p) => p.point_id === id && p.stage === 'started');
    const exp = exposures.find((p) => p.point_id === id);
    const kind = exp?.point_kind ?? pointEvents.find((p) => p.point_id === id)?.point_kind ?? m?.planned_points.find((p) => p.id === id)?.kind ?? null;
    const byVariant = { original: 0, corrected: 0 };
    for (const s of exp?.segments ?? []) byVariant[s.variant] += s.played_ms;
    const heard = kind === 'fact_slip' ? (exp?.segments ?? []).some((s) => s.variant === 'original' && s.turn_kind === 'point_elaboration' && s.played_ms > 0) : null;
    return {
      point_id: id,
      kind,
      speaker: exp?.speaker ?? started?.speaker ?? null,
      started_turn: started?.turn_id ?? null,
      deviation_ms: started ? mval(started.deviation_ms) : null,
      exposure_new_ms: exp?.exposure_new_ms ?? null,
      exposure_total_ms: exp?.exposure_total_ms ?? null,
      repeated_ms: exp?.repeated_ms ?? null,
      bridge_ms: exp?.bridge_ms ?? null,
      planned_exposure_ms: exp ? mval(exp.planned_exposure_ms) : null,
      elaborations_done: exp?.elaborations_done ?? null,
      elaborations_planned: exp?.elaborations_planned ?? null,
      complete: exp?.complete ?? null,
      forced: pointEvents.some((p) => p.point_id === id && p.stage === 'forced'),
      unavailable: pointEvents.some((p) => p.point_id === id && p.stage === 'unavailable'),
      missed: pointEvents.some((p) => p.point_id === id && p.stage === 'missed'),
      cut_by_interjection_ms: (exp?.segments ?? []).filter((s) => s.cut === 'interjection').reduce((sum, s) => sum + s.played_ms, 0),
      played_ms_by_variant: byVariant,
      heard_original_inference: heard,
    };
  });

  const plans = ofType(ev, 'two_ai.plan');
  const waits = ofType(ev, 'two_ai.plan_wait');
  const frozen = plans.filter((p) => p.stage === 'frozen' || p.stage === 'reused').at(-1);
  const plan = {
    source: m?.plan_source ?? frozen?.source ?? null,
    plan_wait_ms: m?.plan_wait_ms ?? (waits.length ? Math.max(...waits.map((w) => w.waited_ms)) : 0),
    fallback_used: waits.some((w) => w.stage === 'fallback_used'),
    fact_slip: m?.fact_slip ?? (pointEvents.some((p) => p.point_kind === 'fact_slip' && p.stage === 'unavailable') ? 'unavailable' : 'available'),
    fact_slip_source: m?.fact_slip_source ?? frozen?.fact_slip_source ?? null,
    control_inference: m?.control_inference ?? (pointEvents.some((p) => p.point_kind === 'control_inference' && p.stage === 'unavailable') ? 'unavailable' : 'available'),
  };

  const markers = ofType(ev, 'two_ai.marker');
  const onsets = ofType(ev, 'two_ai.interjection').filter((i) => i.stage === 'onset');
  const stages = stageSpans(data)
    .filter((s) => /^[1-4]$/.test(s.stage))
    .map((s) => {
      const inSpan = (t: number) => t >= s.started_at && (s.ended_at === null || t < s.ended_at);
      return {
        stage: Number(s.stage),
        heading: s.heading,
        started_at: s.started_at,
        ended_at: s.ended_at,
        started_wall_clock: s.started_wall,
        offset_in_audio_ms: data.audio === null ? null : Math.round(s.started_at - data.audio.first_t_monotonic_ms),
        content_elapsed_ms_at_start: s.started_content_ms,
        markers: markers.filter((x) => inSpan(x.t_monotonic_ms)).length,
        onsets: onsets.filter((x) => inSpan(x.t_monotonic_ms)).length,
      };
    });

  const sttFinals = ofType(ev, 'stt.final');
  const countPhase = (names: string[]) => sttFinals.filter((f) => names.includes(phaseOf(f) ?? '')).length;
  const user_utterances = { intake: countPhase(['intake']), discussion: countPhase(['discussion']), response: countPhase(['response']), closing: countPhase(['next_step', 'end']) };

  const boards = ofType(ev, 'two_ai.board');
  const shownMap = new Map<string, { card_id: string; order: number; variant: string; at: number }>();
  for (const b of boards.filter((x) => x.reason === 'shown')) for (const c of b.cards) if (!shownMap.has(c.card_id)) shownMap.set(c.card_id, { card_id: c.card_id, order: c.order, variant: c.variant, at: b.t_monotonic_ms });
  const picks = ofType(ev, 'two_ai.board_picked');
  const picked = picks.find((p) => p.outcome === 'picked') ?? null;
  const board = {
    shown: [...shownMap.values()],
    rebuilt_at: boards.find((b) => b.mode === 'rebuilt')?.t_monotonic_ms ?? null,
    picked: picked ? { card_id: picked.card_id, depends_on: picked.card_depends_on, variant: picked.card_variant, latency_ms: mval(picked.latency_ms) } : null,
    pick_outcome: picks.find((p) => p.outcome !== 'rejected')?.outcome ?? null,
  };
  const markerSummary = {
    n_counted: markers.filter((x) => x.counted).length,
    n_total: markers.length,
    by_stage: Object.fromEntries([1, 2, 3, 4].map((s) => [String(s), markers.filter((x) => x.counted && x.discussion_stage === s).length])),
    during_point: markers.reduce<Record<string, number>>((acc, x) => {
      const k = x.during_point_id ?? 'none';
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
    browser_time_missing: markers.filter((x) => x.time_basis.source !== 'browser_rtt').length,
  };
  const board_picks = {
    n_picked: picks.filter((p) => p.outcome === 'picked').length,
    n_rejected: picks.filter((p) => p.outcome === 'rejected').length,
    n_timeout: picks.filter((p) => p.outcome === 'timeout').length,
    browser_time_missing: picks.filter((p) => p.outcome !== 'timeout' && p.time_basis.source !== 'browser_rtt').length,
  };
  if (markerSummary.browser_time_missing + board_picks.browser_time_missing > 0) warnings.push(`時計差がなく受信の時刻にした印と選択 ${markerSummary.browser_time_missing + board_picks.browser_time_missing} 件`);
  const syncs = ofType(ev, 'two_ai.sync_mark');

  const finished = twoAiSpeech(ev, 'finished');
  const rw = ofType(ev, 'two_ai.response_window')[0];
  const rebuildSpeeches = finished.filter((s) => s.turn_kind === 'rebuild');
  const closing = {
    question_played_ms: rw?.question_played_ms ?? null,
    rebuild_turns: rebuildSpeeches.length,
    identical_to_script: data.script?.rebuild_turns ? rebuildSpeeches.map(spokenText).join('\n') === data.script.rebuild_turns.map((t) => t.text).join('\n') : null,
  };
  const retr = ofType(ev, 'two_ai.retraction')[0];
  const retraction = {
    timing: retr?.timing ?? m?.retraction.timing ?? null,
    done_in_session: finished.some((s) => s.turn_kind === 'retraction'),
    script_sha256: retr?.script_sha256 ?? null,
    inference_form: retr?.inference_form ?? null,
  };

  const holds = episodes.map((e) => e.correction_hold).filter((h): h is NonNullable<typeof h> => h !== null);
  const stops = episodes.map((e) => mval(e.stop_latency_ms)).filter((x): x is number => x !== null);
  const discussionPhase = phases.find((p) => p.phase === 'discussion');
  const discussionMin = discussionPhase ? (discussionPhase.ended_at - discussionPhase.started_at) / 60000 : 0;
  const byPoint = episodes.reduce<Record<string, number>>((acc, e) => {
    const k = e.during_point_id ?? 'none';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const interjections = {
    episodes: episodes.length,
    yielded: episodes.filter((e) => e.outcome === 'yielded').length,
    false_onset: episodes.filter((e) => e.outcome === 'false_onset').length,
    onset_no_speech: episodes.filter((e) => e.outcome === 'onset_no_speech').length,
    logged_only: episodes.filter((e) => e.outcome === 'logged_only').length,
    sub_threshold: ofType(ev, 'two_ai.interjection').filter((i) => i.stage === 'sub_threshold').length,
    near_marker: episodes.filter((e) => e.near_marker).length,
    correction_hold: holds.length === 0 ? null : {
      n: holds.length,
      corrected: holds.filter((h) => h.ended_by === 'corrected').length,
      not_correction: holds.filter((h) => h.ended_by === 'not_correction').length,
      timeout: holds.filter((h) => h.ended_by === 'timeout').length,
      woz_resume: holds.filter((h) => h.ended_by === 'woz_resume').length,
      abandoned: holds.filter((h) => h.ended_by === 'abandoned').length,
      stt_final_after_ms_p95: r1(quantile(holds.map((h) => mval(h.stt_final_after_ms)).filter((x): x is number => x !== null), 0.95)),
      judgment_after_ms_p95: r1(quantile(holds.map((h) => mval(h.judgment_after_ms)).filter((x): x is number => x !== null), 0.95)),
    },
    stop_latency_ms: stops.length === 0 ? null : stat(stops),
    per_min: discussionMin > 0 ? Math.round((episodes.filter((e) => phaseOf(e) === 'discussion').length / discussionMin) * 100) / 100 : 0,
    by_point: byPoint,
  };
  const acks = episodes.map((e) => e.ack).filter((a): a is NonNullable<typeof a> => a !== null);
  const acknowledgments = {
    n: acks.length,
    template_ids: acks.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.template_id]: (acc[a.template_id] ?? 0) + 1 }), {}),
    played_ms: acks.length === 0 ? null : { min: Math.min(...acks.map((a) => a.played_ms)), median: r1(quantile(acks.map((a) => a.played_ms), 0.5)), max: Math.max(...acks.map((a) => a.played_ms)) },
    truncated: acks.filter((a) => a.truncated).length,
  };
  const scripts = ofType(ev, 'two_ai.script');
  const sw = scripts.find((s) => s.stage === 'switched');
  const swEpisode = sw ? episodes.find((e) => e.correction?.point_id === sw.point_id) : undefined;
  const script_switch = sw ? { switched: true, trigger: sw.trigger, decided_at: sw.decided_at, delay_from_user_speech_ms: swEpisode && mval(swEpisode.user_speech_end_at) !== null ? Math.round(sw.decided_at - mval(swEpisode.user_speech_end_at)!) : null } : null;
  const acceptance = checkTwoAiAcceptance(data);
  const ac3 = acceptance.rows.find((r) => r.id === 'AC3');
  const script_switch_detail = sw
    ? { resume_dropped: sw.resume_dropped, replaced_point_turns: sw.replaced_point_turn_ids.length, slip_after_uptake: ac3?.ok === false ? (ac3.detail.match(/\(h\)/g) ?? []).length : 0 }
    : null;
  const response_window = rw
    ? { planned_sec: rw.planned_ms / 1000, actual_sec: Math.round((rw.ended_at - rw.started_at) / 100) / 10, overrun_ms: rw.overrun_ms, user_speech_ms: rw.user_speech_ms, silence_prompts: rw.silence_prompts, correction_recorded: rw.correction_recorded, ack_given: rw.ack_given }
    : null;
  const feedTurns = turns.filter((t) => t.stage === 'started' && t.feed_turn);
  const fed = ofType(ev, 'two_ai.interjection_fed');
  const experience = {
    exploratory: m?.exploratory ?? fed.length > 0,
    feed_turns: feedTurns.map((t) => ({ interjection_id: fed.filter((f) => f.t_monotonic_ms <= t.t_monotonic_ms).at(-1)?.interjection_id ?? null, turn_id: t.turn_id, text_origin: t.text_origin })),
  };
  const notes = [...(m?.evidence_notes ?? [])];
  const forced = points.filter((p) => p.forced).length;
  const missed = points.filter((p) => p.missed).length;
  if (experience.exploratory && !notes.includes('exploratory')) notes.push('exploratory');
  if (plan.fallback_used && !notes.some((n) => n.includes('fallback'))) notes.push('fallback_outline');
  if (plan.fact_slip === 'unavailable') notes.push('fact_slip_unavailable');
  if (plan.control_inference === 'unavailable') notes.push('control_inference_unavailable');
  if (forced > 0) notes.push(`points_forced:${forced}`);
  if (missed > 0) notes.push(`points_missed:${missed}`);
  const evidence_ok_for_comparison = (m?.evidence_ok_for_comparison ?? true) && notes.length === 0;
  if (m && m.evidence_ok_for_comparison !== evidence_ok_for_comparison) warnings.push(`manifest の evidence_ok_for_comparison（${m.evidence_ok_for_comparison}）と記録からの判定（${evidence_ok_for_comparison}）が違う`);

  const gaps = turns.filter((t) => t.stage === 'started' && ['discussion', 'point', 'point_elaboration'].includes(t.turn_kind)).map((t) => mval(t.gap_ms)).filter((x): x is number => x !== null);
  const states = ofType(ev, 'two_ai.ai_state');
  const framing_trajectory = states.map((s, i) => ({ ai_id: s.speaker, turn_index: i, framing_C: s.state.framing_C, fact_slip: s.state.fact_slip }));
  const woz = ofType(ev, 'woz.override').map((w) => {
    const d = w.detail as { status?: string } | null;
    return { action: w.action, at: w.t_monotonic_ms, accepted: d?.status === 'applied' || d?.status === 'recorded' };
  });
  const rtf = ofType(ev, 'audio.health').map((a) => (a.reporter === 'worker' ? mval(a.rtf) : null)).filter((x): x is number => x !== null);
  const render = ofType(ev, 'render.health');
  const perf = {
    vap_rtf_p95: quantile(rtf, 0.95),
    vap_backlog_p95_ms: null as number | null,
    render_fps_p5: render.length ? Math.min(...render.map((r) => r.fps_p5)) : null,
    long_tasks: render.length ? render.reduce((s, r) => s + r.long_tasks, 0) : null,
  };
  if (perf.vap_rtf_p95 !== null && perf.vap_rtf_p95 >= 0.7) warnings.push(`VAP の RTF p95 ${perf.vap_rtf_p95.toFixed(2)} が予算 0.7 を超えた`);
  if (perf.render_fps_p5 !== null && perf.render_fps_p5 < 30) warnings.push(`描画の fps p5 ${perf.render_fps_p5} が 30 未満`);

  return {
    session_id: data.session_id,
    condition: m?.condition ?? ev[0]?.condition ?? null,
    script_id: m?.script_id ?? null,
    script_kind: m?.script_kind ?? null,
    provider_classes,
    evidence_ok,
    phases,
    points,
    plan,
    stages,
    user_utterances,
    board,
    markers: markerSummary,
    board_picks,
    sync_marks: { n: syncs.length, triggers: syncs.map((s) => s.trigger) },
    closing,
    retraction,
    interjections,
    acknowledgments,
    script_switch,
    script_switch_detail,
    response_window,
    experience,
    evidence_ok_for_comparison,
    evidence_notes: notes,
    turn_gaps_ms: stat(gaps),
    framing_trajectory,
    woz,
    perf,
    acceptance: acceptance.rows,
    warnings,
  };
}

const okMark = (r: AcceptanceRow) => (r.ok === null ? '—' : r.ok ? '合格' : '**不合格**');
const fmt = (x: unknown) => (x === null || x === undefined ? '—' : String(x));

export function renderSummaryMarkdown(s: TwoAiSummary): string {
  const out: string[] = [];
  out.push(`# 2 体のセッションの要約：${s.session_id}`, '');
  if (s.experience.exploratory) out.push('> **探索（①′）**：体験の旗が有効なセッション。条件の比較の証拠に使わない（AC12）。', '');
  if (!s.evidence_ok) out.push(`> 受け入れの証拠に数えない（プロバイダ：${Object.entries(s.provider_classes).map(([k, v]) => `${k}=${v}`).join('、') || '不明'}。AC11）。`, '');
  out.push(`条件：${fmt(s.condition)}　台本：${fmt(s.script_id)}（${fmt(s.script_kind)}）　比較の証拠：${s.evidence_ok_for_comparison ? '可' : `不可（${s.evidence_notes.join('、')}）`}`, '');
  out.push('## 1. 受け入れ基準', '', '| ID | 判定 | 詳細 |', '|---|---|---|');
  for (const r of s.acceptance) out.push(`| ${r.id} | ${okMark(r)} | ${r.detail.replace(/\|/g, '｜')} |`);
  out.push('', '## 2. 段階ごとの時間', '', '| 段階 | 長さ（秒） | 計画（秒） |', '|---|---|---|');
  for (const p of s.phases) out.push(`| ${p.phase} | ${p.duration_sec} | ${fmt(p.planned_sec)} |`);
  out.push('', '## 3. 点ごとの接触秒数', '', '| 点 | 種類 | 話者 | 新しい部分 ms | 総量 ms | 計画 ms | 展開 | 完了 | 版ごとの再生（元／訂正後） | 元の推論を聞いた |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const p of s.points) out.push(`| ${p.point_id} | ${fmt(p.kind)} | ${fmt(p.speaker)} | ${fmt(p.exposure_new_ms)} | ${fmt(p.exposure_total_ms)} | ${fmt(p.planned_exposure_ms)} | ${fmt(p.elaborations_done)}/${fmt(p.elaborations_planned)} | ${p.unavailable ? '作れなかった' : fmt(p.complete)}${p.forced ? '（forced）' : ''} | ${p.played_ms_by_variant.original}／${p.played_ms_by_variant.corrected} | ${fmt(p.heard_original_inference)} |`);
  const ij = s.interjections;
  out.push('', '## 4. 割り込み', '', `episode ${ij.episodes}（yielded ${ij.yielded}、false_onset ${ij.false_onset}、onset_no_speech ${ij.onset_no_speech}、logged_only ${ij.logged_only}）、兆しだけ ${ij.sub_threshold}、印の近く ${ij.near_marker}、毎分 ${ij.per_min}`);
  out.push(`停止の遅れ：${ij.stop_latency_ms ? `中央値 ${ij.stop_latency_ms.median}ms、p90 ${ij.stop_latency_ms.p90}ms、最大 ${ij.stop_latency_ms.max}ms（n=${ij.stop_latency_ms.n}）` : '—'}`);
  out.push(`受け止め：${s.acknowledgments.n} 回、長さ ${s.acknowledgments.played_ms ? `${s.acknowledgments.played_ms.min}〜${s.acknowledgments.played_ms.max}ms` : '—'}、途中で切れた ${s.acknowledgments.truncated}`);
  if (ij.correction_hold) out.push(`判定の保留：${ij.correction_hold.n} 回（訂正 ${ij.correction_hold.corrected}、訂正でない ${ij.correction_hold.not_correction}、時間切れ ${ij.correction_hold.timeout}、研究者の resume ${ij.correction_hold.woz_resume}）、確定文 p95 ${fmt(ij.correction_hold.stt_final_after_ms_p95)}ms、判定 p95 ${fmt(ij.correction_hold.judgment_after_ms_p95)}ms`);
  out.push('', '## 5. 台本の切替と当日の撤回', '');
  out.push(s.script_switch ? `切替：${s.script_switch.trigger}、発話の終わりから ${fmt(s.script_switch.delay_from_user_speech_ms)}ms、言い直しをやめた ${fmt(s.script_switch_detail?.resume_dropped)}` : '切替：なし');
  out.push(`撤回：${fmt(s.retraction.timing)}、セッションの中で話した ${s.retraction.done_in_session}、推論の文 ${fmt(s.retraction.inference_form)}（文は retraction.md）`);
  out.push('', '## 5b. 段と印と板', '', '| 段 | 見出し | 開始 ms | 中身の時計 ms | 印 | onset |', '|---|---|---|---|---|---|');
  for (const st of s.stages) out.push(`| ${st.stage} | ${st.heading} | ${Math.round(st.started_at)} | ${fmt(st.content_elapsed_ms_at_start)} | ${st.markers} | ${st.onsets} |`);
  out.push('', `印：${s.markers.n_counted}/${s.markers.n_total}（時計差なし ${s.markers.browser_time_missing}）　同期の印：${s.sync_marks.n}（${s.sync_marks.triggers.join(' → ')}）`);
  out.push(`板：${s.board.shown.map((c) => `${c.order}:${c.card_id}(${c.variant})`).join('、') || 'なし'}、作り直し ${s.board.rebuilt_at === null ? 'なし' : 'あり'}、選んだカード ${s.board.picked ? `${s.board.picked.card_id}（${s.board.picked.depends_on}、${s.board.picked.latency_ms}ms）` : fmt(s.board.pick_outcome)}`);
  if (s.response_window) out.push(`応答の段：計画 ${s.response_window.planned_sec} 秒、実際 ${s.response_window.actual_sec} 秒、延長 ${s.response_window.overrun_ms}ms、本人の発話 ${s.response_window.user_speech_ms}ms、促し ${s.response_window.silence_prompts}、受け止め ${s.response_window.ack_given}`);
  out.push(`本人の発話の件数（本文は --coding）：intake ${s.user_utterances.intake}、discussion ${s.user_utterances.discussion}、response ${s.user_utterances.response}、closing ${s.user_utterances.closing}`);
  out.push('', '## 6. AI の捉え方の推移', '');
  if (s.framing_trajectory.length === 0) out.push('記録なし');
  else {
    out.push('| # | AI | C | 取り違え |', '|---|---|---|---|');
    for (const f of s.framing_trajectory) out.push(`| ${f.turn_index} | ${f.ai_id} | ${f.framing_C} | ${f.fact_slip} |`);
  }
  out.push('', '## 7. WoZ', '');
  out.push(s.woz.length === 0 ? 'なし' : s.woz.map((w) => `- ${Math.round(w.at)}ms ${w.action}（${w.accepted ? '受付' : '拒否'}）`).join('\n'));
  out.push('', '## 8. 性能', '', `VAP の RTF p95 ${s.perf.vap_rtf_p95 === null ? '未計測' : s.perf.vap_rtf_p95.toFixed(2)}、描画の fps p5 ${fmt(s.perf.render_fps_p5)}、長いタスク ${fmt(s.perf.long_tasks)}、AI 同士の間 中央値 ${fmt(s.turn_gaps_ms.median)}ms p90 ${fmt(s.turn_gaps_ms.p90)}ms`);
  if (s.warnings.length > 0) out.push('', '## 警告', '', ...s.warnings.map((w) => `- ${w}`));
  out.push('');
  return out.join('\n');
}

/** --pair：① と ② の 2 回を並べる（AC2(d)、AC6(e)、AC13）。 */
export function renderPairMarkdown(a: TwoAiSessionData, b: TwoAiSessionData): { markdown: string; rows: AcceptanceRow[] } {
  const sa = buildSummary(a);
  const sb = buildSummary(b);
  const rows = checkPair(a, b);
  const out: string[] = ['# ① と ② の並べ', '', `| 項目 | ${sa.session_id}（${fmt(sa.condition)}） | ${sb.session_id}（${fmt(sb.condition)}） |`, '|---|---|---|'];
  const ids = [...new Set([...sa.points.map((p) => p.point_id), ...sb.points.map((p) => p.point_id)])];
  for (const id of ids) {
    const x = sa.points.find((p) => p.point_id === id);
    const y = sb.points.find((p) => p.point_id === id);
    out.push(`| ${id} 新しい部分 ms（総量） | ${fmt(x?.exposure_new_ms)}（${fmt(x?.exposure_total_ms)}） | ${fmt(y?.exposure_new_ms)}（${fmt(y?.exposure_total_ms)}） |`);
  }
  out.push(`| 応答の段の延長 overrun_ms（操作の確認、AC6(e)） | ${fmt(sa.response_window?.overrun_ms)} | ${fmt(sb.response_window?.overrun_ms)} |`);
  out.push(`| 応答の段の本人の発話 ms | ${fmt(sa.response_window?.user_speech_ms)} | ${fmt(sb.response_window?.user_speech_ms)} |`);
  out.push(`| 計画の待ち ms | ${fmt(sa.plan.plan_wait_ms)} | ${fmt(sb.plan.plan_wait_ms)} |`);
  out.push(`| 割り込みの episode | ${sa.interjections.episodes} | ${sb.interjections.episodes} |`);
  out.push(`| 印（数えた） | ${sa.markers.n_counted} | ${sb.markers.n_counted} |`);
  out.push(`| 選んだカード | ${fmt(sa.board.picked?.card_id)} | ${fmt(sb.board.picked?.card_id)} |`);
  out.push('', '## 並べて見る基準', '', '| ID | 判定 | 詳細 |', '|---|---|---|');
  for (const r of rows) out.push(`| ${r.id} | ${okMark(r)} | ${r.detail} |`);
  out.push('');
  return { markdown: out.join('\n'), rows };
}
