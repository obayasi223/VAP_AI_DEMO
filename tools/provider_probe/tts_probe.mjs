// ElevenLabs measurements.
//   --mode single   stream-input: PCM formats, alignment structure, first-audio latency, auto_mode vs schedule
//   --mode multi    multi-stream-input: prefetch, cancel (is audio still sent after close?), keep-alive, context cap
//   --mode billing  characters charged for a cancelled context versus a completed one
//   --mode idle     disconnect after inactivity, and which keep-alive prevents it
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { requireEnv, requireConfirm, openLog, fail, redact, sleep, distribution, pcmToWav } from './lib/common.mjs';
import { TEST_TEXT, wsUrl, connect, analyzeAlignment, subscriptionCharacters } from './lib/tts.mjs';

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string' },
    model: { type: 'string', default: 'eleven_flash_v2_5' },
    formats: { type: 'string', default: 'pcm_16000,pcm_24000' },
    text: { type: 'string', default: TEST_TEXT },
    repeat: { type: 'string', default: '3' },
    'billing-wait-s': { type: 'string', default: '60' },
    yes: { type: 'boolean', default: false },
  },
});
requireEnv(['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'], [
  'ElevenLabs の測定には次を設定してください:',
  '  ELEVENLABS_API_KEY=<API キー>',
  '  ELEVENLABS_VOICE_ID=<日本語で使う声の voice_id>',
].join('\n'));
if (!['single', 'multi', 'billing', 'idle'].includes(args.mode)) {
  console.error('--mode single|multi|billing|idle を指定してください');
  process.exit(1);
}
const voice = process.env.ELEVENLABS_VOICE_ID;
const chars = [...args.text].length;
const formats = args.formats.split(',');
const repeat = Number(args.repeat);
const planned = { single: chars * formats.length * repeat * 3, multi: chars * 4, billing: chars * 2, idle: 3 * 3 }[args.mode];
requireConfirm(args, `${args.mode}: ${args.model} で最大約 ${planned} 文字を生成（Flash の API 料金なら約 $${((planned / 1000) * 0.04).toFixed(3)}）`);

const rateOf = (format) => Number(format.split('_')[1]);

/** One generation over stream-input. Reports time to first audio from the moment text is sent. */
async function single(format, { autoMode, schedule }) {
  const { ws, info, opened } = connect(wsUrl('stream-input', voice, {
    model_id: args.model, output_format: format, language_code: 'ja', sync_alignment: true, auto_mode: autoMode || undefined,
  }));
  await opened;
  const messages = [];
  const pcm = [];
  let sentAt = null;
  let firstAudio = null;
  let closeInfo = null;
  const done = new Promise((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.audio) {
        firstAudio ??= performance.now() - sentAt;
        pcm.push(Buffer.from(msg.audio, 'base64'));
      }
      const { audio, ...meta } = msg;
      messages.push(meta);
      if (msg.isFinal || msg.is_final) resolve();
    });
    ws.on('close', (code, reason) => {
      closeInfo = { code, reason: redact(reason.toString()) };
      resolve();
    });
  });
  const init = { text: ' ' };
  if (schedule) init.generation_config = { chunk_length_schedule: schedule };
  ws.send(JSON.stringify(init));
  sentAt = performance.now();
  ws.send(JSON.stringify({ text: `${args.text} `, flush: true }));
  const timeout = sleep(30_000).then(() => 'timeout');
  const outcome = await Promise.race([done, timeout]);
  const total = performance.now() - sentAt;
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ text: '' }));
  ws.close();
  const audioBytes = pcm.reduce((s, b) => s + b.length, 0);
  return {
    format,
    auto_mode: autoMode,
    schedule: schedule ?? 'default',
    connect_ms: info.connect_ms,
    x_region: info.region,
    first_audio_ms: firstAudio,
    total_ms: total,
    timed_out: outcome === 'timeout',
    close: closeInfo,
    audio_bytes: audioBytes,
    chunks: pcm.length,
    alignment: analyzeAlignment(messages, args.text, audioBytes, rateOf(format)),
    pcm: Buffer.concat(pcm),
    first_message_meta: messages.find((m) => m.alignment || m.normalizedAlignment) ?? messages[0] ?? null,
  };
}

