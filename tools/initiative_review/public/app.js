// 評価画面の本体。ビルドなしの素の JS。ログの文字はすべて textContent で入れる（innerHTML は使わない）。
// 他の評価者の評価の中身は取りにいかない（評価の独立のため）。回数や発生率は出さない。

import { renderAudioTimeline } from '/audio_timeline.js';

const PROVENANCE_LABEL = { model_output: 'LLM 生成', verified: 'コードの検証', code: 'コード' };

const AXES = {
  content: {
    legend: '① 内容の妥当性（その立場で言う価値があるか）',
    noneLegend: '① 言わない判断の妥当性（言う価値のあることはなかったか）',
    options: [['valid', '妥当'], ['partly', '一部妥当'], ['invalid', '妥当でない'], ['cannot_judge', '判断できない']],
  },
  timing: {
    legend: '② 申し出る時点の適切さ（話の途中のこの時点でよいか）',
    options: [['good', 'この時点でよい'], ['early', '早い'], ['late', '遅い'], ['wait_until_end', '話し終わってからでよい'], ['cannot_judge', '判断できない'], ['not_applicable', '該当しない']],
  },
  wait_withdraw: {
    legend: '③ 待機・撤回の妥当性',
    options: [['appropriate', '妥当'], ['should_have_spoken_sooner', '待たずに言うべきだった'], ['should_have_withdrawn', '撤回すべきだった'], ['should_not_have_withdrawn', '撤回すべきでなかった'], ['cannot_judge', '判断できない'], ['not_applicable', '該当しない']],
  },
};

const state = {
  sessions: [],
  session: null,
  sessionId: null,
  reviewer: '',
  doc: null,
  dirty: false,
  saving: false,
  conflict: false,
  selected: null,
  draftMissed: null,
  saveTimer: null,
  showAll: false,
};

// ---- 小道具 -----------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'text') node.textContent = value;
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** null や false を飛ばして子を足す（Node.append は null を文字にしてしまう）。 */
function appendAll(parent, ...children) {
  parent.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

function fmtT(ms) {
  if (ms === null || ms === undefined) return '—';
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function setStatus(text, error = false) {
  const status = document.getElementById('status');
  status.textContent = text;
  status.className = error ? 'error' : '';
}

function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できないブラウザ設定でも動く。
  }
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${(await response.json().catch(() => ({}))).error ?? ''}`);
  return response.json();
}

// ---- 評価の保存 --------------------------------------------------------------

function emptyDoc() {
  return { revision: 0, items: {}, missed: [] };
}

function markDirty() {
  state.dirty = true;
  setStatus('未保存の変更があります');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => void save(), 500);
}

async function save() {
  clearTimeout(state.saveTimer);
  if (!state.dirty || state.saving || state.conflict || !state.reviewer || !state.sessionId || !state.doc) return true;
  state.saving = true;
  state.dirty = false;
  setStatus('保存しています…');
  try {
    const response = await fetch(`/api/sessions/${state.sessionId}/reviews/${encodeURIComponent(state.reviewer)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base_revision: state.doc.revision, items: state.doc.items, missed: state.doc.missed }),
    });
    if (response.status === 409) {
      state.conflict = true;
      state.dirty = true;
      setStatus('別の画面で先に保存されました。再読み込みしてください（この画面の変更は保存されていません）', true);
      return false;
    }
    if (!response.ok) {
      state.dirty = true;
      setStatus(`保存できません: ${(await response.json().catch(() => ({}))).error ?? response.status}`, true);
      return false;
    }
    const saved = await response.json();
    state.doc.revision = saved.revision;
    setStatus(`保存しました ${new Date().toLocaleTimeString('ja-JP')}`);
    return true;
  } catch (error) {
    state.dirty = true;
    setStatus(`保存できません: ${error.message}`, true);
    return false;
  } finally {
    state.saving = false;
    if (state.dirty && !state.conflict) markDirty();
  }
}

