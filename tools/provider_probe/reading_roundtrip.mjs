// TTS -> STT round trip: does a TTS read Japanese kanji with a Chinese reading?
// Audio goes to out/reading_roundtrip/ as WAV, so a person can listen afterwards. Re-running reuses
// what is already there and spends nothing on it. ledger.json keeps the running totals across runs.
//   cd tools/provider_probe
//   node --env-file=../../.env reading_roundtrip.mjs --conditions el_ja,el_nolang,el_hira_ja,gemini --yes
// Stops at once on a quota or auth error (exit 4) and when a cap would be crossed (exit 5).
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireEnv, requireGoogleStt, requireConfirm, fail, redact, sleep, pcmToWav } from './lib/common.mjs';
import { wsUrl, connect } from './lib/tts.mjs';
import { makeClient, durationMs } from './lib/stt.mjs';
import { SENTENCES } from './lib/reading_sentences.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out', 'reading_roundtrip');
const LEDGER = join(OUT, 'ledger.json');
const EL_MODEL = 'eleven_flash_v2_5';
const GEMINI_MODEL = 'gemini-3.8-flash-lite-tts';
const EL_RATE = 24000;
const STT = { location: 'asia-northeast1', model: 'long', language: 'ja-JP' };
const CHUNK_MS = 40;
// ElevenLabs clips end with no silence, and the STT then drops the last words (seen in the pilot). Streams are
// billed per started second, so pad up to the next whole second: at least this much, at no extra charge.
const MIN_TAIL_S = 0.2;

/** kana=true sends the hiragana form instead of the kanji form. query is merged into the ElevenLabs URL. */
const CONDITIONS = {
  el_ja: { provider: 'elevenlabs', kana: false, query: { language_code: 'ja' } },
  el_nolang: { provider: 'elevenlabs', kana: false, query: {} },
  el_hira_ja: { provider: 'elevenlabs', kana: true, query: { language_code: 'ja' } },
  gemini: { provider: 'gemini', kana: false },
  // Mitigation candidates. Run only when asked for.
  el_ja_norm_on: { provider: 'elevenlabs', kana: false, query: { language_code: 'ja', apply_text_normalization: 'on' } },
  el_ja_norm_off: { provider: 'elevenlabs', kana: false, query: { language_code: 'ja', apply_text_normalization: 'off' } },
  // HTTP, not the WebSocket: this is where the setting is documented. Not the production path.
  el_ja_langnorm_http: { provider: 'elevenlabs_http', kana: false, body: { language_code: 'ja', apply_language_text_normalization: true } },
  // Same as el_ja and el_hira_ja, but close_context only after the audio has gone quiet. Checks for a cut tail.
  el_ja_late_close: { provider: 'elevenlabs', kana: false, query: { language_code: 'ja' }, lateClose: true },
  el_hira_ja_late_close: { provider: 'elevenlabs', kana: true, query: { language_code: 'ja' }, lateClose: true },
};

const { values: args } = parseArgs({
  options: {
    conditions: { type: 'string', default: 'el_ja,el_nolang,el_hira_ja,gemini' },
    sentences: { type: 'string', default: '' },
    'max-el-chars': { type: 'string', default: '1000' },
    'max-stt-s': { type: 'string', default: '180' },
    'synth-only': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
});

class StopRun extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

const wanted = args.conditions.split(',');
for (const c of wanted) if (!CONDITIONS[c]) throw new Error(`unknown condition ${c}`);
const ids = args.sentences ? new Set(args.sentences.split(',')) : null;
const sentences = SENTENCES.filter((s) => !ids || ids.has(s.id));
const maxElChars = Number(args['max-el-chars']);
const maxSttS = Number(args['max-stt-s']);

requireGoogleStt();
if (wanted.some((c) => CONDITIONS[c].provider.startsWith('elevenlabs'))) requireEnv(['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'], 'ElevenLabs のキーが必要です');
if (wanted.includes('gemini')) requireEnv(['GEMINI_API_KEY'], 'Gemini のキーが必要です');

mkdirSync(OUT, { recursive: true });
const ledger = existsSync(LEDGER)
  ? JSON.parse(readFileSync(LEDGER, 'utf8'))
  : { elevenlabs_chars: 0, gemini_chars: 0, stt_sent_s: 0, stt_billed_s: 0, stt_streams: 0 };
const saveLedger = () => writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);

