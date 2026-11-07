// Offline tests. Every endpoint is a local fake and every key is a dummy, so they check the scripts' request
// shapes and parsers only. Nothing here is evidence about how the real providers behave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { pcmToWav, redact, readWav16kMono } from '../lib/common.mjs';
import { summarize, normalizeResponse, suffixPrefixOverlap } from '../lib/stt.mjs';
import { analyzeAlignment } from '../lib/tts.mjs';
import { startFakeStt } from './fake_stt_server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/GEMINI|ELEVENLABS|GOOGLE_/.test(k)));

function run(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, script), ...args], { env: { ...CLEAN, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}
const summaryOf = (out) => JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));

function makeWav(seconds = 1, rate = 16000) {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const path = join(dir, 'tone.wav');
  const pcm = Buffer.alloc(seconds * rate * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), i * 2);
  writeFileSync(path, pcmToWav(pcm, rate));
  return path;
}

test('without credentials every script explains what to set and exits 2', async () => {
  for (const [script, args] of [
    ['gemini_probe.mjs', ['--mode', 'models']],
    ['tts_probe.mjs', ['--mode', 'single']],
    ['stt_probe.mjs', ['--wav', 'x.wav']],
    ['stt_long_probe.mjs', ['--mode', 'limit', '--wav', 'x.wav']],
    ['stt_locations.mjs', []],
  ]) {
    const r = await run(script, args);
    assert.equal(r.code, 2, script);
    assert.match(r.err, /未設定の環境変数/);
    assert.match(r.err, /呼び出していません/);
  }
});

test('with a key but no --yes nothing is called and the exit code is 3', async () => {
  const r = await run('gemini_probe.mjs', ['--mode', 'latency'], { GEMINI_API_KEY: 'dummy', GEMINI_TEST_BASE: 'http://127.0.0.1:1' });
  assert.equal(r.code, 3);
  assert.match(r.err, /--yes/);
});

test('redact removes key values and header values', () => {
  process.env.GEMINI_API_KEY = 'SECRET123';
  assert.equal(redact('boom SECRET123 boom').includes('SECRET123'), false);
  assert.equal(redact('{"xi-api-key":"abc"}').includes('abc'), false);
  delete process.env.GEMINI_API_KEY;
});

test('readWav16kMono resamples other rates and flags it', () => {
  const r = readWav16kMono(makeWav(1, 44100));
  assert.equal(r.resampled, true);
  assert.ok(Math.abs(r.durationS - 1) < 0.01);
});

test('summarize treats stability 0 as not returned and keeps the end offsets', () => {
  const mk = (results, received) => normalizeResponse({ results }, received, received);
  const summary = summarize([
    mk([{ alternatives: [{ transcript: 'あ' }], stability: 0, resultEndOffset: { seconds: 1 } }], 1000),
    mk([{ alternatives: [{ transcript: 'あい' }], stability: 0, resultEndOffset: { seconds: 2 } }], 2000),
  ]);
  assert.equal(summary.stability.returned, false);
  assert.equal(summary.result_end_offset.on_interim_share, 1);
  assert.equal(summary.revision_behaviour.extended_prefix, 1);
});

test('suffixPrefixOverlap ignores punctuation', () => {
  assert.equal(suffixPrefixOverlap('今日は天気が、いい。', 'いい天気'), 2);
  assert.equal(suffixPrefixOverlap('あいう', 'かきく'), 0);
});

test('analyzeAlignment recognises per-chunk timing', () => {
  const msgs = [
    { alignment: { chars: ['今', '日'], charStartTimesMs: [0, 100], charDurationsMs: [100, 100] } },
    { alignment: { chars: ['は'], charStartTimesMs: [0], charDurationsMs: [100] } },
  ];
  const report = analyzeAlignment(msgs, '今日は', 16000 * 2 * 0.3, 16000);
  assert.equal(report.raw.matches_input, true);
  assert.equal(report.raw.looks_chunk_relative, true);
  assert.equal(report.raw.max_codepoints_per_entry, 1);
  assert.ok(Math.abs(report.audio_ms_over_alignment_ms - 1) < 0.01);
});