async function loadDoc() {
  state.doc = null;
  state.conflict = false;
  if (!state.reviewer || !state.sessionId) {
    render();
    return;
  }
  const response = await fetch(`/api/sessions/${state.sessionId}/reviews/${encodeURIComponent(state.reviewer)}`);
  if (response.status === 404) state.doc = emptyDoc();
  else if (response.ok) state.doc = await response.json();
  else {
    setStatus(`評価を読めません: ${response.status}`, true);
    state.doc = null;
  }
  render();
}

function itemOf(key) {
  return state.session?.items.find((i) => i.key === key) ?? null;
}

function reviewOf(key) {
  return state.doc?.items[key] ?? null;
}

function isBlank(review) {
  return review.content === null && review.timing === null && review.wait_withdraw === null && review.notes.trim() === '';
}

function updateReview(item, patch) {
  if (!state.doc) return;
  const current = reviewOf(item.key) ?? { content: null, timing: null, wait_withdraw: null, notes: '' };
  const next = {
    ...current,
    ...patch,
    updated_at: nowIso(),
    snapshot: { kind: item.kind, t_ms: item.t_ms, headline: item.headline, prompt_versions: item.prompt_versions, conversation_type: item.conversation_type },
  };
  if (isBlank(next)) delete state.doc.items[item.key];
  else state.doc.items[item.key] = next;
  markDirty();
  renderList();
}

// ---- 一覧 --------------------------------------------------------------------

function kindLabel(item) {
  return item.kind === 'candidate' ? '発話希望' : item.kind === 'none' ? '判定 NONE' : '棄却';
}

function reviewMarks(key, axes) {
  const review = reviewOf(key);
  if (!review) return '';
  const done = axes.filter((axis) => review[axis] !== null).length;
  return done === axes.length ? '評価済' : done > 0 || review.notes ? '途中' : '';
}

function listEntries() {
  if (!state.session) return [];
  const unrated = document.getElementById('unrated').checked;
  const items = state.session.items
    .filter((item) => !unrated || reviewMarks(item.key, item.rate_axes) !== '評価済')
    .map((item) => ({ type: 'item', t: item.t_ms, item }));
  const missed = (state.doc?.missed ?? []).map((mark) => ({ type: 'missed', t: mark.t_ms, mark }));
  return [...items, ...missed].sort((a, b) => a.t - b.t);
}

function renderList() {
  const list = document.getElementById('list');
  list.replaceChildren();
  const entries = listEntries();
  if (entries.length === 0) {
    list.append(el('p', { class: 'note', text: state.session ? '該当する判定はありません。' : 'セッションを選んでください。' }));
    return;
  }
  for (const entry of entries) {
    if (entry.type === 'item') {
      const { item } = entry;
      const marks = reviewMarks(item.key, item.rate_axes);
      const preview = item.decisions[0]?.content.find((f) => f.key === 'proposed_utterance')?.value ?? item.decisions[0]?.content.find((f) => f.key === 'reason')?.value ?? item.decisions[0]?.stable.text ?? '';
      list.append(
        el(
          'button',
          { class: `row ${state.selected === item.key ? 'selected' : ''}`, onclick: () => select(item.key) },
          el('span', { class: 'top' }, el('span', { text: fmtT(item.t_ms) }), el('span', { class: 'kind', text: kindLabel(item) }), item.kind === 'none' ? null : el('span', { class: 'headline', text: item.headline }), marks ? el('span', { class: 'marks', text: marks }) : null),
          el('span', { class: 'body', text: preview }),
        ),
      );
    } else {
      const { mark } = entry;
      list.append(
        el(
          'button',
          { class: `row missed ${state.selected === `m:${mark.id}` ? 'selected' : ''}`, onclick: () => select(`m:${mark.id}`) },
          el('span', { class: 'top' }, el('span', { text: fmtT(mark.t_ms) }), el('span', { class: 'kind', text: '見逃しの印' })),
          el('span', { class: 'body', text: mark.content }),
        ),
      );
    }
  }
}

