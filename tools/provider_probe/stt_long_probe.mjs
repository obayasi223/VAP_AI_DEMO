// Stream lifetime behaviour.
//   --mode limit     keep one stream open until the server ends it (about 5.5 min of audio)
//   --mode pause     stop sending for a while; does the stream survive, and do offsets count audio or wall time?
//   --mode handover  overlap two streams, as plan 8 proposes; checks the offset base and how much text repeats
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { requireGoogleStt, requireConfirm, openLog, readWav16kMono, fail, redact, sleep } from './lib/common.mjs';
import { makeClient, openStream, normalizeResponse, summarize, suffixPrefixOverlap, BYTES_PER_MS } from './lib/stt.mjs';

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string' },
    wav: { type: 'string' },
    model: { type: 'string', default: 'chirp_3' },
    location: { type: 'string', default: 'us' },
    language: { type: 'string', default: 'ja-JP' },
    'chunk-ms': { type: 'string', default: '40' },
    'max-s': { type: 'string', default: '330' },
    'pause-at-s': { type: 'string', default: '10' },
    'pause-s': { type: 'string', default: '15' },
    'start-b-s': { type: 'string', default: '20' },
    'end-a-s': { type: 'string', default: '30' },
    'end-s': { type: 'string', default: '45' },
    yes: { type: 'boolean', default: false },
  },
});
requireGoogleStt();
if (!args.wav || !['limit', 'pause', 'handover'].includes(args.mode)) {
  console.error('--mode limit|pause|handover と --wav <WAV> を指定してください');
  process.exit(1);
}
const audio = readWav16kMono(args.wav);
const chunkMs = Number(args['chunk-ms']);
const chunkBytes = chunkMs * BYTES_PER_MS;
const seconds = {
  limit: Number(args['max-s']),
  pause: Number(args['pause-at-s']) + 10,
  handover: Number(args['end-s']) + (Number(args['end-a-s']) - Number(args['start-b-s'])),
}[args.mode];
requireConfirm(args, `${args.mode}: ${args.location}/${args.model} へ最大 ${seconds} 秒ぶん送信（標準料金なら約 $${((seconds / 60) * 0.016).toFixed(3)}）`);

/** Loops the WAV forever, so a short clip can drive a long stream. */
function audioLoop(pcm) {
  let pos = 0;
  return () => {
    const out = Buffer.alloc(chunkBytes);
    let filled = 0;
    while (filled < chunkBytes) {
      const n = pcm.copy(out, filled, pos, Math.min(pos + chunkBytes - filled, pcm.length));
      filled += n;
      pos = (pos + n) % pcm.length;
    }
    return out;
  };
}

function track(name, stream, baseMs, clock, log) {
  const state = { name, baseMs, sentBytes: 0, responses: [], error: null, endedAtMs: null, closed: false };
  const done = new Promise((resolve) => {
    stream.on('data', (res) => {
      const item = normalizeResponse(res, clock(), state.sentBytes / BYTES_PER_MS);
      state.responses.push(item);
      log.write({ kind: 'response', stream: name, base_ms: baseMs, ...item });
    });
    stream.on('error', (err) => {
      state.error = { code: err.code, message: redact(err.message), at_ms: clock() };
      state.closed = true;
      log.write({ kind: 'error', stream: name, ...state.error });
      resolve();
    });
    stream.on('end', () => {
      state.endedAtMs = clock();
      state.closed = true;
      log.write({ kind: 'end', stream: name, at_ms: state.endedAtMs });
      resolve();
    });
  });
  state.done = done;
  state.send = (chunk) => {
    if (state.closed) return;
    state.sentBytes += chunk.length;
    stream.write({ audio: chunk });
  };
  state.finish = async () => {
    if (!state.closed) stream.end();
    await Promise.race([done, sleep(15_000)]);
  };
  return state;
}

const finalText = (s) => s.responses.flatMap((r) => r.results.filter((x) => x.is_final)).map((x) => x.text).join('');

