const $ = (id) => document.getElementById(id);
const ui = {
  presence: $('presence'), modelStatus: $('modelStatus'), serverDot: $('serverDot'),
  avatarState: $('avatarState'), soundBars: $('soundBars'), micBtn: $('micBtn'),
  micLabel: $('micLabel'), micIcon: $('micIcon'), yieldBtn: $('yieldBtn'),
  waitBtn: $('waitBtn'), stopBtn: $('stopBtn'), scenario: $('scenario'),
  autoSpeak: $('autoSpeak'), soundOn: $('soundOn'), debugToggle: $('debugToggle'), initiative: $('initiative'),
  debugPanel: $('debugPanel'), decisionView: $('decisionView'), utteranceView: $('utteranceView'),
  modeLlm: $('modeLlm'), modeManual: $('modeManual'), modeHint: $('modeHint'),
  audioStatus: $('audioStatus'), transcriptText: $('transcriptText'), interimText: $('interimText'),
  textInput: $('textInput'), textAnalyzeBtn: $('textAnalyzeBtn'), eventLog: $('eventLog'),
  exportBtn: $('exportBtn'), elapsed: $('elapsed')
};

const D = {
  ready: false, model: '—', mode: 'llm', state: 'idle', currentIntent: null,
  inhaleTimer: null, cueSince: 0, startedAt: Date.now(),
  micWanted: false, recognizer: null, recognizerActive: false,
  sessionBase: '', committed: '', interim: '',
  lastHumanVoiceAt: 0, everHeardVoice: false, micStream: null, audioContext: null,
  analyser: null, samples: null, vadFrame: null,
  lastAnalysisAt: 0, lastAnalyzedText: '', analyzing: false, lastDecision: null,
  history: [], events: [], playbackTimeout: null, endCueTime: 0
};
const STATE = {
  idle: 'あなたの話を聴いています', inhaling: '発話の準備をしています',
  intent: '発話の機会をうかがっています', speaking: '話しています',
  holding: '発話を待っています', withdrawn: '聞くことに戻りました'
};
const now = () => Date.now();
function log(action, note = '', extra = {}) {
  const ev = { timestamp: new Date().toISOString(), elapsed_ms: now() - D.startedAt, action, note, ...extra };
  D.events.push(ev);
  const item = document.createElement('div'); item.className = 'log-item';
  const at = document.createElement('span'); at.className = 'log-time';
  at.textContent = new Date(ev.timestamp).toLocaleTimeString('ja-JP', { hour12: false });
  const msg = document.createElement('span');
  const strong = document.createElement('strong'); strong.textContent = action;
  msg.append(strong, document.createTextNode(note ? ` · ${note}` : ''));
  item.append(at, msg);
  if (ui.eventLog.querySelector('.log-empty')) ui.eventLog.replaceChildren();
  ui.eventLog.prepend(item);
  while (ui.eventLog.childElementCount > 18) ui.eventLog.lastElementChild.remove();
}
function setState(next) {
  D.state = next;
  ui.presence.dataset.state = next;
  ui.presence.setAttribute('aria-label', `AIアバター。${STATE[next] || next}`);
  ui.avatarState.textContent = next === 'speaking' ? '話しています' : '対話中';
  const canInteract = Boolean(D.currentIntent) && ['inhaling','intent','holding'].includes(next);
  ui.yieldBtn.disabled = !canInteract;
  ui.waitBtn.disabled = !canInteract;
  ui.soundBars.classList.toggle('active', next === 'speaking');
}
function setStatus(text) { ui.audioStatus.textContent = text; }
function renderMode() {
  ui.modeLlm.classList.toggle('active', D.mode === 'llm');
  ui.modeManual.classList.toggle('active', D.mode === 'manual');
  ui.modeHint.textContent = D.mode === 'llm'
    ? D.ready ? '文字起こしを読みながら、LLM自身が発話希望を判断します。'
      : 'APIキー未設定です。手動デモは利用できます。'
    : '実験者が合図を出すWizard-of-Oz方式です。';
}
function updateDebug(answer) {
  ui.decisionView.textContent = answer
    ? `${answer.want_to_speak ? '発話希望あり' : 'まだ待つ'}  /  ${answer.intent_type || '—'}\n${answer.reason || ''}`
    : '判定前';
  ui.utteranceView.textContent = answer?.utterance || '—';
}
function transcript() { return `${D.committed} ${D.interim}`.trim(); }
function renderTranscript() {
  if (D.committed) {
    ui.transcriptText.classList.remove('placeholder');
    ui.transcriptText.textContent = D.committed;
  } else {
    ui.transcriptText.classList.add('placeholder');
    ui.transcriptText.textContent = '例えば「今考えている研究アイデアは…」と、30秒ほど続けて説明してみてください。';
  }
  ui.interimText.textContent = D.interim ? ` ${D.interim}` : '';
  ui.elapsed.textContent = formatClock(now() - D.startedAt);
}
function formatClock(ms) {
  const sec = Math.floor(ms / 1000);
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function cue(payload, source = 'manual') {
  if (D.state === 'speaking') return;
  if (D.inhaleTimer) clearTimeout(D.inhaleTimer);
  D.currentIntent = {
    ...payload,
    utterance: String(payload?.utterance || '少し聞いてもいいですか？').trim(),
    reason: String(payload?.reason || '').trim(),
    source, bornAt: now(), cueAfterTranscript: transcript()
  };
  D.cueSince = now();
  setState('inhaling');
  log('inhale_onset', `${source}：発話希望を身体的に提示`, { intent: D.currentIntent.utterance, reason: D.currentIntent.reason });
  setStatus('アバターの吸気モーションを再生しました。発話タイミングは人間の反応に応じて調整します。');
  D.inhaleTimer = setTimeout(() => {
    D.inhaleTimer = null;
    if (D.state === 'inhaling') {
      setState('intent');
      log('cue_hold', '吸気完了・発話機会を待つ');
    }
  }, 1300);
}
function pauseIntent(reason = '人間側が発話を継続') {
  if (!D.currentIntent || !['inhaling','intent'].includes(D.state)) return;
  if (D.inhaleTimer) clearTimeout(D.inhaleTimer);
  D.inhaleTimer = null;
  setState('holding');
  log('defer', reason);
  setStatus('発話希望を保持し、いったん合図を下げました。次の間を待っています。');
}
function withdraw(reason = '発話希望を撤回') {
  if (D.inhaleTimer) clearTimeout(D.inhaleTimer);
  D.inhaleTimer = null;
  if (D.state === 'speaking') stopSpeaking();
  if (D.currentIntent) log('withdraw', reason, { intent: D.currentIntent.utterance });
  D.currentIntent = null;
  D.endCueTime = now();
  setState('withdrawn');
  setStatus('AIは発話を撤回し、聞き手に戻りました。');
  setTimeout(() => { if (D.state === 'withdrawn') setState('idle'); }, 900);
}
function japaneseVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  return voices.find(v => v.lang === 'ja-JP' && /natural|nanami|google/i.test(v.name))
    || voices.find(v => v.lang.startsWith('ja')) || null;
}
function stopSpeaking() {
  if (D.playbackTimeout) clearTimeout(D.playbackTimeout);
  D.playbackTimeout = null;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}