async function runSingle(log) {
  const rows = [];
  for (const format of formats) {
    for (const variant of [{ autoMode: true }, { autoMode: false }, { autoMode: false, schedule: [50, 120, 160, 250] }]) {
      for (let i = 0; i < repeat; i++) {
        try {
          const r = await single(format, variant);
          const { pcm, ...row } = r;
          log.write({ kind: 'generation', i, ...row });
          rows.push(row);
          if (i === 0 && variant.autoMode) {
            const path = log.path.replace(/\.jsonl$/, `.${format}.wav`);
            writeFileSync(path, pcmToWav(pcm, rateOf(format)));
            console.log(`試聴用（漢字の読みを人が確認）: ${path}`);
          }
        } catch (err) {
          const row = { format, ...variant, error: redact(err.message) };
          log.write({ kind: 'generation_error', ...row });
          rows.push(row);
        }
      }
    }
  }
  const groups = {};
  for (const row of rows) {
    const key = `${row.format}/${row.autoMode ?? row.auto_mode ? 'auto_mode' : 'schedule'}/${JSON.stringify(row.schedule ?? 'default')}`;
    (groups[key] ??= []).push(row);
  }
  return {
    mode: 'single',
    groups: Object.fromEntries(Object.entries(groups).map(([k, list]) => [k, {
      errors: list.filter((x) => x.error).map((x) => x.error).slice(0, 2),
      first_audio_ms: distribution(list.map((x) => x.first_audio_ms).filter((x) => x !== null && x !== undefined)),
      connect_ms: distribution(list.map((x) => x.connect_ms).filter(Boolean)),
      x_region: [...new Set(list.map((x) => x.x_region))],
      alignment_sample: list.find((x) => x.alignment)?.alignment,
    }])),
  };
}

function multiSession(log) {
  const { ws, info, opened } = connect(wsUrl('multi-stream-input', voice, {
    model_id: args.model, output_format: formats[0], language_code: 'ja', sync_alignment: true, auto_mode: true, inactivity_timeout: 60,
  }));
  const contexts = new Map();
  const errors = [];
  const state = (id) => {
    if (!contexts.has(id)) contexts.set(id, { id, sent_at: null, first_audio_ms: null, bytes: 0, closed_at: null, bytes_after_close: 0, last_audio_after_close_ms: null, final_at: null });
    return contexts.get(id);
  };
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const id = msg.contextId ?? msg.context_id;
    if (msg.error || msg.message) {
      errors.push(redact(JSON.stringify(msg)));
      log.write({ kind: 'server_message', msg });
    }
    if (!id) return;
    const c = state(id);
    const now = performance.now();
    if (msg.audio) {
      const n = Buffer.from(msg.audio, 'base64').length;
      c.first_audio_ms ??= now - c.sent_at;
      c.bytes += n;
      if (c.closed_at !== null) {
        c.bytes_after_close += n;
        c.last_audio_after_close_ms = now - c.closed_at;
      }
    }
    if (msg.isFinal || msg.is_final) c.final_at = now;
  });
  const speak = (id, text, flush = true) => {
    const c = state(id);
    c.sent_at = performance.now();
    ws.send(JSON.stringify({ text: `${text} `, context_id: id, flush }));
  };
  const close = (id) => {
    state(id).closed_at = performance.now();
    ws.send(JSON.stringify({ context_id: id, close_context: true }));
  };
  const waitFirstAudio = async (id, timeoutMs = 15_000) => {
    const start = performance.now();
    while (state(id).first_audio_ms === null && performance.now() - start < timeoutMs) await sleep(5);
  };
  return { ws, info, opened, contexts, errors, speak, close, waitFirstAudio };
}

const reportContexts = (s) => [...s.contexts.values()].map(({ sent_at, closed_at, final_at, ...c }) => ({
  ...c,
  got_final: final_at !== null,
  was_closed: closed_at !== null,
}));