try {
  const log = openLog(`stt-long-${args.mode}-${args.model}`);
  const client = await makeClient(args.location);
  const cfg = { project: process.env.GOOGLE_CLOUD_PROJECT, location: args.location, model: args.model, language: args.language, interim: true };
  log.write({ kind: 'config', mode: args.mode, ...cfg, chunk_ms: chunkMs });
  const next = audioLoop(audio.pcm);
  const begin = performance.now();
  const clock = () => performance.now() - begin;
  const tick = async (i) => {
    const wait = begin + i * chunkMs - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };

  let summary;
  if (args.mode === 'limit') {
    const a = track('A', openStream(client, cfg), 0, clock, log);
    const total = Math.floor((Number(args['max-s']) * 1000) / chunkMs);
    for (let i = 0; i < total && !a.closed; i++) {
      a.send(next());
      await tick(i + 1);
    }
    const closedByServer = a.closed;
    await a.finish();
    summary = {
      mode: 'limit',
      closed_by_server: closedByServer,
      closed_at_s: closedByServer ? ((a.error?.at_ms ?? a.endedAtMs) / 1000) : null,
      sent_audio_s: a.sentBytes / BYTES_PER_MS / 1000,
      error: a.error,
      ...summarize(a.responses),
    };
  } else if (args.mode === 'pause') {
    const a = track('A', openStream(client, cfg), 0, clock, log);
    const pauseAt = Math.floor((Number(args['pause-at-s']) * 1000) / chunkMs);
    const total = pauseAt + Math.floor(10_000 / chunkMs);
    const pauseMs = Number(args['pause-s']) * 1000;
    for (let i = 0; i < total && !a.closed; i++) {
      if (i === pauseAt) {
        log.write({ kind: 'pause_start', at_ms: clock() });
        await sleep(pauseMs);
        log.write({ kind: 'pause_end', at_ms: clock() });
      }
      a.send(next());
      await tick(i + 1 + (i >= pauseAt ? pauseMs / chunkMs : 0));
    }
    const closedDuringPause = a.closed;
    await a.finish();
    const ends = a.responses.flatMap((r) => r.results).map((x) => x.end_ms).filter((x) => x !== null);
    summary = {
      mode: 'pause',
      pause_s: Number(args['pause-s']),
      stream_closed_early: closedDuringPause,
      error: a.error,
      sent_audio_ms: a.sentBytes / BYTES_PER_MS,
      max_result_end_ms: ends.length ? Math.max(...ends) : null,
      note: 'max_result_end_ms が sent_audio_ms に近ければ、offset は壁時計でなく送信音声の位置',
      ...summarize(a.responses),
    };
  } else {
    const a = track('A', openStream(client, cfg), 0, clock, log);
    let b = null;
    const startB = Math.floor((Number(args['start-b-s']) * 1000) / chunkMs);
    const endA = Math.floor((Number(args['end-a-s']) * 1000) / chunkMs);
    const end = Math.floor((Number(args['end-s']) * 1000) / chunkMs);
    for (let i = 0; i < end; i++) {
      if (i === startB) b = track('B', openStream(client, cfg), startB * chunkMs, clock, log);
      const chunk = next();
      if (i < endA) a.send(chunk);
      else if (i === endA) a.finish(); // not awaited: B must keep receiving audio at real time
      if (b) b.send(chunk);
      await tick(i + 1);
    }
    await a.finish();
    await b.finish();
    const bFinals = b.responses.flatMap((r) => r.results.filter((x) => x.is_final));
    const bEnds = b.responses.flatMap((r) => r.results).map((x) => x.end_ms).filter((x) => x !== null);
    summary = {
      mode: 'handover',
      overlap_s: (endA - startB) * chunkMs / 1000,
      errors: { a: a.error, b: b.error },
      a_finals: a.responses.flatMap((r) => r.results.filter((x) => x.is_final)).map((x) => ({ end_ms: x.end_ms, text: x.text })),
      b_finals: bFinals.map((x) => ({ end_ms: x.end_ms, global_end_ms: x.end_ms === null ? null : x.end_ms + startB * chunkMs, text: x.text })),
      b_offset_starts_near_zero: bEnds.length ? Math.min(...bEnds) < (end - startB) * chunkMs : null,
      b_max_end_ms: bEnds.length ? Math.max(...bEnds) : null,
      b_sent_audio_ms: b.sentBytes / BYTES_PER_MS,
      text_overlap_chars: suffixPrefixOverlap(finalText(a), finalText(b)),
      note: 'b_max_end_ms が b_sent_audio_ms に近ければ、offset の基準はそのストリームの先頭音声',
      a: summarize(a.responses),
      b: summarize(b.responses),
    };
  }
  log.write({ kind: 'summary', ...summary });
  await log.close();
  const summaryPath = log.path.replace(/\.jsonl$/, '.summary.json');
  writeFileSync(summaryPath, `${redact(JSON.stringify(summary, null, 2))}\n`);
  console.log(redact(JSON.stringify(summary, null, 2)));
  console.log(`\nログ: ${log.path}\n要約: ${summaryPath}`);
  await client.close();
  process.exit(0);
} catch (err) {
  fail(err);
}