function select(key) {
  state.selected = key;
  state.draftMissed = null;
  state.showAll = false;
  render();
}

// ---- 詳細 --------------------------------------------------------------------

function badge(provenance, method) {
  return el('span', { class: `badge ${provenance}`, title: method ?? '', text: PROVENANCE_LABEL[provenance] ?? provenance });
}

function fieldTable(fields, emptyText) {
  if (fields.length === 0) return el('p', { class: 'note', text: emptyText });
  return el(
    'table',
    {},
    fields.map((field) =>
      el(
        'tr',
        {},
        el('th', { text: field.label }),
        el('td', {}, field.value === null ? el('span', { class: 'absent', text: `なし（${field.null_reason ?? '記録なし'}）` }) : field.value, badge(field.provenance, field.method)),
      ),
    ),
  );
}

function stableBlock(step) {
  const evidence = step.content.find((f) => f.key === 'evidence_span')?.value ?? null;
  const text = step.stable.text;
  const box = el('div', { class: 'asr' });
  if (text === '') {
    box.textContent = '（この時点の安定した ASR の文字は記録にありません）';
    return box;
  }
  const at = evidence ? text.indexOf(evidence) : -1;
  if (at < 0) box.textContent = text;
  else box.append(text.slice(0, at), el('mark', { text: evidence }), text.slice(at + evidence.length));
  return box;
}

function stepCard(step, index, item) {
  return el(
    'div',
    { class: 'panel' },
    el(
      'h4',
      {},
      `${item.decisions.length > 1 ? `${index + 1}. ` : ''}判定 ${step.decision}`,
      badge('model_output'),
      el('span', { class: 'meta', text: `　届いた ${fmtT(step.t_ms)} ／ 送信 ${fmtT(step.sent_at)} ／ 版 ${step.prompt_version ?? item.prompt_versions.join(', ')}` }),
    ),
    el('h4', { text: `そのときの安定した ASR の文字（改訂 ${step.stable.transcript_revision ?? '—'}、記録から再構成）` }),
    stableBlock(step),
    el('h4', { text: '発話希望の内容と根拠' }),
    fieldTable(step.content, '内容の項目はありません。'),
    el('h4', { text: 'タイミングの判断と理由' }),
    fieldTable(step.timing, 'タイミングの項目はありません。'),
    step.llm_input || step.llm_output
      ? el(
          'details',
          {},
          el('summary', { text: 'LLM の入力と出力の原文（llm.request／llm.response）' }),
          step.llm_input ? el('pre', { text: step.llm_input }) : null,
          step.llm_output ? el('pre', { text: step.llm_output }) : null,
        )
      : null,
  );
}

function timelineTable(item) {
  if (item.timeline.length === 0) return el('p', { class: 'note', text: '遷移の記録はありません。' });
  return el(
    'table',
    {},
    item.timeline.map((row) =>
      el('tr', {}, el('th', { text: fmtT(row.t_ms) }), el('td', {}, row.label, badge(row.provenance), row.detail ? el('div', { class: 'meta', text: row.detail }) : null)),
    ),
  );
}

// その発話の結果（turn.outcome）。ラベルは音声と ASR からの機械的な推定で、確定した失敗ではない。
function outcomeBlock(outcome) {
  if (!outcome) return null;
  const label = outcome.labels === null ? `分類なし（${outcome.null_reason ?? '理由なし'}）` : outcome.labels.length === 0 ? 'ラベルなし' : outcome.labels.join('、');
  return el(
    'div',
    { class: 'meta' },
    el('b', { text: `結果（観測に基づく推定）: ${label}` }),
    ...outcome.fields.map((f) => el('div', { text: `${f.label}: ${f.value}` })),
  );
}