const clipPath = (cond, s, ext) => join(OUT, `${cond}__${s.id}.${ext}`);
const textOf = (cond, s) => (CONDITIONS[cond].kana ? s.kana : s.kanji);

const jobs = wanted.flatMap((cond) => sentences.map((s) => ({ cond, s })));
const toSynth = jobs.filter((j) => !existsSync(clipPath(j.cond, j.s, 'wav')));
const plannedEl = toSynth.filter((j) => CONDITIONS[j.cond].provider.startsWith('elevenlabs')).reduce((n, j) => n + [...textOf(j.cond, j.s)].length, 0);
requireConfirm(args, `新規合成 ${toSynth.length} 件、ElevenLabs 約 ${plannedEl} 文字（累計 ${ledger.elevenlabs_chars}）、STT 累計 ${ledger.stt_sent_s.toFixed(1)} 秒`);
if (ledger.elevenlabs_chars + plannedEl > maxElChars) {
  throw new StopRun(5, `ElevenLabs の上限を超えます: 累計 ${ledger.elevenlabs_chars} + 予定 ${plannedEl} > ${maxElChars}`);
}

function isHardStop(code) {
  return /quota|auth|api_key|permission|payment|credit|limit_reached|not_allowed/i.test(String(code));
}

/** Mirrors the production order: one context, a space, the text, flush, close_context, then wait for isFinal. */
async function synthElevenLabs(cond, text) {
  const { query, lateClose } = CONDITIONS[cond];
  const { ws, opened, info } = connect(wsUrl('multi-stream-input', process.env.ELEVENLABS_VOICE_ID, {
    model_id: EL_MODEL,
    output_format: `pcm_${EL_RATE}`,
    auto_mode: true,
    sync_alignment: true,
    inactivity_timeout: 60,
    ...query,
  }));
  await opened;
  const pcm = [];
  const alignment = [];
  const normalized = [];
  const timing = [];
  let lastAudioAt = null;
  let serverError = null;
  let closed = null;
  const done = new Promise((resolve) => {
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.error !== undefined) {
        serverError = { error: m.error, message: redact(String(m.message ?? '')).slice(0, 300) };
        resolve();
        return;
      }
      if (m.audio) {
        pcm.push(Buffer.from(m.audio, 'base64'));
        lastAudioAt = performance.now();
      }
      if (m.alignment?.chars) {
        alignment.push(...m.alignment.chars);
        m.alignment.chars.forEach((c, i) => timing.push([c, m.alignment.charStartTimesMs[i], m.alignment.charDurationsMs[i]]));
      }
      if (m.normalizedAlignment?.chars) normalized.push(...m.normalizedAlignment.chars);
      if (m.isFinal) resolve();
    });
    ws.on('close', (code, reason) => {
      closed = { code, reason: redact(String(reason)).slice(0, 300) };
      resolve();
    });
  });
  ledger.elevenlabs_chars += [...text].length;
  saveLedger();
  const send = (m) => ws.send(JSON.stringify(m));
  send({ context_id: 'c1', text: ' ' });
  send({ context_id: 'c1', text });
  send({ context_id: 'c1', flush: true });
  if (lateClose) {
    const giveUp = performance.now() + 15_000;
    while (performance.now() < giveUp && !serverError && !closed && (lastAudioAt === null || performance.now() - lastAudioAt < 2000)) await sleep(20);
  }
  if (ws.readyState === ws.OPEN) send({ context_id: 'c1', close_context: true });
  const outcome = await Promise.race([done, sleep(20_000).then(() => 'timeout')]);
  if (ws.readyState === ws.OPEN) ws.close();
  if (serverError) {
    const stop = isHardStop(serverError.error);
    throw new StopRun(stop ? 4 : 1, `ElevenLabs ${cond}: ${JSON.stringify(serverError)}`);
  }
  if (outcome === 'timeout') throw new StopRun(1, `ElevenLabs ${cond}: isFinal が 20 秒来ない`);
  if (pcm.length === 0) throw new StopRun(1, `ElevenLabs ${cond}: 音声なし closed=${JSON.stringify(closed)}`);
  return {
    pcm: Buffer.concat(pcm),
    rate: EL_RATE,
    region: info.region,
    alignment: alignment.join(''),
    normalized: normalized.join(''),
    timing,
    closed,
  };
}

