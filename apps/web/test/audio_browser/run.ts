/**
 * 実ブラウザの音声試験（フェイクマイク、ヘッドレス Chromium）。
 *   npm run test:audio:browser -w @llm-vap/web
 * 実機のヘッドセットの検証ではない。結果は標準出力と AUDIO_RESULT_JSON のパスへ。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { FakeBrowserEchoServer } from '@llm-vap/testkit';
import { MeasureServer } from './measure_server';
import {
  addPulse,
  crossCorrelate,
  db,
  peakIndex,
  readWavMono16,
  resampleInt16,
  rms,
  sineFit,
  toneInt16,
  writeWavMono16,
} from './signal';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(webRoot, '../..');
const PORT = Number(process.env.AUDIO_TEST_PORT ?? 3461);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const results: Record<string, unknown> = {};
const failures: string[] = [];
function check(name: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  if (!ok) failures.push(name);
}

let browser: Browser;
const pageUrl = (ws: number) => `http://127.0.0.1:${PORT}/dev/audio?ws=${encodeURIComponent(`ws://127.0.0.1:${ws}`)}`;

async function openPage(wsPort: number): Promise<Page> {
  const page = await browser.newPage();
  page.on('pageerror', (e) => check('pageerror', false, String(e)));
  // tsx（esbuild の keepNames）が evaluate の関数へ __name を差し込むので受ける。
  await page.addInitScript('window.__name = (f) => f');
  await page.goto(pageUrl(wsPort), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__audioDev !== undefined);
  return page;
}

async function startMode(page: Page, mode: unknown, overrides: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(
    ([m, o]) => window.__audioDev!.start(m as never, o as never),
    [mode, overrides] as const,
  );
}

const lastReport = (s: MeasureServer) => s.ofType('audio.report').at(-1);

// ---- 1. dev:fakes のエコーと本物のクリック -------------------------------------
async function testFakeEcho(): Promise<void> {
  const fake = new FakeBrowserEchoServer({ echo: true });
  const port = await fake.start();
  const page = await openPage(port);
  await page.click('#start');
  await sleep(4000);
  const info = await page.evaluate(() => {
    const s = window.__audioDev!.session()!;
    return {
      rate: s.sampleRateHz,
      state: s.context.state,
      settings: s.trackSettings,
      latency: s.latencyHistory().at(-1),
      lat_samples: s.latencyHistory().length,
      stats: s.stats(),
      errors: window.__audioDev!.log.errors,
    };
  });
  await page.close();
  await fake.stop();
  const frames = fake.uplinkFrames;
  const contiguous = frames.every((f, i) => f.audio_frame === i * 320 && f.sample_count === 320);
  const hello = fake.received.find((m) => m.type === 'client.hello');
  const types = new Set(fake.received.map((m) => m.type));
  results.fake_echo = { frames: frames.length, info, types: [...types] };
  check('実クリックで AudioContext が 48kHz で running', info.rate === 48000 && info.state === 'running', info.rate);
  check('上り枠が 320 サンプルの連番', contiguous && frames.length > 150, `${frames.length} frames`);
  check(
    'getSettings の AEC/NS/AGC がすべて false',
    info.settings.echoCancellation.value === false &&
      info.settings.noiseSuppression.value === false &&
      info.settings.autoGainControl.value === false,
    info.settings,
  );
  check('client.hello を送った', hello !== undefined, '');
  check(
    '再生の報告が届く',
    types.has('playback.started') && types.has('playback.position') && types.has('audio.report'),
    [...types],
  );
  check('page のエラーなし', info.errors.length === 0, info.errors);
}

// ---- 2. 音声の往復 -------------------------------------------------------------
async function testRoundTrip(reference16k: Int16Array): Promise<void> {
  const server = new MeasureServer({ echo: true });
  const port = await server.start();
  const page = await openPage(port);
  await page.click('#start');
  await sleep(11_000);
  await page.close();
  const start = 16000 * 2;
  // 1 秒ごとに最も音量のある窓を選ぶ
  let window0 = start;
  let bestEnergy = 0;
  for (let at = start; at + 16000 < server.head - 16000; at += 8000) {
    const e = rms(server.mic, at, at + 16000);
    if (e > bestEnergy) {
      bestEnergy = e;
      window0 = at;
    }
  }
  const toRef = crossCorrelate(
    Int16Array.from(server.mic.subarray(window0, window0 + 16000)),
    0,
    16000,
    (() => {
      const doubled = new Int16Array(reference16k.length * 2);
      doubled.set(reference16k);
      doubled.set(reference16k, reference16k.length);
      return doubled;
    })(),
    0,
    reference16k.length - 1,
  );
  const micSys = crossCorrelate(server.mic, window0, 16000, server.sys, 0, 8000);
  const lagInt = Math.round(micSys.lag);
  let errSum = 0;
  let sigSum = 0;
  for (let i = 0; i < 16000; i++) {
    const a = server.mic[window0 + i] as number;
    const b = server.sys[window0 + i + lagInt] as number;
    errSum += (a - b) ** 2;
    sigSum += a ** 2;
  }
  const report = lastReport(server);
  results.round_trip = {
    mic_rms: bestEnergy,
    mic_vs_ja_wav_corr: toRef.corr,
    mic_to_sys_lag_samples: micSys.lag,
    mic_to_sys_ms: (micSys.lag / 16000) * 1000,
    mic_to_sys_corr: micSys.corr,
    residual_db: db(Math.sqrt(errSum / sigSum)),
    underruns: report?.underrun_count,
    underrun_ms: report?.underrun_total_ms,
    frames_lost: report?.frames_lost,
  };
  check('フェイクマイクの音が ja.wav と一致', toRef.corr > 0.95, toRef.corr.toFixed(4));
  check(
    '往復後の sys が mic と一致',
    micSys.corr > 0.95,
    `corr=${micSys.corr.toFixed(4)} lag=${((micSys.lag / 16000) * 1000).toFixed(1)}ms`,
  );
  check('契約違反なし', server.violations.length === 0, server.violations.slice(0, 3));
  await server.stop();
}

// ---- 3. FIR の周波数特性（実ブラウザの Worklet） ---------------------------------
async function measureTones(
  freqs: number[],
  amplitude: number,
): Promise<{ hz: number; level_db: number; alias_hz: number; alias_db: number; peak: number }[]> {
  const server = new MeasureServer();
  const port = await server.start();
  const page = await openPage(port);
  await startMode(page, { kind: 'oscillator', amplitude });
  await server.waitFor(() => server.frames.length > 10, 5000, 'frames');
  const table = [];
  for (const hz of freqs) {
    await page.evaluate((f) => {
      window.__audioDev!.oscillator()!.frequency.value = f;
    }, hz);
    await sleep(120);
    const from = server.head;
    await sleep(400);
    const to = server.head;
    const aliasHz = hz <= 8000 ? hz : hz <= 16000 ? 16000 - hz : hz - 16000;
    const fit = sineFit(server.mic, aliasHz, 16000, from, to);
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(server.mic[i] as number));
    table.push({
      hz,
      level_db: Number(db(rms(server.mic, from, to) / (amplitude * 32768 * Math.SQRT1_2)).toFixed(2)),
      alias_hz: aliasHz,
      alias_db: Number(db(fit.amp / (amplitude * 32768)).toFixed(2)),
      peak,
    });
  }
  await page.close();
  await server.stop();
  return table;
}

async function testFrequencyResponse(): Promise<void> {
  const pass = await measureTones([100, 300, 1000, 3000, 5000, 6000, 6500, 7000, 7250, 7500, 7750], 0.5);
  // 阻止域は Int16 の量子化に埋もれるので、グラフ内で振幅 16（通過域の測定より +30 dB）にして測る。
  // Web Audio の内部は float なので入力は飽和しない。出力が飽和していないことは peak で確かめる。
  const stop = await measureTones([8000, 8250, 8500, 9000, 10000, 11000, 12000, 14000, 15500, 16500, 18000, 20000, 22000, 23500], 16);
  results.frequency_response = { pass, stop };
  console.log('  hz | RMS dB | 成分 dB @ 折り返し先 | peak');
  for (const r of [...pass, ...stop]) console.log(`  ${r.hz} | ${r.level_db} | ${r.alias_db} @ ${r.alias_hz} | ${r.peak}`);
  const flat = pass.filter((r) => r.hz <= 7000);
  check('通過域（≤7kHz）は ±0.1 dB', flat.every((r) => Math.abs(r.level_db) < 0.1), flat.map((r) => r.level_db));
  check('阻止域（≥8kHz）の折り返しは -75 dB 以下', stop.every((r) => r.alias_db < -75 && r.peak < 32767), stop.map((r) => r.alias_db));
  // 全サンプル 0 の周波数は「-114 dB 未満」としか言えない。遷移帯域に近い所で値が取れていることを対照にする。
  check('阻止域の測定が量子化に埋もれていない（8〜12kHz）', stop.filter((r) => r.hz <= 12000).every((r) => r.peak > 0), stop.map((r) => r.peak));
}

// ---- 4. mic と sys の群遅延（DelayNode のループバックで既知の遅れを作る） --------------
async function testGroupDelay(delayFrames: number): Promise<void> {
  const server = new MeasureServer();
  const port = await server.start();
  const page = await openPage(port);
  await startMode(page, { kind: 'loopback', delayFrames });
  await server.waitFor(() => server.frames.length > 10, 5000, 'frames');
  const rate = 24000;
  const freqs = [200, 500, 1000, 2000, 3000, 4000, 5000, 6000, 6800];
  const segment = rate; // 1 秒ずつ
  const pcm = new Int16Array(freqs.length * segment + rate);
  freqs.forEach((f, i) => pcm.set(toneInt16(f, rate, segment), i * segment));
  // 最後の 1 秒は広帯域のノイズ（相互相関用）
  let seed = 12345;
  for (let i = freqs.length * segment; i < pcm.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    pcm[i] = Math.round(((seed / 2 ** 32) * 2 - 1) * 12000);
  }
  server.begin(1, 0, rate);
  server.pcm(1, 0, rate, pcm, { end: true });
  await server.waitFor(() => server.ofType('playback.ended').length > 0, 20_000, 'playback.ended');
  await sleep(200);
  const started = server.ofType('playback.started')[0];
  await page.close();
  await server.stop();
  if (!started) throw new Error('no playback.started');
  const a0 = started.audio_frame;
  // Web Audio の閉路は DelayNode の値に1量子（128）を足した遅れになる（FIR を通さない素の Worklet で実測して確認済み）。
  const expectedLag = ((delayFrames + 128) * 16000) / 48000;
  const perFreq: { hz: number; lag_samples: number; error_us: number }[] = [];
  const seg16 = (segment * 2) / 3;
  freqs.forEach((hz, i) => {
    const s = a0 + i * seg16 + 1600;
    const e = a0 + (i + 1) * seg16 - 1600;
    const sys = sineFit(server.sys, hz, 16000, s, e);
    const mic = sineFit(server.mic, hz, 16000, s, e);
    let lag = ((sys.phase - mic.phase) / (2 * Math.PI)) * (16000 / hz);
    const period = 16000 / hz;
    lag += Math.round((expectedLag - lag) / period) * period;
    perFreq.push({
      hz,
      lag_samples: Number(lag.toFixed(4)),
      error_us: Number((((lag - expectedLag) / 16000) * 1e6).toFixed(2)),
    });
  });
  const noiseStart = a0 + freqs.length * seg16 + 800;
  // 広帯域の相関は遅れが整数サンプルのときだけ 1 に近づく（非整数は放物線補間の偏りと相関低下が出る）。
  const integerLag = Number.isInteger(expectedLag);
  const xc = crossCorrelate(server.sys, noiseStart, 8000, server.mic, Math.floor(expectedLag) - 16, Math.ceil(expectedLag) + 16);
  results[`group_delay_${delayFrames}`] = {
    expected_lag_samples: expectedLag,
    per_frequency: perFreq,
    noise_xcorr_lag: xc.lag,
    noise_corr: xc.corr,
    sys_rms: rms(server.sys, a0, a0 + 16000),
    mic_rms: rms(server.mic, a0 + 200, a0 + 16000),
  };
  const worst = Math.max(...perFreq.map((p) => Math.abs(p.error_us)));
  check(
    `mic-sys の群遅延差（既知の遅れ ${delayFrames} フレーム）`,
    worst < 5 && (!integerLag || (Math.abs(xc.lag - expectedLag) < 0.01 && xc.corr > 0.999)),
    `最大 ${worst.toFixed(2)}us, 広帯域 lag=${xc.lag.toFixed(3)} 期待=${expectedLag.toFixed(3)} corr=${xc.corr.toFixed(4)}`,
  );
}

// ---- 5. 再生位置の精度 -----------------------------------------------------------
async function testPosition(rate: number): Promise<void> {
  const server = new MeasureServer();
  const port = await server.start();
  const page = await openPage(port);
  await startMode(page, { kind: 'oscillator', amplitude: 0 }, { positionIntervalMs: 50 });
  await server.waitFor(() => server.frames.length > 10, 5000, 'frames');
  const n = rate * 3;
  const pcm = new Int16Array(n);
  const marks = [0.25, 0.75, 1.5, 2.0, 2.75].map((s) => Math.round(s * rate));
  for (const k of marks) addPulse(pcm, k);
  // 先頭サンプルも無音でないように小さな値を入れない（started は書き込みで決まる）
  server.begin(7, 0, rate);
  server.pcm(7, 0, rate, pcm, { end: true });
  await server.waitFor(() => server.ofType('playback.ended').length > 0, 10_000, 'ended');
  await sleep(100);
  const started = server.ofType('playback.started')[0]!;
  const ended = server.ofType('playback.ended')[0]!;
  const positions = server.ofType('playback.position');
  const report = lastReport(server);
  await page.close();
  await server.stop();
  const a0 = started.audio_frame;
  const errors = marks.map((k) => {
    const expected = a0 + (k * 16000) / rate;
    const at = peakIndex(server.sys, Math.round(expected) - 200, Math.round(expected) + 200);
    return Number((at - expected).toFixed(3));
  });
  const positionSkew = positions.map((p) => p.samples_written - (p.audio_frame - a0));
  // client_t_ms とサンプル位置の直線からの残差
  const xs = positions.map((p) => p.samples_written / 16);
  const ys = positions.map((p) => p.client_t_ms);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
    sxx += ((xs[i] as number) - mx) ** 2;
  }
  const slope = sxy / sxx;
  const residuals = xs.map((x, i) => (ys[i] as number) - (my + slope * (x - mx)));
  const maxResidual = Math.max(...residuals.map(Math.abs));
  const expectedTotal = Math.ceil((n * 48000) / rate);
  const expected16k = Math.floor((expectedTotal * 16000) / 48000);
  results[`position_${rate}`] = {
    click_error_samples: errors,
    position_skew_samples: { min: Math.min(...positionSkew), max: Math.max(...positionSkew) },
    position_reports: positions.length,
    ended_samples_written: ended.samples_written,
    expected_samples_written: expected16k,
    client_t_slope: slope,
    client_t_max_residual_ms: maxResidual,
    underruns: report?.underrun_count,
  };
  check(`${rate}Hz: 目印の位置の誤差 ≤ 1 サンプル(16kHz)`, errors.every((e) => Math.abs(e) <= 1), errors);
  check(
    `${rate}Hz: samples_written と audio_frame の差 ≤ 1`,
    positionSkew.every((d) => Math.abs(d) <= 1),
    `min=${Math.min(...positionSkew)} max=${Math.max(...positionSkew)} n=${positions.length}`,
  );
  check(`${rate}Hz: ended の samples_written`, ended.samples_written === expected16k && ended.reason === 'completed', `${ended.samples_written}/${expected16k}`);
  check(`${rate}Hz: client_t_ms の直線性`, maxResidual < 15, `最大残差 ${maxResidual.toFixed(2)}ms, 傾き ${slope.toFixed(5)}`);
}

// ---- 6. 世代と停止 ----------------------------------------------------------------
async function testGenerations(): Promise<void> {
  const server = new MeasureServer();
  const port = await server.start();
  const page = await openPage(port);
  await startMode(page, { kind: 'oscillator', amplitude: 0 });
  await server.waitFor(() => server.frames.length > 10, 5000, 'frames');
  const rate = 24000;
  server.begin(10, 1, rate);
  server.pcm(10, 1, rate, toneInt16(1000, rate, rate * 3));
  await server.waitFor(() => server.ofType('playback.started').length > 0, 5000, 'started');
  await sleep(500);
  const stopSent = server.now();
  server.send({ type: 'playback.stop', audio_playback_id: 10, generation: 2, stop: { mode: 'immediate' }, reason: 'test' });
  // 世代の古いチャンク（3kHz）と、古い世代の begin を、停止の後に送る
  server.pcm(10, 1, rate, toneInt16(3000, rate, rate), { startSeq: 1000 });
  server.begin(11, 1, rate);
  server.pcm(11, 1, rate, toneInt16(3000, rate, rate));
  const staleFrames = Math.ceil(rate / 480) * 2; // PCM 枠のみ。begin は含めない
  await sleep(300);
  // 新しい世代（500Hz）は流れる
  server.begin(12, 2, rate);
  server.pcm(12, 2, rate, toneInt16(500, rate, rate / 2), { end: true });
  await server.waitFor(() => server.ofType('playback.ended').length >= 2, 5000, 'ended x2');
  await sleep(1200);
  const report = lastReport(server)!;
  const estimate = await page.evaluate(() => window.__audioDev!.session()!.clockEstimate());
  await page.close();
  await server.stop();
  const started10 = server.ofType('playback.started').find((m) => m.audio_playback_id === 10)!;
  const ended10 = server.ofType('playback.ended').find((m) => m.audio_playback_id === 10)!;
  const ended12 = server.ofType('playback.ended').find((m) => m.audio_playback_id === 12)!;
  const endAt = started10.audio_frame + ended10.samples_written;
  const after = sineFit(server.sys, 3000, 16000, endAt + 80, server.head);
  // 停止位置: 1kHz が切れる実測の位置
  let lastLoud = started10.audio_frame;
  for (let i = started10.audio_frame; i < endAt + 3200; i += 1) {
    if (Math.abs(server.sys[i] as number) > 300) lastLoud = i;
  }
  const stopCut = lastLoud - endAt;
  const stopLatencyMs =
    estimate === null ? null : ended10.client_t_ms + estimate.offset_ms - stopSent;
  results.generations = {
    stale_reported: report.stale_pcm_frames_dropped,
    stale_sent: staleFrames,
    energy_3k_after_stop_db: db(after.amp / 32768),
    ended_10: ended10,
    ended_12: ended12,
    stop_cut_error_samples: stopCut,
    stop_latency_ms: stopLatencyMs,
  };
  check('世代違いの音が sys に出ない（3kHz 成分）', db(after.amp / 32768) < -75, `${db(after.amp / 32768).toFixed(1)} dBFS`);
  check('古い世代のチャンクを数えた', report.stale_pcm_frames_dropped === staleFrames, `${report.stale_pcm_frames_dropped}/${staleFrames}`);
  check('停止した再生は stopped、次の世代は completed', ended10.reason === 'stopped' && ended12.reason === 'completed', [ended10.reason, ended12.reason]);
  check('samples_written が実際に切れた位置と一致', Math.abs(stopCut) <= 48, `差 ${stopCut} サンプル`);
  check('samples_written+discarded が送った量に近い', Math.abs(ended10.samples_written + ended10.samples_discarded - 48000) < 200, ended10.samples_written + ended10.samples_discarded);
  console.log(`  停止命令の送信→書き込み停止: ${stopLatencyMs?.toFixed(1)} ms`);
}

async function testGentleStops(): Promise<void> {
  const server = new MeasureServer();
  const port = await server.start();
  const page = await openPage(port);
  await startMode(page, { kind: 'oscillator', amplitude: 0 });
  await server.waitFor(() => server.frames.length > 10, 5000, 'frames');
  const rate = 24000;
  // fade
  server.begin(20, 0, rate);
  server.pcm(20, 0, rate, toneInt16(1000, rate, rate * 3));
  await server.waitFor(() => server.ofType('playback.started').length > 0, 5000, 'started');
  await sleep(400);
  server.send({ type: 'playback.stop', audio_playback_id: 20, generation: 1, stop: { mode: 'fade', fade_ms: 50 }, reason: 'test' });
  await server.waitFor(() => server.ofType('playback.ended').length > 0, 5000, 'ended');
  // at_sample
  server.begin(21, 1, rate);
  server.pcm(21, 1, rate, toneInt16(1000, rate, rate * 3));
  await server.waitFor(() => server.ofType('playback.started').length > 1, 5000, 'started2');
  server.send({
    type: 'playback.stop',
    audio_playback_id: 21,
    generation: 2,
    stop: { mode: 'at_sample', stop_at_sample: 16000, fade_ms: 20, deadline_ms: 5000 },
    reason: 'test',
  });
  await server.waitFor(() => server.ofType('playback.ended').length > 1, 5000, 'ended2');
  await sleep(200);
  await page.close();
  await server.stop();
  const fadeEnd = server.ofType('playback.ended')[0]!;
  const atEnd = server.ofType('playback.ended')[1]!;
  const atStart = server.ofType('playback.started')[1]!;
  results.gentle_stops = { fade: fadeEnd, at_sample: atEnd };
  const atExpected = 16000 + 320;
  check('at_sample は指定位置＋fade で止まる', Math.abs(atEnd.samples_written - atExpected) <= 1, `${atEnd.samples_written} 期待 ${atExpected}`);
  check('at_sample の後は無音', rms(server.sys, atStart.audio_frame + atEnd.samples_written + 40, atStart.audio_frame + atEnd.samples_written + 1600) < 2, '');
  check('fade は stopped', fadeEnd.reason === 'stopped', fadeEnd.reason);
}

// ---- 7. アンダーラン ----------------------------------------------------------------
async function testUnderrun(): Promise<void> {
  const server = new MeasureServer();
  const port = await server.start();
  const page = await openPage(port);
  await startMode(page, { kind: 'oscillator', amplitude: 0 });
  await server.waitFor(() => server.frames.length > 10, 5000, 'frames');
  const rate = 24000;
  const chunk = 480; // 20ms
  const total = rate;
  server.begin(30, 0, rate);
  const tone = toneInt16(1000, rate, total * 2);
  let seq = 0;
  // 実時間の間隔で 1 秒送り、300ms 止めて、残りを送る
  for (let i = 0; i < total; i += chunk) {
    seq = server.pcm(30, 0, rate, tone.subarray(i, i + chunk), { startSeq: seq, chunk });
    await sleep(18);
  }
  await sleep(500);
  for (let i = total; i < total * 2; i += chunk) {
    seq = server.pcm(30, 0, rate, tone.subarray(i, i + chunk), {
      startSeq: seq,
      chunk,
      end: i + chunk >= total * 2,
    });
    await sleep(18);
  }
  await server.waitFor(() => server.ofType('playback.ended').length > 0, 8000, 'ended');
  await sleep(1200);
  const report = lastReport(server)!;
  await page.close();
  await server.stop();
  const started = server.ofType('playback.started')[0]!;
  const ended = server.ofType('playback.ended')[0]!;
  // sys の無音区間を実測
  let silent = 0;
  const hop = 16;
  for (let i = started.audio_frame; i + hop < ended.audio_frame; i += hop) {
    if (rms(server.sys, i, i + hop) < 50) silent += hop;
  }
  const silentMs = silent / 16;
  results.underrun = {
    reported_count: report.underrun_count,
    reported_ms: report.underrun_total_ms,
    measured_silent_ms: silentMs,
    samples_written: ended.samples_written,
    expected_written: ((total * 2) / 3) * 1,
  };
  check('アンダーランを検出', report.underrun_count >= 1, `${report.underrun_count} 回`);
  check('報告の長さが実測の無音と一致（±15ms）', Math.abs(report.underrun_total_ms - silentMs) <= 15, `報告 ${report.underrun_total_ms.toFixed(1)}ms 実測 ${silentMs.toFixed(1)}ms`);
  check('無音は位置に入らない', Math.abs(ended.samples_written - (total * 2 * 2) / 3) <= 1, `${ended.samples_written}`);
}

// ---- 8. 上りの欠損（切断と再接続） ---------------------------------------------------
async function testFramesLost(): Promise<void> {
  const server = new MeasureServer();
  const port = await server.start();
  const page = await openPage(port);
  await startMode(page, { kind: 'oscillator', amplitude: 0.1 });
  await server.waitFor(() => server.frames.length > 100, 5000, 'frames');
  server.begin(40, 0, 24000);
  server.pcm(40, 0, 24000, toneInt16(800, 24000, 24000 * 5));
  await server.waitFor(() => server.ofType('playback.started').length > 0, 5000, 'started');
  await sleep(300);
  server.dropConnection();
  await server.waitFor(() => server.connections === 2 && server.gaps().length > 0, 10_000, 'reconnect');
  await sleep(1500);
  const report = lastReport(server)!;
  const gaps = server.gaps();
  const lostByNumbers = gaps.reduce((a, g) => a + (g.to - g.from) / 320, 0);
  const hellos = server.ofType('client.hello');
  const stats = await page.evaluate(() => window.__audioDev!.session()!.stats());
  await page.close();
  await server.stop();
  results.frames_lost = { gaps, lost_by_numbers: lostByNumbers, reported: report.frames_lost, second_hello_session: hellos[1]?.session_id, stats };
  check('欠損の報告が番号の飛びと一致', report.frames_lost === lostByNumbers && lostByNumbers > 0, `報告 ${report.frames_lost} 番号の飛び ${lostByNumbers} 枠`);
  check('再接続の hello が同じ session_id', hellos[1]?.session_id.value === 'measure_session', hellos[1]?.session_id);
}

// ---- 9. 主スレッドを止めても音声が止まらない --------------------------------------
async function testMainThreadBlock(): Promise<void> {
  const server = new MeasureServer();
  const port = await server.start();
  const page = await openPage(port);
  await startMode(page, { kind: 'oscillator', amplitude: 0.1 });
  await server.waitFor(() => server.frames.length > 50, 5000, 'frames');
  const rate = 24000;
  server.begin(50, 0, rate);
  server.pcm(50, 0, rate, toneInt16(600, rate, rate * 4), { end: true });
  await server.waitFor(() => server.ofType('playback.started').length > 0, 5000, 'started');
  const t0 = server.now();
  await page.evaluate(() => {
    const until = performance.now() + 1500;
    while (performance.now() < until) {
      /* 主スレッドを止める */
    }
  });
  const t1 = server.now();
  await sleep(1200);
  const report = lastReport(server)!;
  await page.close();
  await server.stop();
  const during = server.frames.filter((f) => f.at >= t0 && f.at <= t1);
  let maxGap = 0;
  for (let i = 1; i < during.length; i++) {
    maxGap = Math.max(maxGap, (during[i] as { at: number }).at - (during[i - 1] as { at: number }).at);
  }
  results.main_thread_block = { blocked_ms: t1 - t0, frames_during: during.length, max_interarrival_ms: maxGap, underruns: report.underrun_count, frames_lost: report.frames_lost };
  check('主スレッド停止中も枠が届く', during.length > 50 && maxGap < 120, `${during.length} 枠、最大間隔 ${maxGap.toFixed(1)}ms`);
  check('主スレッド停止でアンダーランと欠損なし', report.underrun_count === 0 && report.frames_lost === 0, { underrun: report.underrun_count, lost: report.frames_lost });
}

