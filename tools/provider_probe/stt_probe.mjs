// Streams one WAV at real time and answers: interim availability, stability, resultEndOffset,
// word offsets, cumulative behaviour, final splitting, voice events, and the evidence-time error.
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { requireGoogleStt, requireConfirm, openLog, readWav16kMono, fail, redact, distribution, sleep } from './lib/common.mjs';
import { makeClient, openStream, normalizeResponse, summarize, pacedSend, recognitionConfig, durationMs, normalizeText, BYTES_PER_MS } from './lib/stt.mjs';

const { values: args } = parseArgs({
  options: {
    wav: { type: 'string' },
    model: { type: 'string', default: 'chirp_3' },
    location: { type: 'string', default: 'us' },
    language: { type: 'string', default: 'ja-JP' },
    'chunk-ms': { type: 'string', default: '40' },
    speed: { type: 'string', default: '1' },
    'word-offsets': { type: 'boolean', default: false },
    'no-interim': { type: 'boolean', default: false },
    endpointing: { type: 'string' },
    'boundary-s': { type: 'string' },
    'posthoc-words': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
});
requireGoogleStt();
if (!args.wav) {
  console.error('--wav <16bit PCM の日本語 WAV> を指定してください');
  process.exit(1);
}
const audio = readWav16kMono(args.wav);
const chunkMs = Number(args['chunk-ms']);
requireConfirm(args, `${args.location}/${args.model} へ ${audio.durationS.toFixed(1)} 秒を送信（標準料金なら約 $${((audio.durationS / 60) * 0.016).toFixed(4)}${args['posthoc-words'] ? '、事後の語時刻で約2倍' : ''}）`);

async function posthocWords(client, config, pcm) {
  const name = `projects/${config.project}/locations/${config.location}/recognizers/_`;
  const clip = pcm.subarray(0, Math.min(pcm.length, 55_000 * BYTES_PER_MS));
  const [res] = await client.recognize({
    recognizer: name,
    config: recognitionConfig({ ...config, wordOffsets: true }),
    content: clip,
  });
  return (res.results ?? []).flatMap((r) => r.alternatives?.[0]?.words ?? []).map((w) => ({
    word: w.word,
    end_ms: durationMs(w.endOffset),
  }));
}

/** How far "first interim containing the word" trails the word's real end, which is the 3.6 approximation. */
function evidenceError(words, responses) {
  const revisions = [];
  let settled = '';
  for (const r of responses) {
    if (r.results.length === 0) continue;
    for (const x of r.results) if (x.is_final) settled += normalizeText(x.text);
    const interims = r.results.filter((x) => !x.is_final);
    const ends = r.results.map((x) => x.end_ms).filter((x) => x !== null);
    revisions.push({
      text: settled + normalizeText(interims.map((x) => x.text).join('')),
      end_ms: ends.length ? Math.max(...ends) : null,
      audio_sent_ms: r.audio_sent_ms,
    });
  }
  const offsetError = [];
  const arrivalDelay = [];
  let prefix = '';
  for (const w of words) {
    prefix += normalizeText(w.word ?? '');
    if (w.end_ms === null || !prefix) continue;
    const first = revisions.find((rev) => rev.text.startsWith(prefix));
    if (!first) continue;
    if (first.end_ms !== null) offsetError.push(first.end_ms - w.end_ms);
    arrivalDelay.push(first.audio_sent_ms - w.end_ms);
  }
  return {
    words: words.length,
    matched: arrivalDelay.length,
    result_end_offset_minus_word_end_ms: distribution(offsetError),
    audio_sent_at_first_arrival_minus_word_end_ms: distribution(arrivalDelay),
  };
}

try {
  const log = openLog(`stt-${args.location}-${args.model}`);
  const client = await makeClient(args.location);
  const cfg = {
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: args.location,
    model: args.model,
    language: args.language,
    wordOffsets: args['word-offsets'],
    interim: !args['no-interim'],
    endpointing: args.endpointing,
  };
  log.write({ kind: 'config', ...cfg, chunk_ms: chunkMs, speed: Number(args.speed), wav_duration_s: audio.durationS, resampled_from: audio.resampled ? audio.sourceRate : null });

  const responses = [];
  let error = null;
  let sentBytes = 0;
  let begin = null;
  const stream = openStream(client, cfg);
  const finished = new Promise((resolve) => {
    stream.on('data', (res) => {
      const item = normalizeResponse(res, performance.now() - begin, sentBytes / BYTES_PER_MS);
      responses.push(item);
      log.write({ kind: 'response', ...item });
    });
    stream.on('error', (err) => {
      error = { code: err.code, message: redact(err.message) };
      log.write({ kind: 'error', ...error, at_ms: performance.now() - begin });
      resolve();
    });
    stream.on('end', resolve);
  });

  begin = performance.now();
  await pacedSend(audio.pcm, chunkMs, (chunk) => {
    sentBytes += chunk.length;
    stream.write({ audio: chunk });
  }, { speed: Number(args.speed), shouldStop: () => error !== null });
  if (!error) stream.end();
  await Promise.race([finished, sleep(15_000)]);

  const summary = {
    config: cfg,
    chunk_ms: chunkMs,
    error,
    sent_audio_ms: sentBytes / BYTES_PER_MS,
    ...summarize(responses, { boundaryMs: args['boundary-s'] ? Number(args['boundary-s']) * 1000 : null }),
  };
  if (args['posthoc-words'] && !error) {
    try {
      const words = await posthocWords(client, cfg, audio.pcm);
      summary.evidence_time = evidenceError(words, responses);
    } catch (err) {
      summary.evidence_time = { error: redact(err.message) };
    }
  }
  log.write({ kind: 'summary', ...summary });
  await log.close();
  const summaryPath = log.path.replace(/\.jsonl$/, '.summary.json');
  writeFileSync(summaryPath, `${redact(JSON.stringify(summary, null, 2))}\n`);
  console.log(redact(JSON.stringify(summary, null, 2)));
  console.log(`\nログ: ${log.path}\n要約: ${summaryPath}`);
  await client.close();
  process.exit(error ? 1 : 0);
} catch (err) {
  fail(err);
}