async function synthElevenLabsHttp(cond, text) {
  ledger.elevenlabs_chars += [...text].length;
  saveLedger();
  const began = performance.now();
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(process.env.ELEVENLABS_VOICE_ID)}?output_format=pcm_${EL_RATE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    body: JSON.stringify({ text, model_id: EL_MODEL, ...CONDITIONS[cond].body }),
  });
  if (!res.ok) {
    const body = redact(await res.text()).slice(0, 400);
    throw new StopRun(isHardStop(body) || res.status === 401 ? 4 : 1, `ElevenLabs HTTP ${res.status} ${cond}: ${body}`);
  }
  const pcm = Buffer.from(await res.arrayBuffer());
  return { pcm, rate: EL_RATE, http_ms: Math.round(performance.now() - began) };
}

/** The limit is 10 requests per minute on this key's tier. A per-minute 429 says when to retry; anything else stops. */
async function synthGemini(text, retried = false) {
  await sleep(6500);
  ledger.gemini_chars += [...text].length;
  saveLedger();
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Api-Revision': '2026-05-20' },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Kore' }] },
      stream: true,
      store: false,
    }),
  });
  if (!res.ok) {
    const body = redact(await res.text()).slice(0, 300);
    const retryIn = /Rate limit exceeded.*requests per minute.*retry in (\d+)s/.exec(body);
    if (res.status === 429 && retryIn && !retried) {
      console.log(`Gemini の毎分の制限。${retryIn[1]} 秒待って1回だけやり直す`);
      await sleep((Number(retryIn[1]) + 2) * 1000);
      return synthGemini(text, true);
    }
    throw new StopRun([401, 403, 429].includes(res.status) ? 4 : 1, `Gemini HTTP ${res.status}: ${body}`);
  }
  const pcm = [];
  let rate = 24000;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const piece of res.body) {
    buffer += decoder.decode(piece, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const ev = JSON.parse(payload);
      if (ev.error || ev.event_type === 'error' || ev.event_type === 'interaction.failed') {
        throw new StopRun(1, `Gemini stream: ${redact(JSON.stringify(ev.error ?? ev.event_type)).slice(0, 300)}`);
      }
      if (ev.event_type === 'step.delta' && ev.delta?.type === 'audio' && ev.delta.data) {
        pcm.push(Buffer.from(ev.delta.data, 'base64'));
        rate = ev.delta.sample_rate ?? rate;
      }
    }
  }
  if (pcm.length === 0) throw new StopRun(1, 'Gemini: 音声なし');
  return { pcm: Buffer.concat(pcm), rate };
}

function pcmOfWav(path) {
  const buf = readFileSync(path);
  return { pcm: buf.subarray(44), rate: buf.readUInt32LE(24) };
}

/** STT takes the provider's rate as is, so nothing is lost to a resampler before the comparison. */
async function transcribe(client, voiced, rate) {
  const tailBytes = Math.round((Math.ceil(voiced.length / 2 / rate + MIN_TAIL_S) - voiced.length / 2 / rate) * rate) * 2;
  const pcm = Buffer.concat([voiced, Buffer.alloc(tailBytes)]);
  const stream = client._streamingRecognize();
  stream.write({
    recognizer: `projects/${process.env.GOOGLE_CLOUD_PROJECT}/locations/${STT.location}/recognizers/_`,
    streamingConfig: {
      config: {
        explicitDecodingConfig: { encoding: 'LINEAR16', sampleRateHertz: rate, audioChannelCount: 1 },
        languageCodes: [STT.language],
        model: STT.model,
        features: { enableAutomaticPunctuation: true },
      },
      streamingFeatures: { interimResults: false },
    },
  });
  const finals = [];
  let billedMs = null;
  let error = null;
  const done = new Promise((resolve) => {
    stream.on('data', (r) => {
      for (const x of r.results ?? []) if (x.isFinal) finals.push({ text: x.alternatives?.[0]?.transcript ?? '', confidence: x.alternatives?.[0]?.confidence ?? null });
      const billed = durationMs(r.metadata?.totalBilledDuration);
      if (billed !== null) billedMs = billed;
    });
    stream.on('error', (e) => {
      error = { code: e.code, message: redact(e.message).slice(0, 300) };
      resolve();
    });
    stream.on('end', resolve);
  });
  const chunkBytes = Math.round((rate * 2 * CHUNK_MS) / 1000);
  const begin = performance.now();
  let sent = 0;
  for (let pos = 0; pos < pcm.length && !error; pos += chunkBytes) {
    const chunk = pcm.subarray(pos, Math.min(pos + chunkBytes, pcm.length));
    stream.write({ audio: chunk });
    sent += chunk.length;
    const wait = begin + (sent / (rate * 2)) * 1000 - performance.now();
    if (wait > 0) await sleep(wait);
  }
  if (!error) stream.end();
  await Promise.race([done, sleep(15_000)]);
  return { finals, text: finals.map((f) => f.text).join(''), billed_ms: billedMs, error };
}

