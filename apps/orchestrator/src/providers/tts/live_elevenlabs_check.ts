/**
 * ElevenLabs の multi-stream-input の実 API 確認。短い文のみ（合計 約 60 文字）。キーは環境変数から読み、表示しない。
 *   node --env-file=.env --import tsx apps/orchestrator/src/providers/tts/live_elevenlabs_check.ts --yes
 * 実装を通さず WS を直接話す。実装の前提（isFinal の出方、close_context 後の音声）を確かめるため。
 */
import WebSocket from 'ws';

if (!process.argv.includes('--yes')) {
  console.error('実 API を呼びます（文字数を消費）。実行するには --yes を付けてください。');
  process.exit(3);
}
const KEY = process.env.ELEVENLABS_API_KEY as string;
const VOICE = process.env.ELEVENLABS_VOICE_ID as string;
if (!KEY || !VOICE) {
  console.error('ELEVENLABS_API_KEY と ELEVENLABS_VOICE_ID が必要です');
  process.exit(2);
}
const scrub = (s: unknown) => String(s).split(KEY).join('<KEY>').split(VOICE).join('<VOICE>');
const report = (o: unknown) => console.log(scrub(JSON.stringify(o)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Opened {
  ws: WebSocket;
  messages: { at: number; m: Record<string, unknown> }[];
  closed: { code: number; reason: string; at: number } | null;
  rejected: number | null;
  region: string | null;
  connect_ms: number | null;
  error: string | null;
  t0: number;
}

function open(query: Record<string, string>, voice = VOICE, key = KEY): Promise<Opened> {
  const params = new URLSearchParams({
    model_id: 'eleven_flash_v2_5',
    auto_mode: 'true',
    sync_alignment: 'true',
    inactivity_timeout: '60',
    language_code: 'ja',
    ...query,
  });
  const t0 = performance.now();
  const ws = new WebSocket(`wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/multi-stream-input?${params}`, {
    headers: { 'xi-api-key': key },
  });
  const state: Opened = { ws, messages: [], closed: null, rejected: null, region: null, connect_ms: null, error: null, t0 };
  ws.on('message', (d) => {
    state.messages.push({ at: performance.now() - t0, m: JSON.parse(String(d)) as Record<string, unknown> });
  });
  ws.on('close', (code, reason) => {
    state.closed = { code, reason: String(reason), at: performance.now() - t0 };
  });
  ws.on('upgrade', (res) => {
    state.region = (res.headers['x-region'] as string) ?? null;
  });
  return new Promise((resolve) => {
    ws.once('open', () => {
      state.connect_ms = Math.round(performance.now() - t0);
      resolve(state);
    });
    ws.once('unexpected-response', async (_req, res) => {
      state.rejected = res.statusCode ?? null;
      let body = '';
      for await (const c of res) body += String(c);
      state.error = body.slice(0, 400);
      ws.terminate();
      resolve(state);
    });
    ws.on('error', (e) => {
      state.error ??= e.message;
      resolve(state);
    });
  });
}

const send = (s: Opened, m: Record<string, unknown>) => s.ws.send(JSON.stringify(m));

function audioStats(s: Opened, context: string, sampleRate: number) {
  const items = s.messages.filter((x) => x.m.contextId === context);
  const withAudio = items.filter((x) => x.m.audio);
  const bytes = withAudio.reduce((n, x) => n + Buffer.from(x.m.audio as string, 'base64').length, 0);
  return { items, withAudio, bytes, audio_ms: Math.round((bytes / 2 / sampleRate) * 1000) };
}

async function waitFor(test: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (test()) return true;
    await sleep(10);
  }
  return test();
}

function keysOf(m: Record<string, unknown>) {
  return Object.keys(m).map((k) => (m[k] === null ? `${k}=null` : k));
}

async function synth(label: string, format: string, rate: number, text: string, withBodyKey: boolean) {
  const s = await open({ output_format: format });
  if (s.rejected !== null || s.connect_ms === null) {
    report({ label, format, rejected: s.rejected, error: s.error, closed: s.closed });
    return;
  }
  const c = 'p1_g1';
  send(s, { context_id: c, text: ' ', ...(withBodyKey ? { xi_api_key: KEY } : {}) });
  await sleep(50);
  const sentAt = performance.now() - s.t0;
  send(s, { context_id: c, text });
  send(s, { context_id: c, flush: true });
  const gotAudio = await waitFor(() => audioStats(s, c, rate).withAudio.length > 0 || s.closed !== null, 8000);
  await waitFor(() => s.messages.some((x) => x.m.contextId === c && x.m.isFinal === true) || s.closed !== null, 5000);
  const finalAfterFlush = s.messages.some((x) => x.m.contextId === c && x.m.isFinal === true);
  const beforeClose = audioStats(s, c, rate);
  const closeAt = performance.now() - s.t0;
  if (!s.closed) send(s, { context_id: c, close_context: true });
  await waitFor(() => s.messages.some((x) => x.m.contextId === c && x.m.isFinal === true) || s.closed !== null, 3000);
  const stats = audioStats(s, c, rate);
  const finalMsg = s.messages.find((x) => x.m.contextId === c && x.m.isFinal === true);

  const aligned = stats.withAudio.map((x) => x.m.alignment as null | { chars: string[]; charStartTimesMs: number[]; charDurationsMs: number[] });
  const norm = stats.withAudio.map((x) => x.m.normalizedAlignment as null | { chars: string[]; charStartTimesMs: number[]; charDurationsMs: number[] });
  const present = aligned.filter(Boolean) as NonNullable<(typeof aligned)[number]>[];
  const presentNorm = norm.filter(Boolean) as NonNullable<(typeof norm)[number]>[];
  const pcmMs = stats.withAudio.map((x) => (Buffer.from(x.m.audio as string, 'base64').length / 2 / rate) * 1000);
  // chunk 相対なら、各 chunk の先頭の時刻は 0 付近で、PCM を累積した時刻と末尾が近い。
  let cumulative = 0;
  const conversion = stats.withAudio.map((x, i) => {
    const a = x.m.alignment as (typeof aligned)[number];
    const row = a
      ? {
          first_start: a.charStartTimesMs[0],
          last_end: (a.charStartTimesMs.at(-1) ?? 0) + (a.charDurationsMs.at(-1) ?? 0),
          pcm_ms: Math.round(pcmMs[i] as number),
          pcm_cum_before: Math.round(cumulative),
          n: a.chars.length,
        }
      : { pcm_ms: Math.round(pcmMs[i] as number), n: 0 };
    cumulative += pcmMs[i] as number;
    return row;
  });
  report({
    label,
    format,
    connect_ms: s.connect_ms,
    region: s.region,
    closed: s.closed,
    got_audio: gotAudio,
    first_audio_ms_from_text: stats.withAudio[0] ? Math.round((stats.withAudio[0].at as number) - sentAt) : null,
    last_audio_ms_from_text: stats.withAudio.at(-1) ? Math.round((stats.withAudio.at(-1)?.at as number) - sentAt) : null,
    chunks: stats.withAudio.length,
    audio_ms: stats.audio_ms,
    odd_byte_chunks: stats.withAudio.filter((x) => Buffer.from(x.m.audio as string, 'base64').length % 2 === 1).length,
    message_keys_first_audio: stats.withAudio[0] ? keysOf(stats.withAudio[0].m) : null,
    is_final_after_flush_only: finalAfterFlush,
    audio_ms_before_close: beforeClose.audio_ms,
    final_ms_after_close: finalMsg && !finalAfterFlush ? Math.round(finalMsg.at - closeAt) : null,
    final_message_keys: finalMsg ? keysOf(finalMsg.m) : null,
    alignment_chunks: present.length,
    alignment_joined: present.flatMap((a) => a.chars).join(''),
    alignment_matches_input: present.flatMap((a) => a.chars).join('').replace(/\s/g, '') === text.replace(/\s/g, ''),
    alignment_max_codepoints: Math.max(0, ...present.flatMap((a) => a.chars.map((c) => [...c].length))),
    normalized_joined: presentNorm.flatMap((a) => a.chars).join(''),
    alignment_sum_duration_ms: present.flatMap((a) => a.charDurationsMs).reduce((n, x) => n + x, 0),
    conversion: conversion.slice(0, 12),
  });
  s.ws.close();
  await sleep(100);
}

async function cancelCheck() {
  const rate = 24000;
  const s = await open({ output_format: 'pcm_24000' });
  if (s.connect_ms === null) {
    report({ label: 'cancel', rejected: s.rejected, error: s.error });
    return;
  }
  const c = 'p2_g1';
  send(s, { context_id: c, text: ' ' });
  send(s, { context_id: c, text: '今日の会議は午後から始まります。資料を確認してから来てください。' });
  send(s, { context_id: c, flush: true });
  await waitFor(() => audioStats(s, c, rate).withAudio.length > 0, 8000);
  const at = audioStats(s, c, rate);
  const closeAt = performance.now() - s.t0;
  send(s, { context_id: c, close_context: true });
  await sleep(2500);
  const after = audioStats(s, c, rate);
  const late = after.withAudio.filter((x) => x.at > closeAt);
  const finalMsg = s.messages.find((x) => x.m.contextId === c && x.m.isFinal === true);
  report({
    label: 'cancel',
    audio_ms_at_cancel: at.audio_ms,
    late_chunks: late.length,
    late_audio_ms: after.audio_ms - at.audio_ms,
    last_late_ms_after_close: late.at(-1) ? Math.round((late.at(-1)?.at as number) - closeAt) : null,
    is_final_ms_after_close: finalMsg ? Math.round(finalMsg.at - closeAt) : null,
    closed: s.closed,
  });
  s.ws.close();
  await sleep(100);
}

/** 文字を消費しない確認。 */
async function limitsCheck() {
  const six = await open({ output_format: 'pcm_24000' });
  if (six.connect_ms !== null) {
    for (let i = 1; i <= 6; i++) send(six, { context_id: `c${i}`, text: ' ' });
    await sleep(1500);
    report({
      label: 'six_contexts',
      closed: six.closed,
      non_audio_messages: six.messages.filter((x) => !x.m.audio).slice(0, 3).map((x) => x.m),
    });
    if (!six.closed) {
      send(six, { context_id: 'c1', text: '' });
      await sleep(500);
      report({ label: 'keep_alive_empty_text', closed: six.closed });
    }
    six.ws.close();
    await sleep(100);
  }

  const cases: [string, Record<string, string>, string, string][] = [
    ['bad_format_mp3_junk', { output_format: 'pcm_99999' }, VOICE, KEY],
    ['pcm_44100', { output_format: 'pcm_44100' }, VOICE, KEY],
    ['pcm_48000', { output_format: 'pcm_48000' }, VOICE, KEY],
    ['bad_voice', { output_format: 'pcm_24000' }, 'nonexistent_voice_id', KEY],
    ['bad_key', { output_format: 'pcm_24000' }, VOICE, 'invalid-key-for-error-shape'],
    ['bad_model', { output_format: 'pcm_24000', model_id: 'eleven_v3' }, VOICE, KEY],
  ];
  for (const [label, query, voice, key] of cases) {
    const s = await open(query, voice, key);
    if (s.connect_ms !== null) {
      // 文字を消費しないよう空白だけを送り、サーバーの反応を見る。
      send(s, { context_id: 'c1', text: ' ' });
      await waitFor(() => s.closed !== null || s.messages.length > 0, 2000);
    }
    report({
      label,
      connect_ms: s.connect_ms,
      rejected_http: s.rejected,
      error_body: s.error,
      closed: s.closed,
      first_message: s.messages[0] ? { keys: keysOf(s.messages[0].m), m: s.messages[0].m.audio ? '<audio>' : s.messages[0].m } : null,
    });
    if (s.ws.readyState === WebSocket.OPEN) s.ws.close();
    await sleep(100);
  }
}

await synth('header_key_24k', 'pcm_24000', 24000, 'こんにちは、東京駅です。', false);
await synth('body_key_16k', 'pcm_16000', 16000, 'はい、わかりました。', true);
await cancelCheck();
await limitsCheck();
process.exit(0);