function actualBlock(item) {
  if (item.kind !== 'candidate') return el('p', { class: 'note', text: '候補にならなかった判定なので、吸気も発話もありません。' });
  const rows = [
    ...item.inhale.map((s) => el('tr', {}, el('th', { text: `合図 ${s.phase}` }), el('td', { text: `送信 ${fmtT(s.sent_at)} ／ 描画開始 ${fmtT(s.started_at)} ／ 終了 ${fmtT(s.ended_at)}${s.visible === false ? '（描画なし）' : ''}` }))),
    ...item.speech.map((s) => el('tr', {}, el('th', { text: '発話' }), el('td', {}, `開始 ${fmtT(s.started_at)} ／ 終了 ${fmtT(s.ended_at)}`, el('div', { class: 'meta', text: s.spoken_text ?? '（発話文の記録なし）' }), outcomeBlock(s.outcome)))),
  ];
  return rows.length === 0 ? el('p', { class: 'note', text: '吸気も発話も起きていません。' }) : el('table', {}, rows);
}

function lineRow(line) {
  const missed = (state.doc?.missed ?? []).some((m) => m.anchor_line_id === line.id);
  return el(
    'div',
    { class: `line ${line.role} ${line.final ? '' : 'interim'}` },
    el('span', { class: 't', text: fmtT(line.t_ms) }),
    el('span', { class: 'who', text: line.role === 'user' ? '人' : 'AI' }),
    el('span', { class: 'txt' }, line.text, line.final ? '' : ' （未確定）', line.origin === 'candidate' ? el('span', { class: 'badge code', text: '発話希望の発話' }) : null),
    el('button', { class: 'linebtn', disabled: !state.doc, onclick: () => startMissedFromLine(line), text: missed ? '印あり・追加' : '＋ 見逃しの印' }),
  );
}

function conversationBlock(item) {
  const lines = state.session.lines;
  const byId = new Map(lines.map((l) => [l.id, l]));
  const box = el('div', { class: 'conv' });
  const shownBefore = state.showAll ? lines.filter((l) => l.t_ms <= item.anchor_t_ms) : item.context_before.map((id) => byId.get(id)).filter(Boolean);
  const shownAfter = state.showAll ? lines.filter((l) => l.t_ms > item.anchor_t_ms) : item.context_after.map((id) => byId.get(id)).filter(Boolean);
  for (const line of shownBefore) box.append(lineRow(line));
  box.append(el('div', { class: 'anchor', text: `↑ ${fmtT(item.anchor_t_ms)} この判定の入力の時点 ↓` }));
  for (const line of shownAfter) box.append(lineRow(line));
  return el(
    'div',
    {},
    box,
    el('button', {
      class: 'linebtn',
      text: state.showAll ? '前後だけ表示' : '会話をすべて表示',
      onclick: () => {
        state.showAll = !state.showAll;
        renderDetail();
      },
    }),
  );
}

function audioBlock(tMs, audioSec) {
  const files = state.session.meta.audio_files;
  if (files.length === 0) return el('p', { class: 'note', text: 'このセッションには音声ファイルがありません（セッションのフォルダに .wav などを置くと再生できます）。' });
  const player = el('audio', { controls: true, preload: 'metadata', src: `/api/sessions/${state.sessionId}/audio/${encodeURIComponent(files[0])}` });
  const fileSelect = files.length > 1 ? el('select', { onchange: (e) => (player.src = `/api/sessions/${state.sessionId}/audio/${encodeURIComponent(e.target.value)}`) }, files.map((f) => el('option', { value: f, text: f }))) : null;
  const preroll = el('select', {}, [0, 3, 5, 10].map((n) => el('option', { value: n, selected: n === 3, text: `${n}秒前から` })));
  const play = () => {
    if (audioSec === null) return;
    const seek = () => {
      player.currentTime = Math.max(0, audioSec - Number(preroll.value));
      void player.play();
    };
    if (player.readyState >= 1) seek();
    else player.addEventListener('loadedmetadata', seek, { once: true });
  };
  const row = el(
    'div',
    { class: 'audio-row' },
    player,
    fileSelect,
    preroll,
    el('button', { class: 'primary', disabled: audioSec === null, onclick: play, text: `${fmtT(tMs)} の時点を再生` }),
    audioSec === null ? el('span', { class: 'note', text: '音声枠と時刻の対応が記録にありません。' }) : null,
  );
  // 保存した音声（2ch の WAV と同期ファイル）なら、同じ時間軸に波形と合図、発話、判定の時刻を並べる。
  if (audioSec === null || files[0] !== 'session_audio.wav') return row;
  const timeline = el('div', { class: 'audio-timeline-host' });
  void renderAudioTimeline(timeline, { sessionId: state.sessionId, player, centerSec: audioSec, fmtT });
  return el('div', {}, row, timeline);
}