async function main() {
  // Phase 1: synthesis, one at a time.
  for (const { cond, s } of jobs) {
    const wavPath = clipPath(cond, s, 'wav');
    if (existsSync(wavPath)) continue;
    const text = textOf(cond, s);
    const provider = CONDITIONS[cond].provider;
    const got = provider === 'gemini' ? await synthGemini(text) : provider === 'elevenlabs_http' ? await synthElevenLabsHttp(cond, text) : await synthElevenLabs(cond, text);
    writeFileSync(wavPath, pcmToWav(got.pcm, got.rate));
    const { pcm, ...meta } = got;
    writeFileSync(clipPath(cond, s, 'tts.json'), `${redact(JSON.stringify({
      cond, id: s.id, text, audio_s: pcm.length / 2 / got.rate, ...meta,
      model: provider === 'gemini' ? GEMINI_MODEL : EL_MODEL,
      query: CONDITIONS[cond].query ?? CONDITIONS[cond].body ?? null,
    }, null, 2))}\n`);
    console.log(`tts ${cond} ${s.id} ${(pcm.length / 2 / got.rate).toFixed(2)}s norm=${meta.normalized ?? '-'}`);
    await sleep(150);
  }

  if (args['synth-only']) {
    console.log(JSON.stringify(ledger));
    return;
  }

  // Phase 2: STT, a few streams at once. Each stream runs at real time.
  const pending = jobs.filter((j) => !existsSync(clipPath(j.cond, j.s, 'stt.json')));
  const client = pending.length ? await makeClient(STT.location) : null;
  let stop = null;
  const worker = async () => {
    while (pending.length && !stop) {
      const { cond, s } = pending.shift();
      const { pcm, rate } = pcmOfWav(clipPath(cond, s, 'wav'));
      const seconds = Math.ceil(pcm.length / 2 / rate + MIN_TAIL_S);
      if (ledger.stt_sent_s + seconds > maxSttS) {
        stop = new StopRun(5, `STT の上限を超えます: 累計 ${ledger.stt_sent_s.toFixed(1)} + ${seconds} > ${maxSttS} 秒（${cond} ${s.id} の手前で停止）`);
        return;
      }
      ledger.stt_sent_s += seconds;
      ledger.stt_streams += 1;
      saveLedger();
      const r = await transcribe(client, pcm, rate);
      if (r.error) {
        stop = new StopRun(r.error.code === 8 || r.error.code === 7 || r.error.code === 16 ? 4 : 1, `STT ${cond} ${s.id}: ${JSON.stringify(r.error)}`);
        return;
      }
      if (r.billed_ms !== null) ledger.stt_billed_s += r.billed_ms / 1000;
      saveLedger();
      writeFileSync(clipPath(cond, s, 'stt.json'), `${JSON.stringify({ cond, id: s.id, sent_s: seconds, ...STT, ...r }, null, 2)}\n`);
      console.log(`stt ${cond} ${s.id} ${seconds}s -> ${r.text}`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (client) await client.close();
  if (stop) throw stop;
  console.log(JSON.stringify(ledger));
}

try {
  await main();
  process.exit(0);
} catch (err) {
  saveLedger();
  if (err instanceof StopRun) {
    console.error(`STOP: ${redact(err.message)}`);
    console.error(JSON.stringify(ledger));
    process.exit(err.exitCode);
  }
  fail(err);
}