// ---- 10. statechange / visibilitychange -----------------------------------------
async function testLifecycle(): Promise<void> {
  const server = new MeasureServer();
  const port = await server.start();
  const page = await openPage(port);
  await startMode(page, { kind: 'oscillator', amplitude: 0.1 });
  await server.waitFor(() => server.frames.length > 10, 5000, 'frames');
  await sleep(300);
  await page.evaluate(() => window.__audioDev!.session()!.context.suspend());
  await sleep(500);
  // ヘッドレスでは実際のタブ切替で hidden にできないので、visibilityState を差し替えてイベントを発生させる。
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(200);
  const lifecycle = await page.evaluate(() => window.__audioDev!.session()!.lifecycleHistory());
  const state = await page.evaluate(() => window.__audioDev!.session()!.context.state);
  await page.close();
  await server.stop();
  const reports = server.ofType('audio.report');
  const sawSuspended = reports.some((r) => r.audio_context_state === 'suspended');
  const sawHidden = reports.some((r) => r.visibility === 'hidden');
  results.lifecycle = { lifecycle, state_after: state };
  check('statechange を記録して audio.report へ', sawSuspended, lifecycle);
  check('visibilitychange（模擬）を記録して audio.report へ', sawHidden, '');
  check('suspend の後に自動で resume する', state === 'running', state);
}