function renderDetail() {
  const detail = document.getElementById('detail');
  detail.replaceChildren();
  if (state.session?.warnings.length) detail.append(el('div', { class: 'warn', text: state.session.warnings.join(' ') }));
  const key = state.selected;
  if (key?.startsWith('m:')) {
    const mark = state.doc?.missed.find((m) => m.id === key.slice(2));
    if (!mark) return;
    appendAll(detail, el('h2', { text: `見逃しの印 ${fmtT(mark.t_ms)}` }), el('p', { class: 'note', text: '研究者が付けた印です。' }));
    const fake = { anchor_t_ms: mark.t_ms, context_before: nearbyLines(mark.t_ms, 6, 0), context_after: nearbyLines(mark.t_ms, 0, 4) };
    appendAll(detail, audioBlock(mark.t_ms, audioSecFor(mark.t_ms)), el('h3', { text: '前後の会話' }), conversationBlock(fake));
    return;
  }
  const item = key ? itemOf(key) : null;
  if (!item) {
    detail.append(el('p', { class: 'note', text: '一覧から判定を選んでください。' }));
    return;
  }
  appendAll(
    detail,
    el('h2', { text: item.kind === 'none' ? kindLabel(item) : `${kindLabel(item)}：${item.headline}` }),
    el('div', { class: 'meta', text: `時刻 ${fmtT(item.t_ms)} ／ 条件 ${item.condition ?? '—'} ／ 会話の種類 ${item.conversation_type} ／ 版 ${item.prompt_versions.join(', ')}${item.candidate_id ? ` ／ 候補 ${item.candidate_id}` : ''}` }),
    el('h3', { text: '音声' }),
    audioBlock(item.anchor_t_ms, item.audio_sec),
    el('h3', { text: '判定の内容' }),
    ...item.decisions.map((step, index) => stepCard(step, index, item)),
    el('h3', { text: '遷移（候補の状態の遷移、交渉、合図、棄却）' }),
    el('div', { class: 'panel' }, timelineTable(item)),
    el('h3', { text: '実際に吸気や発話が起きた時刻' }),
    el('div', { class: 'panel' }, actualBlock(item)),
    el('h3', { text: '前後の会話（人の行は ASR、AI の行は実際に声になった部分）' }),
    el('div', { class: 'panel' }, conversationBlock(item)),
  );
}

function nearbyLines(t, before, after) {
  const lines = state.session.lines;
  return [...lines.filter((l) => l.t_ms <= t).slice(-before), ...lines.filter((l) => l.t_ms > t).slice(0, after)].map((l) => l.id);
}

function audioSecFor(tMs) {
  // 印の時刻に最も近い会話の行の秒位置から、差分だけ進める（音声枠と時刻の対応はサーバが行ごとに計算済み）。
  let best = null;
  for (const line of state.session.lines) {
    if (line.audio_sec === null) continue;
    if (best === null || Math.abs(line.t_ms - tMs) < Math.abs(best.t_ms - tMs)) best = line;
  }
  return best === null ? null : Math.max(0, best.audio_sec + (tMs - best.t_ms) / 1000);
}

// ---- 評価欄 ------------------------------------------------------------------