function speak(trigger = 'consent') {
  if (!D.currentIntent || D.state === 'speaking') return;
  if (D.inhaleTimer) clearTimeout(D.inhaleTimer);
  D.inhaleTimer = null;
  const intent = D.currentIntent;
  D.currentIntent = null;
  D.endCueTime = now();
  setState('speaking');
  log('speak_onset', trigger, { utterance: intent.utterance, source: intent.source });
  D.history.push({ who: 'ai', text: intent.utterance });
  D.history = D.history.slice(-12);
  stopRecognitionForSpeech();
  setStatus(`AIの発話：${intent.utterance}`);
  function finished() {
    if (D.state !== 'speaking') return;
    log('speak_end', intent.utterance);
    setState('idle');
    setStatus('AIは聞き手に戻りました。あなたの説明を続けてください。');
    if (D.micWanted) setTimeout(() => startRecognition(), 700);
  }
  if (ui.soundOn.checked && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(intent.utterance);
    utter.lang = 'ja-JP'; utter.rate = 1.06; utter.pitch = 1.05;
    const voice = japaneseVoice(); if (voice) utter.voice = voice;
    utter.onend = finished; utter.onerror = finished;
    window.speechSynthesis.speak(utter);
    // Browsers may fail to emit completion callbacks; keep a bound for an experiment.
    D.playbackTimeout = setTimeout(finished, Math.max(4500, intent.utterance.length * 390));
  } else {
    D.playbackTimeout = setTimeout(finished, Math.max(1800, intent.utterance.length * 75));
  }
}