// ---- 11. 時計差 --------------------------------------------------------------------
async function testClock(pongDelayMs: number): Promise<void> {
  const server = new MeasureServer({ pongDelayMs });
  const port = await server.start();
  const page = await openPage(port);
  await startMode(page, { kind: 'oscillator', amplitude: 0 });
  await server.waitFor(() => server.ofType('clock.ping').length >= 6, 5000, 'pings');
  await sleep(300);
  const browserSide = await page.evaluate(() => {
    const est = window.__audioDev!.session()!.clockEstimate();
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) samples.push(Date.now() - (performance.timeOrigin + performance.now()));
    return { est, origin: performance.timeOrigin, wallSkew: samples.reduce((a, b) => a + b, 0) / samples.length };
  });
  const nodeSamples: number[] = [];
  for (let i = 0; i < 200; i++) nodeSamples.push(Date.now() - (performance.timeOrigin + performance.now()));
  const nodeSkew = nodeSamples.reduce((a, b) => a + b, 0) / nodeSamples.length;
  await page.close();
  await server.stop();
  const est = browserSide.est!;
  // 同じ機械なので真の差は wall clock で分かる（分解能 1ms 程度）。
  const truth = browserSide.origin + browserSide.wallSkew - server.originMs - nodeSkew;
  const error = est.offset_ms - truth;
  results[`clock_delay_${pongDelayMs}`] = { estimate: est, truth, error_ms: error };
  check(
    `時計差（pong 遅延 ${pongDelayMs}ms）`,
    Math.abs(error) <= est.uncertainty_ms + 2,
    `推定誤差 ${error.toFixed(2)}ms、uncertainty ${est.uncertainty_ms.toFixed(2)}ms、RTT ${est.rtt_ms.toFixed(2)}ms`,
  );
}