function axisField(item, axis, review, disabled) {
  const def = AXES[axis];
  const legend = axis === 'content' && item.kind === 'none' ? def.noneLegend : def.legend;
  const name = `axis-${axis}`;
  return el(
    'fieldset',
    {},
    el('legend', { text: legend }),
    def.options.map(([value, label]) => {
      const input = el('input', { type: 'radio', name, value, checked: review?.[axis] === value, disabled });
      input.addEventListener('click', () => {
        // 選択済みをもう一度押すと取り消す。
        const clearing = reviewOf(item.key)?.[axis] === value;
        if (clearing) input.checked = false;
        updateReview(item, { [axis]: clearing ? null : value });
      });
      return el('label', { class: 'radio' }, input, ` ${label}`);
    }),
  );
}

function missedDraftForm(disabled) {
  const draft = state.draftMissed;
  return el(
    'div',
    { class: 'panel' },
    el('h4', { text: `見逃しの印（${fmtT(draft.t_ms)}）` }),
    el('label', { text: 'ここで言いたかった内容（必須）' }),
    el('textarea', { id: 'missed-content', disabled, oninput: (e) => (draft.content = e.target.value) }, draft.content),
    el('label', { text: 'いつ言うべきだったか（任意）' }),
    el('textarea', { disabled, style: 'min-height:40px', oninput: (e) => (draft.timing_note = e.target.value) }, draft.timing_note),
    el('div', { class: 'audio-row' },
      el('button', { class: 'primary', disabled, onclick: commitDraft, text: '印を保存' }),
      el('button', { onclick: () => { state.draftMissed = null; renderForm(); }, text: 'やめる' }),
    ),
  );
}