test('stt_probe sends a v2 request: recognizer and config first, then audio under the size cap', async () => {
  const fake = await startFakeStt();
  try {
    const r = await run('stt_probe.mjs', ['--wav', makeWav(1), '--boundary-s', '0.5', '--yes'], {
      GOOGLE_CLOUD_PROJECT: 'p',
      GOOGLE_STT_USE_ADC: '1', // passes the env gate only; lib/stt.mjs uses inline dummy credentials for the fake
      STT_PROBE_TEST_ENDPOINT: `127.0.0.1:${fake.port}`,
    });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err.includes('MetadataLookupWarning'), false, 'must not look up real credentials');
    const first = fake.received.first;
    assert.equal(first.recognizer, 'projects/p/locations/us/recognizers/_');
    const sc = first.streaming_config;
    assert.equal(sc.config.model, 'chirp_3');
    assert.deepEqual(sc.config.language_codes, ['ja-JP']);
    assert.equal(sc.config.explicit_decoding_config.encoding, 'LINEAR16');
    assert.equal(sc.config.explicit_decoding_config.sample_rate_hertz, 16000);
    assert.equal(sc.streaming_features.interim_results, true);
    assert.equal(fake.received.audioBytes, 32000);
    assert.equal(fake.received.maxChunk, 1280);

    const s = summaryOf(r.out);
    assert.equal(s.interim_available, true);
    assert.equal(s.stability.returned, true);
    assert.equal(s.multi_result_responses, 1);
    assert.equal(s.final_results, 2);
    assert.equal(s.speech_events[0].type, 'SPEECH_ACTIVITY_BEGIN');
    assert.equal(s.speech_events[0].offset_ms, 120);
    assert.equal(s.segment_boundary.snapshot_end_ms, 400);
  } finally {
    fake.stop();
  }
});

test('tts_probe single reads audio and alignment and never puts the key in the URL', async () => {
  const urls = [];
  const auth = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (ws, req) => {
    urls.push(req.url);
    auth.push(req.headers['xi-api-key']);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.flush) {
        ws.send(JSON.stringify({
          audio: Buffer.alloc(3200).toString('base64'),
          alignment: { chars: ['は', 'い'], charStartTimesMs: [0, 50], charDurationsMs: [50, 50] },
          normalizedAlignment: { chars: ['は', 'い'], charStartTimesMs: [0, 50], charDurationsMs: [50, 50] },
        }));
        ws.send(JSON.stringify({ isFinal: true }));
      }
    });
  });
  try {
    const r = await run('tts_probe.mjs', ['--mode', 'single', '--formats', 'pcm_16000', '--repeat', '1', '--text', 'はい', '--yes'], {
      ELEVENLABS_API_KEY: 'DUMMYKEY',
      ELEVENLABS_VOICE_ID: 'voice',
      ELEVENLABS_TEST_BASE: `ws://127.0.0.1:${wss.address().port}`,
    });
    assert.equal(r.code, 0, r.err);
    assert.ok(urls.every((u) => !u.includes('DUMMYKEY')));
    assert.ok(auth.every((a) => a === 'DUMMYKEY'));
    assert.match(urls[0], /stream-input\?model_id=eleven_flash_v2_5&output_format=pcm_16000/);
    assert.equal(r.out.includes('DUMMYKEY'), false);
    const group = summaryOf(r.out.slice(r.out.indexOf('{'))).groups['pcm_16000/auto_mode/"default"'];
    assert.equal(group.alignment_sample.raw.matches_input, true);
    assert.equal(group.first_audio_ms.n, 1);
  } finally {
    wss.close();
  }
});

test('gemini_probe parses both APIs, sends store:false and the current field names', async () => {
  const bodies = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      bodies.push({ url: req.url, body, key: req.headers['x-goog-api-key'] });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const json = '{"decision":"NONE","evidence_span":"","candidate_text":"","reason":""}';
      if (req.url.includes('interactions')) {
        res.write(`data: ${JSON.stringify({ event_type: 'step.delta', index: 0, delta: { type: 'text', text: json } })}\n\n`);
        res.end(`data: ${JSON.stringify({ event_type: 'interaction.completed', interaction: { usage: { total_input_tokens: 5 } } })}\n\n`);
      } else {
        res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: json }] } }], usageMetadata: { promptTokenCount: 5 } })}\n\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const r = await run('gemini_probe.mjs', ['--mode', 'latency', '--repeat', '1', '--gap-ms', '0', '--models', 'gemini-3.5-flash-lite:minimal', '--yes'], {
      GEMINI_API_KEY: 'DUMMYKEY',
      GEMINI_TEST_BASE: `http://127.0.0.1:${server.address().port}`,
    });
    assert.equal(r.code, 0, r.err);
    const [inter, gc] = bodies;
    assert.equal(inter.body.store, false);
    assert.equal(inter.body.generation_config.thinking_level, 'minimal');
    assert.equal(inter.body.response_format.mime_type, 'application/json');
    assert.match(gc.url, /:streamGenerateContent\?alt=sse/);
    assert.equal(gc.body.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
    assert.ok(gc.body.generationConfig.responseJsonSchema);
    assert.ok(bodies.every((b) => !b.url.includes('DUMMYKEY') && b.key === 'DUMMYKEY'));
    const rows = summaryOf(r.out).rows;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.ok, 1);
      assert.equal(row.valid_json_share, 1);
      assert.deepEqual(row.decisions, ['NONE']);
      assert.ok(row.usage_sample);
    }
  } finally {
    server.close();
  }
});