// ---- 12. 連続運転（ずれと欠損） ------------------------------------------------------
async function testSoak(seconds: number): Promise<void> {
  const server = new MeasureServer({ echo: true });
  const port = await server.start();
  const page = await openPage(port);
  await page.click('#start');
  await server.waitFor(() => server.frames.length > 100, 5000, 'frames');
  const t0 = server.now();
  const f0 = server.head;
  await sleep(seconds * 1000);
  const t1 = server.now();
  const f1 = server.head;
  const stats = await page.evaluate(() => window.__audioDev!.session()!.stats());
  const clockEst = await page.evaluate(() => window.__audioDev!.session()!.clockEstimate());
  const latencies = await page.evaluate(() => window.__audioDev!.session()!.latencyHistory().slice(-3));
  await page.close();
  const report = lastReport(server)!;
  const started = server.ofType('playback.started')[0]!;
  const positions = server.ofType('playback.position').filter((p) => p.samples_written > 16000 * 5);
  const skews = positions.map((p) => p.samples_written - (p.audio_frame - started.audio_frame));
  const xs = positions.map((p) => p.samples_written / 16);
  const ys = positions.map((p) => p.client_t_ms);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
    sxx += ((xs[i] as number) - mx) ** 2;
  }
  const slope = sxy / sxx;
  const residual = xs.map((x, i) => Math.abs((ys[i] as number) - (my + slope * (x - mx))));
  residual.sort((a, b) => a - b);
  const arrivals: number[] = [];
  for (let i = 1; i < server.frames.length; i++) {
    arrivals.push((server.frames[i] as { at: number }).at - (server.frames[i - 1] as { at: number }).at);
  }
  arrivals.sort((a, b) => a - b);
  const ppm = (((f1 - f0) / 16000) * 1000 / (t1 - t0) - 1) * 1e6;
  const xcStart = Math.floor(server.head * 0.8);
  // 終盤でも往復の遅れが変わらないこと
  let w = xcStart;
  let best = 0;
  for (let at = xcStart - 16000 * 8; at < xcStart; at += 8000) {
    const e = rms(server.mic, at, at + 16000);
    if (e > best) {
      best = e;
      w = at;
    }
  }
  const late = crossCorrelate(server.mic, w, 16000, server.sys, 0, 4000);
  results.soak = {
    seconds,
    frames: server.frames.length,
    gaps: server.gaps().length,
    frames_lost: report.frames_lost,
    underrun_count: report.underrun_count,
    underrun_ms: report.underrun_total_ms,
    render_vs_wall_ppm: ppm,
    render_lag_ms: stats?.render_lag_ms,
    uplink_arrival_ms: { p50: arrivals[Math.floor(arrivals.length * 0.5)], p99: arrivals[Math.floor(arrivals.length * 0.99)], max: arrivals.at(-1) },
    position_skew: { min: Math.min(...skews), max: Math.max(...skews), n: skews.length },
    client_t_residual_ms: { p50: residual[Math.floor(residual.length * 0.5)], p99: residual[Math.floor(residual.length * 0.99)], max: residual.at(-1) },
    round_trip_late_ms: late.lag / 16,
    round_trip_late_corr: late.corr,
    clock: clockEst,
    latency_tail: latencies,
  };
  await server.stop();
  console.log(JSON.stringify(results.soak));
  check('連続運転で欠損なし', report.frames_lost === 0 && server.gaps().length === 0, report.frames_lost);
  check('連続運転でアンダーランなし', report.underrun_count === 0, `${report.underrun_count} 回 ${report.underrun_total_ms.toFixed(1)}ms`);
  check('連続運転で位置と audio_frame の差 ≤ 1', skews.every((d) => Math.abs(d) <= 1), `${Math.min(...skews)}..${Math.max(...skews)}`);
  check('上りの枠の連番', server.frames.every((f, i) => f.audio_frame === i * 320), '');
}