function commitDraft() {
  const draft = state.draftMissed;
  if (!draft || !state.doc) return;
  if (draft.content.trim() === '') {
    setStatus('言いたかった内容を書いてください', true);
    return;
  }
  const now = nowIso();
  const mark = {
    id: draft.id ?? `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    t_ms: draft.t_ms,
    anchor_item_key: draft.anchor_item_key,
    anchor_line_id: draft.anchor_line_id,
    content: draft.content,
    timing_note: draft.timing_note,
    created_at: draft.created_at ?? now,
    updated_at: now,
  };
  const index = state.doc.missed.findIndex((m) => m.id === mark.id);
  if (index >= 0) state.doc.missed[index] = mark;
  else state.doc.missed.push(mark);
  state.doc.missed.sort((a, b) => a.t_ms - b.t_ms);
  state.draftMissed = null;
  markDirty();
  state.selected = `m:${mark.id}`;
  render();
}

function startMissedFromItem(item) {
  state.draftMissed = { t_ms: item.anchor_t_ms, anchor_item_key: item.key, anchor_line_id: null, content: '', timing_note: '' };
  renderForm();
  document.getElementById('missed-content')?.focus();
}

function startMissedFromLine(line) {
  const anchor = state.selected && !state.selected.startsWith('m:') ? state.selected : null;
  state.draftMissed = { t_ms: line.t_ms, anchor_item_key: anchor, anchor_line_id: line.id, content: '', timing_note: '' };
  renderForm();
  document.getElementById('missed-content')?.focus();
}

function renderForm() {
  const form = document.getElementById('form');
  form.replaceChildren();
  const disabled = state.doc === null;
  if (disabled) form.append(el('p', { class: 'warn', text: '評価者の名前を入れると評価できます。' }));
  if (state.draftMissed) {
    form.append(missedDraftForm(disabled));
    return;
  }
  const key = state.selected;
  if (key?.startsWith('m:')) {
    const mark = state.doc?.missed.find((m) => m.id === key.slice(2));
    if (!mark) return;
    appendAll(
      form,
      el('h4', { text: `見逃しの印 ${fmtT(mark.t_ms)}` }),
      el('p', { class: 'note', text: `言いたかった内容: ${mark.content}` }),
      mark.timing_note ? el('p', { class: 'note', text: `いつ: ${mark.timing_note}` }) : null,
      el('div', { class: 'audio-row' },
        el('button', {
          onclick: () => {
            state.draftMissed = { ...mark };
            renderForm();
          },
          text: '直す',
        }),
        el('button', {
          class: 'danger',
          onclick: () => {
            state.doc.missed = state.doc.missed.filter((m) => m.id !== mark.id);
            state.selected = null;
            markDirty();
            render();
          },
          text: '印を消す',
        }),
      ),
    );
    return;
  }
  const item = key ? itemOf(key) : null;
  if (!item) return;
  const review = reviewOf(item.key);
  appendAll(
    form,
    el('h3', { text: '評価' }),
    el('p', { class: 'note', text: '3つの軸は別々に評価してください。LLM の理由の文のもっともらしさではなく、音声と会話の流れで判断してください。' }),
    ...item.rate_axes.map((axis) => axisField(item, axis, review, disabled)),
    el('fieldset', {}, el('legend', { text: '④ 自由記述' }), el('textarea', { disabled, oninput: (e) => updateReview(item, { notes: e.target.value }) }, review?.notes ?? '')),
    item.kind === 'none' || item.kind === 'dropped'
      ? el('button', { class: 'primary', disabled, onclick: () => startMissedFromItem(item), text: 'ここで言いたいことがあったはず（見逃しの印）' })
      : null,
  );
}

function render() {
  renderList();
  renderDetail();
  renderForm();
}

// ---- セッションと絞り込み ------------------------------------------------------

function filterQuery() {
  const params = new URLSearchParams();
  const conversation = document.getElementById('f-conversation').value;
  const prompt = document.getElementById('f-prompt').value;
  if (conversation) params.set('conversation_type', conversation);
  if (prompt) params.set('prompt_version', prompt);
  const text = params.toString();
  return text ? `?${text}` : '';
}

async function refreshSessions() {
  const data = await getJson(`/api/sessions${filterQuery()}`);
  state.sessions = data.sessions;
  fillSelect('f-conversation', ['', ...data.options.conversation_types], (v) => v || '（すべて）');
  fillSelect('f-prompt', ['', ...data.options.prompt_versions], (v) => v || '（すべて）');
  const select = document.getElementById('session');
  select.replaceChildren(...state.sessions.map((s) => el('option', { value: s.session_id, text: `${s.session_id}（${s.conversation_type}）` })));
  const keep = state.sessions.some((s) => s.session_id === state.sessionId);
  if (keep) select.value = state.sessionId;
  else if (state.sessions[0]) select.value = state.sessions[0].session_id;
  await loadSelectedSession();
}

function fillSelect(id, values, label) {
  const node = document.getElementById(id);
  const previous = node.value;
  node.replaceChildren(...values.map((v) => el('option', { value: v, text: label(v) })));
  if (values.includes(previous)) node.value = previous;
}

async function loadSelectedSession() {
  await save();
  const id = document.getElementById('session').value;
  state.selected = null;
  state.draftMissed = null;
  if (!id) {
    state.session = null;
    state.sessionId = null;
    state.doc = null;
    render();
    return;
  }
  state.sessionId = id;
  state.session = await getJson(`/api/sessions/${id}${filterQuery()}`);
  const names = await getJson(`/api/sessions/${id}/reviewers`);
  document.getElementById('reviewer-names').replaceChildren(...names.map((n) => el('option', { value: n })));
  await loadDoc();
}

async function main() {
  const reviewer = document.getElementById('reviewer');
  reviewer.value = stored('initiative_review.reviewer') ?? '';
  state.reviewer = reviewer.value.trim();
  reviewer.addEventListener('change', async () => {
    await save();
    state.reviewer = reviewer.value.normalize('NFC').trim();
    store('initiative_review.reviewer', state.reviewer);
    await loadDoc();
  });
  document.getElementById('session').addEventListener('change', () => void loadSelectedSession());
  document.getElementById('f-conversation').addEventListener('change', () => void refreshSessions());
  document.getElementById('f-prompt').addEventListener('change', () => void refreshSessions());
  document.getElementById('unrated').addEventListener('change', renderList);
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) e.preventDefault();
  });
  await refreshSessions();
}

void main().catch((error) => setStatus(`読み込めません: ${error.message}`, true));