async function analyzeText(source, force = false) {
  if (D.mode !== 'llm' || !D.ready || D.analyzing || D.currentIntent || ['inhaling','intent','speaking','holding'].includes(D.state)) return;
  const text = (source || transcript()).trim();
  const difference = text.length - D.lastAnalyzedText.length;
  if (text.length < (force ? 8 : 28)) return;
  if (!force && (difference < 18 || now() - D.lastAnalysisAt < 4000 || now() - D.endCueTime < 4500)) return;
  D.analyzing = true;
  D.lastAnalyzedText = text;
  D.lastAnalysisAt = now();
  log('llm_check', `文字起こし ${text.length} 字`);
  if (D.state === 'idle') setStatus('LLMが会話内容を読み、発話したい理由があるか判断しています…');
  ui.textAnalyzeBtn.disabled = true;
  try {
    const resp = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: text, scenario: ui.scenario.value, initiative: ui.initiative.value, history: D.history })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    D.lastDecision = data; updateDebug(data);
    log('llm_decision', `${data.want_to_speak ? '発話したい' : 'まだ待つ'}：${data.intent_type}`, { reason: data.reason, proposed_utterance: data.utterance });
    if (data.want_to_speak && D.state === 'idle' && D.mode === 'llm') {
      cue(data, 'llm');
    } else if (D.state === 'idle') {
      setStatus('LLMはまだ発言せず、あなたの説明を聞き続けることを選びました。');
    }
  } catch (error) {
    log('llm_error', String(error.message || error));
    setStatus(`LLM判定エラー：${error.message || error}`);
  } finally {
    D.analyzing = false;
    ui.textAnalyzeBtn.disabled = false;
  }
}
let analysisTimeout = null;
function scheduleAnalysis() {
  if (D.mode !== 'llm' || !D.ready) return;
  if (analysisTimeout) clearTimeout(analysisTimeout);
  analysisTimeout = setTimeout(() => analyzeText(transcript()), 1200);
}
function setupRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return false;
  const rec = new Recognition();
  rec.lang = 'ja-JP'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
  rec.onstart = () => { D.recognizerActive = true; D.sessionBase = D.committed; log('speech_recognition_start'); };
  rec.onresult = (event) => {
    let finalPart = '', interimPart = '';
    for (const result of event.results) {
      const segment = result[0]?.transcript || '';
      if (result.isFinal) finalPart += segment;
      else interimPart += segment;
    }
    D.committed = D.sessionBase + (finalPart ? (D.sessionBase ? ' ' : '') + finalPart : '');
    D.interim = interimPart;
    if (finalPart || interimPart) {
      D.everHeardVoice = true;
      D.lastHumanVoiceAt = now();
      scheduleAnalysis();
    }
    renderTranscript();
  };
  rec.onerror = (event) => {
    log('speech_recognition_error', event.error || 'unknown');
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      D.micWanted = false;
      ui.micLabel.textContent = 'マイクを開始';
      setStatus('音声認識の許可がありません。テキスト入力で試してください。');
    }
  };
  rec.onend = () => {
    D.recognizerActive = false;
    D.interim = '';
    renderTranscript();
    if (D.micWanted && D.state !== 'speaking') {
      setTimeout(() => { if (D.micWanted && D.state !== 'speaking' && !D.recognizerActive) startRecognition(); }, 480);
    }
  };
  D.recognizer = rec;
  return true;
}
function startRecognition() {
  if (!D.micWanted || !D.recognizer || D.recognizerActive || D.state === 'speaking') return;
  D.sessionBase = D.committed;
  try { D.recognizer.start(); } catch { /* recognizer may still be shutting down */ }
}
function stopRecognitionForSpeech() {
  if (D.recognizer && D.recognizerActive) {
    try { D.recognizer.stop(); } catch {}
  }
}
async function startMic() {
  if (D.micWanted) return stopMic();
  if (!setupRecognition()) {
    setStatus('このブラウザはSpeechRecognitionに未対応です。Chrome/Edgeをお試しください。');
    log('unsupported_browser', 'SpeechRecognition not available');
    return;
  }
  try {
    D.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  } catch (err) {
    log('microphone_error', err.message || String(err));
    setStatus('マイクを使用できません。ブラウザの許可を確認してください。');
    return;
  }
  D.micWanted = true;
  ui.micLabel.textContent = 'マイクを停止'; ui.micIcon.textContent = '■';
  D.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  try { await D.audioContext.resume(); } catch {}
  const source = D.audioContext.createMediaStreamSource(D.micStream);
  D.analyser = D.audioContext.createAnalyser(); D.analyser.fftSize = 1024;
  D.samples = new Float32Array(D.analyser.fftSize);
  source.connect(D.analyser);
  function updateAmplitude() {
    if (!D.micWanted || !D.analyser) return;
    D.analyser.getFloatTimeDomainData(D.samples);
    let sum = 0;
    for (const sample of D.samples) sum += sample * sample;
    const rms = Math.sqrt(sum / D.samples.length);
    if (rms > 0.025 && D.state !== 'speaking') {
      D.lastHumanVoiceAt = now(); D.everHeardVoice = true;
    }
    if (D.state !== 'speaking') {
      const bars = [...ui.soundBars.children];
      bars.forEach((el, index) => {
        const height = Math.min(24, Math.max(4, (rms * 280 + Math.sin(now() / 170 + index) * 3) * (0.55 + index % 3 * .2)));
        el.style.height = `${height.toFixed(1)}px`;
        el.style.opacity = String(Math.min(.95, .3 + rms * 14));
      });
    }
    D.vadFrame = requestAnimationFrame(updateAmplitude);
  }
  updateAmplitude(); startRecognition();
  log('mic_start', 'Web Speech API + 音量RMSによる簡易検出');
  setStatus('マイクを聴取中です。少し長めに話し続けてください。');
}
async function stopMic() {
  D.micWanted = false;
  if (D.recognizer) { try { D.recognizer.stop(); } catch {} }
  D.recognizerActive = false;
  if (D.vadFrame) cancelAnimationFrame(D.vadFrame);
  if (D.micStream) D.micStream.getTracks().forEach(track => track.stop());
  D.micStream = null;
  if (D.audioContext) await D.audioContext.close().catch(() => {});
  D.audioContext = null;
  ui.micLabel.textContent = 'マイクを開始'; ui.micIcon.textContent = '◉';
  for (const el of ui.soundBars.children) el.style.height = '4px';
  log('mic_stop');
  setStatus('マイクを停止しました。');
}
function resetAll() {
  if (analysisTimeout) clearTimeout(analysisTimeout);
  if (D.inhaleTimer) clearTimeout(D.inhaleTimer);
  stopSpeaking();
  stopMic();
  D.currentIntent = null; D.lastDecision = null; D.lastAnalyzedText = ''; D.lastAnalysisAt = 0;
  D.history = []; D.committed = ''; D.interim = ''; D.sessionBase = '';
  D.everHeardVoice = false; D.lastHumanVoiceAt = 0; D.endCueTime = 0;
  D.events = []; D.startedAt = now(); ui.eventLog.replaceChildren();
  const empty = document.createElement('div'); empty.className = 'log-empty'; empty.textContent = 'イベントがここに記録されます。'; ui.eventLog.append(empty);
  setState('idle'); updateDebug(null); renderTranscript();
  setStatus('リセットしました。マイクを開始するか、実験者コントローラーを使ってください。');
  log('reset');
}
async function handleOperatorCommand(message) {
  if (!message || !message.action) return;
  switch (message.action) {
    case 'cue': cue({ utterance: message.utterance || '今の話について、一つ聞いてもいいですか？', reason: '実験者操作による合図' }, 'operator'); break;
    case 'speak':
      if (!D.currentIntent) cue({ utterance: message.utterance || '一つ聞いてもいいですか？' }, 'operator');
      if (message.utterance && D.currentIntent) D.currentIntent.utterance = message.utterance;
      speak('operator'); break;
    case 'defer': pauseIntent('実験者操作による延期'); break;
    case 'withdraw': withdraw('実験者操作による撤回'); break;
    case 'reset': resetAll(); break;
  }
}
function connectOperator() {
  if (!window.EventSource) return;
  const es = new EventSource('/events');
  es.addEventListener('command', event => {
    try { handleOperatorCommand(JSON.parse(event.data)); }
    catch (error) { console.warn('Operator command error', error); }
  });
}
function downloadLog() {
  const record = {
    title: 'BREATH speech-intention research demo',
    version: '0.1.0',
    createdAt: new Date().toISOString(),
    mode: D.mode, model: D.model, scenario: ui.scenario.value, initiative: ui.initiative.value,
    note: 'SpeechRecognition and RMS VAD are browser-based; this demo does not use MaAI.',
    events: D.events,
    transcript: transcript(),
    history: D.history
  };
  const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = objectUrl;
  a.download = `breath-session-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
  log('export', 'イベントログを保存');
}
function tick() {
  ui.elapsed.textContent = formatClock(now() - D.startedAt);
  const secondsFromSpeech = now() - D.lastHumanVoiceAt;
  const cueAge = now() - D.cueSince;
  if (!D.currentIntent) return;
  if (D.micWanted && D.everHeardVoice && ['intent','holding'].includes(D.state)) {
    if (D.state === 'intent' && secondsFromSpeech < 550 && cueAge > 8500) {
      pauseIntent('人間が話し続けたため合図を下げる');
    }
    if (ui.autoSpeak.checked && secondsFromSpeech > 1700 && cueAge > 1750 && cueAge < 70000) {
      speak('silence_vad');
    }
  }
}

ui.micBtn.addEventListener('click', startMic);
ui.yieldBtn.addEventListener('click', () => speak('user_yield_button'));
ui.waitBtn.addEventListener('click', () => pauseIntent('人間が待つように指示'));
ui.stopBtn.addEventListener('click', resetAll);
ui.modeLlm.addEventListener('click', () => {
  D.mode = 'llm'; renderMode(); log('mode', 'llm');
  setStatus(D.ready ? 'LLM判定モードです。' : 'APIキーが未設定です。操作デモを選んでください。');
});
ui.modeManual.addEventListener('click', () => {
  D.mode = 'manual'; renderMode(); log('mode', 'manual');
  setStatus('操作デモモードです。別タブの実験者コントローラーから合図を出せます。');
});
ui.textAnalyzeBtn.addEventListener('click', () => {
  if (D.mode !== 'llm') { setStatus('先に「LLM 自発」モードを選択してください。'); return; }
  if (!D.ready) { setStatus('GEMINI_API_KEY が未設定です。.env に設定してください。'); return; }
  const text = ui.textInput.value.trim();
  if (!text) { setStatus('まずテキストを入力してください。'); return; }
  D.committed = text; D.interim = ''; renderTranscript();
  analyzeText(text, true);
});
ui.debugToggle.addEventListener('change', () => ui.debugPanel.classList.toggle('hidden', !ui.debugToggle.checked));
ui.exportBtn.addEventListener('click', downloadLog);
window.addEventListener('keydown', event => {
  if (event.target instanceof HTMLElement && ['TEXTAREA','INPUT','SELECT'].includes(event.target.tagName)) return;
  if (event.key === ' ' && D.currentIntent && ['intent','inhaling','holding'].includes(D.state)) {
    event.preventDefault(); speak('space_key');
  }
});

async function init() {
  if (new URLSearchParams(window.location.search).has('participant')) document.body.classList.add('participant-mode');
  try {
    const resp = await fetch('/api/status');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    D.ready = Boolean(data.llmReady); D.model = data.model;
    ui.modelStatus.textContent = D.ready ? `GEMINI · ${data.model}` : 'MANUAL READY · API未設定';
    ui.serverDot.classList.add('ready');
    if (!D.ready) D.mode = 'manual';
  } catch {
    D.ready = false; D.mode = 'manual';
    ui.modelStatus.textContent = 'サーバー未接続';
    setStatus('ローカルサーバーを起動してください。');
  }
  renderMode(); updateDebug(null); renderTranscript(); connectOperator();
  log('ready', D.ready ? `Gemini ${D.model}` : 'Manual mode');
  window.setInterval(tick, 250);
}
init();