async function runMulti(log) {
  const s = multiSession(log);
  await s.opened;
  // A: prefetch that gets cancelled right after the first audio.
  s.speak('prefetch_a', args.text);
  await s.waitFirstAudio('prefetch_a');
  s.close('prefetch_a');
  // B: parallel generation while A's tail may still arrive. Uses the same socket, so there is no connect cost.
  s.speak('prefetch_b', args.text);
  await s.waitFirstAudio('prefetch_b');
  await sleep(3000);
  // C: warm socket after idling, with empty-text keep-alives on the context.
  for (let i = 0; i < 3; i++) {
    s.ws.send(JSON.stringify({ text: '', context_id: 'held_c' }));
    await sleep(5000);
  }
  s.speak('held_c', args.text);
  await s.waitFirstAudio('held_c');
  await sleep(2000);
  // The documented cap is 5 contexts per connection; try a sixth with minimal text.
  for (const id of ['cap_1', 'cap_2', 'cap_3', 'cap_4', 'cap_5', 'cap_6']) s.speak(id, 'はい', false);
  await sleep(4000);
  const socketOpen = s.ws.readyState === s.ws.OPEN;
  if (socketOpen) s.ws.send(JSON.stringify({ close_socket: true }));
  await sleep(500);
  s.ws.close();
  return {
    mode: 'multi',
    connect_ms: s.info.connect_ms,
    x_region: s.info.region,
    socket_open_after_six_contexts: socketOpen,
    contexts: reportContexts(s),
    server_errors: s.errors.slice(0, 8),
    question_audio_after_close: 'prefetch_a の bytes_after_close と last_audio_after_close_ms',
  };
}

async function runBilling(log) {
  const wait = Number(args['billing-wait-s']) * 1000;
  const measure = async (name, action) => {
    const before = await subscriptionCharacters();
    await action();
    await sleep(wait);
    const after = await subscriptionCharacters();
    const delta = (after.character_count ?? NaN) - (before.character_count ?? NaN);
    const row = { name, input_chars: chars, before, after, delta_character_count: delta };
    log.write({ kind: 'billing', ...row });
    return row;
  };
  const run = async (cancel) => {
    const s = multiSession(log);
    await s.opened;
    s.speak('c', args.text);
    await s.waitFirstAudio('c');
    if (cancel) s.close('c');
    await sleep(cancel ? 500 : 8000);
    s.ws.send(JSON.stringify({ close_socket: true }));
    await sleep(300);
    s.ws.close();
    return reportContexts(s);
  };
  const cancelled = await measure('cancelled_after_first_audio', () => run(true));
  const completed = await measure('completed', () => run(false));
  return {
    mode: 'billing',
    cancelled,
    completed,
    note: 'character_count の反映が遅れることがあるので、差が 0 なら --billing-wait-s を延ばす。他の利用が同時にあると差が混ざる。',
  };
}

async function runIdle(log) {
  const scenario = async (name, query, keepAlive, limitMs) => {
    const { ws, opened } = connect(wsUrl('stream-input', voice, { model_id: args.model, output_format: formats[0], ...query }));
    await opened;
    ws.send(JSON.stringify({ text: ' ' }));
    const begin = performance.now();
    let closed = null;
    ws.on('close', (code, reason) => {
      closed = { at_s: (performance.now() - begin) / 1000, code, reason: redact(reason.toString()) };
    });
    while (!closed && performance.now() - begin < limitMs) {
      await sleep(5000);
      if (!closed && keepAlive !== null && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ text: keepAlive }));
    }
    if (ws.readyState === ws.OPEN) ws.close();
    const row = { name, closed, survived_ms: closed ? null : limitMs };
    log.write({ kind: 'idle', ...row });
    return row;
  };
  return {
    mode: 'idle',
    rows: await Promise.all([
      scenario('no_keepalive_default', {}, null, 30_000),
      scenario('inactivity_timeout_60', { inactivity_timeout: 60 }, null, 40_000),
      scenario('keepalive_single_space', {}, ' ', 30_000),
    ]),
  };
}

try {
  const log = openLog(`tts-${args.mode}-${args.model}`);
  log.write({ kind: 'config', mode: args.mode, model: args.model, formats, input_chars: chars });
  const summary = await { single: runSingle, multi: runMulti, billing: runBilling, idle: runIdle }[args.mode](log);
  log.write({ kind: 'summary', ...summary });
  await log.close();
  const summaryPath = log.path.replace(/\.jsonl$/, '.summary.json');
  writeFileSync(summaryPath, `${redact(JSON.stringify(summary, null, 2))}\n`);
  console.log(redact(JSON.stringify(summary, null, 2)));
  console.log(`\nログ: ${log.path}\n要約: ${summaryPath}`);
  process.exit(0);
} catch (err) {
  fail(err);
}