// ---- 全体 -------------------------------------------------------------------------
async function main(): Promise<void> {
  const workDir = await mkdtemp(path.join(process.env.AUDIO_TEST_WORKDIR ?? tmpdir(), 'audio-browser-'));
  const source = await readWavMono16(path.join(repoRoot, 'models/ja.wav'));
  const wav48 = resampleInt16(source.samples, source.rate, 48000);
  const reference16k = resampleInt16(source.samples, source.rate, 16000);
  const fakeWav = path.join(workDir, 'ja_48k.wav');
  await writeWavMono16(fakeWav, 48000, wav48);

  let next: ChildProcess | null = null;
  try {
    next = spawn(path.join(repoRoot, 'node_modules/.bin/next'), ['dev', '-p', String(PORT), '--hostname', '127.0.0.1'], {
      cwd: webRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    });
    next.stderr?.on('data', (d: Buffer) => process.env.AUDIO_TEST_VERBOSE && process.stderr.write(d));
    const deadline = Date.now() + 60_000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/worklets/duplex.worklet.js`);
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* まだ */
      }
      await sleep(300);
    }
    if (!up) throw new Error('next dev did not start');

    browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${fakeWav}`,
      ],
    });
    results.browser = browser.version();

    const only = process.env.AUDIO_TEST_ONLY?.split(',');
    const tests: [string, () => Promise<void>][] = [
      ['fake_echo', testFakeEcho],
      ['round_trip', () => testRoundTrip(reference16k)],
      ['frequency', testFrequencyResponse],
      ['group_delay_144', () => testGroupDelay(144)],
      ['group_delay_136', () => testGroupDelay(136)],
      ['position_24k', () => testPosition(24000)],
      ['position_16k', () => testPosition(16000)],
      ['position_22k', () => testPosition(22050)],
      ['generations', testGenerations],
      ['gentle', testGentleStops],
      ['underrun', testUnderrun],
      ['frames_lost', testFramesLost],
      ['main_block', testMainThreadBlock],
      ['lifecycle', testLifecycle],
      ['clock_0', () => testClock(0)],
      ['clock_30', () => testClock(30)],
      ['soak', () => testSoak(Number(process.env.AUDIO_SOAK_SECONDS ?? 60))],
    ];
    for (const [name, test] of tests) {
      if (only && !only.includes(name)) continue;
      console.log(`\n== ${name}`);
      try {
        await test();
      } catch (error) {
        check(name, false, String(error));
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
    if (next?.pid) {
      try {
        process.kill(-next.pid, 'SIGTERM'); // 自分が起動したプロセスグループのみ
      } catch {
        /* 既に終了 */
      }
    }
  }
  const out = process.env.AUDIO_RESULT_JSON ?? path.join(workDir, 'results.json');
  await writeFile(out, JSON.stringify(results, null, 2));
  console.log(`\nresults: ${out}`);
  console.log(failures.length === 0 ? 'ALL PASSED' : `FAILED: ${failures.join(', ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
