/**
 * G1 の自動部分の E2E（レーン J）。重いので vitest には入れない。
 *   npm run test:e2e                 台本のプロバイダ（test_double）＋実 MaAI
 *   E2E_REAL=1 E2E_SECONDS=40 npm run test:e2e   実 STT／Gemini／TTS（費用がかかる）
 *
 * 経路: ヘッドレス Chromium（フェイクマイク = models/ja.wav ＋無音の繰り返し）→ 参加者画面 → WS → Node の
 * Session → 実 MaAI ワーカー（.venv）→ TurnManager → プロバイダ → PCM → Worklet の再生 → 口の動き。
 *
 * 実機のヘッドセットの検証ではない。フェイクマイクは同じ音声の繰り返しで、人の会話の頻度や遅延を表さない。
 * 台本のプロバイダの結果は認識・応答・合成の性能ではない（計画 §4.5a）。
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import type { ResearchEvent } from '@llm-vap/contracts';
import { SystemTimeSource } from '@llm-vap/contracts';
import { loadDotEnv, readConfig } from '../../src/app/config';
import { DEFAULT_SCRIPTED_REPLY } from '../../src/app/scripted';
import { createMaaiClient } from '../../src/app/maai_setup';
import { OrchestratorServer, SwitchableTimeSource } from '../../src/ws/server';
import type { Session } from '../../src/session/session';
import { controlSettings, type GazeSettings } from '../../src/control';
import { checkLog } from '../../../../tools/log_check/check';
import { readWavMono16, resampleInt16, writeWavMono16 } from '../../../web/test/audio_browser/signal';

/** apps/web/app/(participant)/page.tsx の window.__participant（ここで使う分だけ）。 */
interface ParticipantHandle {
  controller: {
    current(): {
      link: string;
      trackSettings: { echoCancellation: { value: boolean | null }; noiseSuppression: { value: boolean | null }; autoGainControl: { value: boolean | null } } | null;
      [key: string]: unknown;
    };
    record: { mouthOpenWhilePlaying: number; mouthSamplesWhilePlaying: number; maxMouthOpen: number; gazeReports: { target: string; visible: boolean; client_t_ms: { value: number | null } }[]; gazeCommands: { target: string; client_t_ms: number }[]; messages: string[]; breathCommands: { type: string; breath: boolean }[]; signalReports: { phase: string }[] };
  };
  avatar(): unknown;
  avatarError(): string | null;
}
declare global {
  interface Window {
    __participant?: ParticipantHandle;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const webRoot = path.join(repoRoot, 'apps/web');
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3471);
const ORCH_PORT = Number(process.env.E2E_ORCH_PORT ?? 8797);
const REAL = process.env.E2E_REAL === '1';
const MAIN_SECONDS = Number(process.env.E2E_SECONDS ?? (REAL ? 40 : 75));
const SILENCE_S = Number(process.env.E2E_SILENCE_S ?? 12);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: Record<string, unknown> = { real_providers: REAL };
const failures: string[] = [];
function check(name: string, ok: boolean, detail: unknown): void {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${text}`);
  (results.checks ??= [] as unknown[]) as unknown[];
  (results.checks as unknown[]).push({ name, ok, detail });
  if (!ok) failures.push(name);
}

function readEvents(file: string): ResearchEvent[] {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as ResearchEvent);
}

type Ev<N extends ResearchEvent['event']> = Extract<ResearchEvent, { event: N }>;
const ofType = <N extends ResearchEvent['event']>(events: ResearchEvent[], name: N) =>
  events.filter((e): e is Ev<N> => e.event === name);

/** ブラウザと子プロセスの優先度を下げる（G0 の実測で、ソフトウェア描画が MaAI を詰まらせたため）。 */
function reniceTree(pid: number): void {
  const all = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length > 0) {
    const p = queue.pop() as number;
    try {
      const out = execFileSync('pgrep', ['-P', String(p)], { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        const child = Number(line.trim());
        if (child > 0 && !all.has(child)) {
          all.add(child);
          queue.push(child);
        }
      }
    } catch {
      /* 子なし */
    }
  }
  try {
    execFileSync('renice', ['-n', '15', '-p', ...[...all].map(String)], { stdio: 'ignore' });
  } catch {
    /* 失敗しても続ける */
  }
}

async function waitFor<T>(what: string, fn: () => T | null | undefined | false, timeoutMs: number, stepMs = 100): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value as T;
    await sleep(stepMs);
  }
  console.log(`  (timeout waiting for ${what})`);
  return null;
}

async function startNext(): Promise<ChildProcess> {
  const next = spawn(path.join(repoRoot, 'node_modules/.bin/next'), ['dev', '-p', String(WEB_PORT), '--hostname', '127.0.0.1'], {
    cwd: webRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  next.stderr?.on('data', (d: Buffer) => process.env.E2E_VERBOSE && process.stderr.write(d));
  const ok = await (async () => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${WEB_PORT}/worklets/duplex.worklet.js`);
        if (r.ok) return true;
      } catch {
        /* まだ */
      }
      await sleep(300);
    }
    return false;
  })();
  if (!ok) throw new Error('next dev did not start');
  return next;
}

async function openParticipant(browser: Browser, query = ''): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
  page.on('pageerror', (e) => console.log(`  pageerror: ${String(e)}`));
  await page.addInitScript('window.__name = (f) => f');
  // 初回は Next のコンパイルで時間がかかる。
  await page.goto(`http://127.0.0.1:${WEB_PORT}/?ws=${encodeURIComponent(`ws://127.0.0.1:${ORCH_PORT}/ws`)}${query}`, {
    waitUntil: 'load',
    timeout: 120_000,
  });
  await page.waitForFunction(() => window.__participant !== undefined, undefined, { timeout: 120_000 });
  await page.waitForFunction(() => window.__participant!.avatar() !== null || window.__participant!.avatarError() !== null, undefined, {
    timeout: 120_000,
  });
  return page;
}

async function main(): Promise<void> {
  loadDotEnv();
  const workDir = await mkdtemp(path.join(process.env.E2E_WORKDIR ?? tmpdir(), 'e2e-'));
  results.work_dir = workDir;
  console.log(`work dir: ${workDir}`);

  // フェイクマイク: ja.wav（約 8.2 秒）＋無音。Chromium はこのファイルを繰り返す。
  const source = await readWavMono16(path.join(repoRoot, 'models/ja.wav'));
  const speech48 = resampleInt16(source.samples, source.rate, 48000);
  const mic = new Int16Array(speech48.length + SILENCE_S * 48000);
  mic.set(speech48, 0);
  const fakeWav = path.join(workDir, 'fake_mic_48k.wav');
  await writeWavMono16(fakeWav, 48000, mic);
  results.fake_mic = { file: fakeWav, speech_s: speech48.length / 48000, silence_s: SILENCE_S };

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SESSIONS_DIR: path.join(workDir, 'sessions'),
    ORCHESTRATOR_PORT: String(ORCH_PORT),
    ORCHESTRATOR_HOST: '127.0.0.1',
    ALLOWED_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
    SESSION_RESUME_GRACE_MS: '20000',
    // 台本では、2つ目のセッション（initiative_inhale）だけ STT が安定テキストを出し、判定の LLM が NEW を返す（app/scripted.ts）。
    ...(REAL
      ? {}
      : { STT_PROVIDER_CLASS: 'test_double', TTS_PROVIDER_CLASS: 'test_double', LLM_PROVIDER_CLASS: 'test_double', SCRIPTED_INITIATIVE: 'new_on_input' }),
  };
  const config = readConfig(env);
  results.providers = { stt: config.stt, tts: config.tts, llm: config.llm, maai: 'real (.venv)' };

  const maaiTime = new SwitchableTimeSource(new SystemTimeSource());
  const maai = createMaaiClient({ policy: config.policy, time: maaiTime, env: { ...process.env, MAAI_WORKER_URL: 'ws://127.0.0.1:0' }, port: 0 });
  const bootStart = Date.now();
  const firstOutcome = maai.start(`e2e-boot-${Date.now()}`);
  const server = new OrchestratorServer({ config, maai, maaiTime, env, log: (m) => console.log(`  [orch] ${m}`) });
  await server.listen();

  let next: ChildProcess | null = null;
  let browser: Browser | null = null;
  try {
    const availability = await firstOutcome;
    results.maai_boot = { state: availability.state, reason: availability.reason, ms: Date.now() - bootStart, ready: maai.ready() };
    check('実 MaAI ワーカーが READY（is_fake=false）', availability.state === 'ready' && maai.ready()?.is_fake === false, results.maai_boot);

    next = await startNext();
    browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${fakeWav}`],
    });
    const browserPid = (browser as unknown as { process?: () => ChildProcess | null }).process?.()?.pid;

    // ---- 1. 通常の対話 -------------------------------------------------------------
    let page = await openParticipant(browser);
    if (browserPid) reniceTree(browserPid);
    results.avatar_error = await page.evaluate(() => window.__participant!.avatarError());
    await page.click('#start');
    const session1 = await waitFor('session', () => server.current(), 30_000);
    if (session1 === null) throw new Error('session did not start');
    if (browserPid) reniceTree(browserPid);
    console.log(`  session 1: ${session1.session_id}; running ${MAIN_SECONDS}s`);
    await sleep(MAIN_SECONDS * 1000);
    const view1 = await page.evaluate(() => {
      const c = window.__participant!.controller;
      // 主スレッドの時間軸で、gaze.command の受信から描画の報告までの遅れ（目標が変わったものだけ）。
      // 報告は目標の変化ごとに順に出るので、前から順に対応づける。描画前に上書きされたものは 'superseded'。
      const delays: (number | 'superseded' | null)[] = [];
      let prev: string = 'user';
      let cursor = 0;
      for (const cmd of c.record.gazeCommands) {
        if (cmd.target === prev) continue;
        prev = cmd.target;
        const i = c.record.gazeReports.findIndex((r, j) => j >= cursor && r.target === cmd.target);
        if (i < 0) {
          delays.push(null);
          continue;
        }
        cursor = i + 1;
        const r = c.record.gazeReports[i]!;
        delays.push(r.visible && r.client_t_ms.value !== null ? r.client_t_ms.value - cmd.client_t_ms : 'superseded');
      }
      return { view: c.current(), gazeCommandToRenderMs: delays, record: { ...c.record, gazeReports: c.record.gazeReports.length, gazeCommands: c.record.gazeCommands.length } };
    });
    results.participant_view_1 = view1;
    check('参加者画面: リンクが ready', view1.view.link === 'ready', view1.view.link);
    check('参加者画面: AEC/NS/AGC が false で返る', view1.view.trackSettings?.echoCancellation.value === false && view1.view.trackSettings?.noiseSuppression.value === false && view1.view.trackSettings?.autoGainControl.value === false, view1.view.trackSettings);
    check('口: 再生中に口が開いた', view1.record.mouthOpenWhilePlaying > 0, { open_frames: view1.record.mouthOpenWhilePlaying, frames: view1.record.mouthSamplesWhilePlaying, max: view1.record.maxMouthOpen });

    // ---- 2. 切断試験: AI の再生中に WS を切る -------------------------------------------
    const playingNow = await waitFor('AI playback for disconnect test', () => session1.turnState.speaking.phase === 'playing' && session1.counters.uplink_frames > 0, 40_000, 50);
    const historyBefore = session1.history.snapshot().length;
    let disconnectDone = false;
    if (playingNow) {
      await sleep(1200); // 少し話させてから切る
      const sock = (server as unknown as { sessionSocket: { terminate(): void } | null }).sessionSocket;
      sock?.terminate();
      disconnectDone = true;
      await sleep(300);
    }
    const reattached = await waitFor('reattach', () => server.current() === session1 && session1.attached, 15_000);
    check('切断試験: ブラウザが自動で再接続し、同じセッションへ戻った', reattached !== null, { session: session1.session_id });
    // 切断では終わりを代行しない。ブラウザは受け取った分を流し切ってから、再接続後に本物の playback.ended を送る。
    const settled = await waitFor('browser playback.ended after reattach', () => (session1.turnState.speaking.phase === 'silent' ? true : null), 20_000, 50);
    results.disconnect = {
      performed: disconnectDone,
      synthesized_endings: session1.counters.playback_ended_synthesized,
      history_before: historyBefore,
      history_after: session1.history.snapshot().length,
      settled_by_browser_report: settled !== null,
    };
    check(
      '切断試験: 再生中に切断しても代行せず、再接続後のブラウザの報告で終わり、話した分が履歴へ入った',
      disconnectDone && settled !== null && session1.counters.playback_ended_synthesized === 0 && session1.history.snapshot().length > historyBefore,
      results.disconnect,
    );

    // ---- 2b. 2つ目のタブ: 断られ、張り直さず、1つ目の会話は続く -------------------------------
    const tab2 = await openParticipant(browser);
    await tab2.click('#start');
    let tab2Link = '';
    for (const until = Date.now() + 20_000; Date.now() < until && tab2Link !== 'elsewhere'; await sleep(200)) {
      tab2Link = await tab2.evaluate(() => window.__participant!.controller.current().link);
    }
    await sleep(1500);
    check('2つ目のタブは断られ（elsewhere）、1つ目のセッションは接続のまま', tab2Link === 'elsewhere' && server.current() === session1 && session1.attached, {
      tab2: tab2Link,
      same_session: server.current() === session1,
      attached: session1.attached,
    });
    await tab2.close();
    await sleep(6000);

    // ---- 3. ページの再読み込み → 新しいセッション（条件は吸気あり。開始画面の選択の初期値を ?condition= で） ----------
    await page.close();
    page = await openParticipant(browser, '&condition=initiative_inhale');
    const picked = await page.evaluate(() => (document.querySelector('input[name="condition"]:checked') as HTMLInputElement | null)?.value ?? null);
    await page.click('#start');
    const session2 = await waitFor('second session', () => {
      const s = server.current();
      return s !== null && s !== session1 ? s : null;
    }, 30_000);
    check('再読み込みで新しいセッションになり、前のセッションは閉じた', session2 !== null && server.pastSessions.includes(session1), { second: session2?.session_id });
    check('開始画面の条件の選択が ?condition= の値（initiative_inhale）で、セッションもその条件', picked === 'initiative_inhale' && session2?.condition === 'initiative_inhale', {
      picked,
      session: session2?.condition,
    });
    // 台本の候補を、吸気の合図のあと話し終えるまで待つ（候補の発話の履歴が入るまで）。
    const candidateSpoken = session2
      ? await waitFor('candidate speech in history', () => session2.history.snapshot().some((h) => h.role === 'assistant' && h.origin.kind === 'candidate') || null, 45_000, 100)
      : null;
    await sleep(3000);
    const breath2 = await page.evaluate(() => {
      const r = window.__participant!.controller.record;
      return { commands: r.breathCommands, reports: r.signalReports };
    });
    results.session2 = session2
      ? { vap_reconfigured: maai.current().state, counters: session2.counters, candidate_spoken: candidateSpoken !== null, breath: breath2 }
      : null;
    await page.close();
    await server.endSession('e2e_done');

    // ---- 4. ログの検査 -----------------------------------------------------------------
    for (const [label, session] of [['session1', session1], ['session2', session2]] as [string, Session | null][]) {
      if (!session) continue;
      const dir = path.join(config.sessions_dir, session.session_id);
      const report = await checkLog(dir);
      results[`log_check_${label}`] = {
        ok: report.ok,
        failures: report.failures,
        warnings: report.warnings,
        counts: report.counts_by_event,
        quarantine: report.quarantine_records,
        manifest_closed: report.manifest.closed,
        acceptance: report.acceptance_evidence,
        latency: report.latency,
      };
      check(`JSONL のスキーマ検証（${label}、tools/log_check）`, report.ok && report.quarantine_records === 0, { failures: report.failures, quarantine: report.quarantine_records });
    }

    const events = readEvents(path.join(config.sessions_dir, session1.session_id, 'events.jsonl'));
    analyse(events, session1, controlSettings(config.policy).gaze);
    if (session2) {
      const e2 = readEvents(path.join(config.sessions_dir, session2.session_id, 'events.jsonl'));
      const vap2 = ofType(e2, 'vap.state');
      check('新しいセッションでも VAP_STATE が届く（CONFIGURE をやり直した）', vap2.length > 10 && vap2[0]!.audio_frame < 16000 * 5, { n: vap2.length, first_frame: vap2[0]?.audio_frame });
      analyseInhale(e2, results.session2 as { breath: { commands: { type: string; breath: boolean }[]; reports: { phase: string }[] } } | null);
    }
  } finally {
    await browser?.close().catch(() => undefined);
    if (next?.pid) {
      try {
        process.kill(-next.pid, 'SIGTERM'); // 自分が起動したプロセスグループのみ
      } catch {
        /* 終了済み */
      }
    }
    await server.close().catch(() => undefined);
    await maai.stop('e2e_done').catch(() => undefined);
    results.failures = failures;
    const out = path.join(workDir, 'e2e_result.json');
    await writeFile(out, JSON.stringify(results, null, 2));
    console.log(`\nresult: ${out}`);
    console.log(failures.length === 0 ? 'ALL OK' : `FAILED: ${failures.join(', ')}`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  }
}

/** 吸気あり（initiative_inhale）のセッション: 合図 → 吸気 → 保留 → 候補の発話 → 話し終わり、が JSONL とブラウザの記録に残る。 */
function analyseInhale(events: ResearchEvent[], session2: { breath: { commands: { type: string; breath: boolean }[]; reports: { phase: string }[] } } | null): void {
  const conditions = new Set(events.map((e) => e.condition));
  const states = ofType(events, 'candidate.state_changed');
  const spoken = states.find((e) => e.to === 'SPOKEN');
  const id = spoken?.candidate_id;
  const path = id ? states.filter((e) => e.candidate_id === id).map((e) => e.to) : [];
  const sent = ofType(events, 'signal.sent').filter((e) => e.candidate_id === id);
  const started = ofType(events, 'signal.started').filter((e) => e.candidate_id === id);
  const speech = ofType(events, 'speech.started').filter((e) => e.origin === 'candidate' && e.candidate_id === id);
  const decisions = ofType(events, 'negotiation.decision');
  results.inhale = {
    conditions: [...conditions],
    candidate_id: id ?? null,
    path,
    signal_sent: sent.map((e) => ({ phase: e.phase, sent_at: e.sent_at })),
    signal_started: started.map((e) => ({ phase: e.phase, visible: e.visible })),
    speech_started: speech.length,
    negotiation_decisions: decisions.map((e) => `${e.stage}:${e.outcome}`),
    browser: session2?.breath ?? null,
  };
  check('吸気あり: JSONL の condition がすべて initiative_inhale', conditions.size === 1 && conditions.has('initiative_inhale'), [...conditions]);
  const inhaleAt = path.indexOf('BREATH_INHALE');
  check(
    '吸気あり: 候補が BREATH_INHALE → BREATH_HOLD_OR_READY（または DEFERRED）→ SPEAKING → SPOKEN と進んだ',
    inhaleAt >= 0 && path.indexOf('SPEAKING') > inhaleAt && path.slice(inhaleAt + 1, path.indexOf('SPEAKING')).some((s) => s === 'BREATH_HOLD_OR_READY' || s === 'DEFERRED') && path.at(-1) === 'SPOKEN',
    path,
  );
  check('吸気あり: 吸気の signal.sent と、ブラウザの描画の signal.started（inhale）が残る', sent.some((e) => e.phase === 'inhale') && started.some((e) => e.phase === 'inhale'), {
    sent: sent.map((e) => e.phase),
    started: started.map((e) => e.phase),
  });
  check('吸気あり: 候補の発話の speech.started（origin=candidate）', speech.length === 1, speech.length);
  const cmds = session2?.breath.commands ?? [];
  check(
    '吸気あり: ブラウザが breath.cue を受け、アバターの BreathController へ渡した（breath.release も届いた）',
    cmds.some((c) => c.type === 'breath.cue' && c.breath) && cmds.some((c) => c.type === 'breath.release'),
    cmds,
  );
  check('吸気あり: 発話の選択の理由が negotiation.decision に残る', decisions.some((e) => e.stage === 'speech_selection' && e.candidate_id.value === id), decisions.map((e) => `${e.stage}:${e.outcome}`));
}

/** 保持時間を待たずに user へ戻してよい理由（apps/orchestrator/src/control/gaze.ts の returnsImmediately）。 */
const IMMEDIATE_RETURN = /^(ai_not_speaking|ai_interrupted|user_speaking|vap_)/;

function analyse(events: ResearchEvent[], session: Session, gazeSettings: GazeSettings): void {
  const started = ofType(events, 'speech.started');
  const ended = ofType(events, 'speech.ended');
  const interrupted = ofType(events, 'speech.interrupted');
  const finished = [...ended, ...interrupted];
  results.speech = {
    started: started.length,
    ended: ended.map((e) => ({ id: e.audio_playback_id, chars: [...e.spoken_text].length, samples: e.samples_written })),
    interrupted: interrupted.map((e) => ({ id: e.audio_playback_id, chars: [...e.spoken_text].length, stop_point: e.stop_point, source: e.decision_source })),
  };
  check('E2E: AI が話した（speech.started）', started.length >= 1, results.speech);

  // 割り込みと履歴: 履歴の AI の文は speech.* の spoken_text と一致し、割り込まれたものは全文より短い。
  const history = session.history.snapshot().filter((e) => e.role === 'assistant');
  results.history_assistant = history;
  const mismatches = history.filter((h) => {
    const ev = finished.find((e) => e.audio_playback_id === h.audio_playback_id);
    return ev !== undefined && ev.spoken_text !== h.text;
  });
  check('履歴: AI の文は発話済みテキスト（speech.ended／interrupted の spoken_text）と一致', history.length > 0 && mismatches.length === 0, { entries: history.length, mismatches: mismatches.length });
  if (!REAL) {
    const partial = history.filter((h) => h.role === 'assistant' && h.text.length < DEFAULT_SCRIPTED_REPLY.length);
    const prefixOk = partial.every((h) => DEFAULT_SCRIPTED_REPLY.startsWith(h.text));
    check('割り込み／切断で止めた発話は、発話済みの接頭部だけが履歴へ', partial.length >= 1 && prefixOk, {
      interrupted: interrupted.length,
      synthesized: session.counters.playback_ended_synthesized,
      partial: partial.map((h) => ({ chars: [...h.text].length, interrupted: h.role === 'assistant' ? h.interrupted : null })),
      full_chars: [...DEFAULT_SCRIPTED_REPLY].length,
    });
  }
  check('割り込み: speech.interrupted が発生（VAP 由来）', interrupted.length >= 1, interrupted.map((e) => e.decision_source));

  // VAP が system チャネルの AI 音声に反応する: AI の再生区間とそれ以外で vad[1] を比べる。
  const vap = ofType(events, 'vap.state').filter((e) => e.channel_layout === '2ch') as Extract<Ev<'vap.state'>, { channel_layout: '2ch' }>[];
  const intervals = finished.map((e) => [e.audio_frame - e.samples_written, e.audio_frame] as const);
  const startedFrames = started.map((s) => s.audio_frame);
  const inAi = (frame: number) =>
    intervals.some(([a, b]) => frame >= a + 1600 && frame <= b) ||
    startedFrames.some((f) => !finished.some((e) => e.audio_frame >= f) && frame >= f + 1600);
  const inside = vap.filter((v) => inAi(v.audio_frame));
  const outside = vap.filter((v) => !inAi(v.audio_frame));
  const mean = (xs: number[]) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
  const vapSummary = {
    n_inside: inside.length,
    n_outside: outside.length,
    vad_sys_inside: mean(inside.map((v) => v.vad[1])),
    vad_sys_outside: mean(outside.map((v) => v.vad[1])),
    p_now_ai_inside: mean(inside.map((v) => v.p_now[1])),
    p_now_ai_outside: mean(outside.map((v) => v.p_now[1])),
    model_variant: vap[0]?.model_variant,
  };
  results.vap_vs_ai_audio = vapSummary;
  check('VAP: system チャネルの AI 音声に反応（vad[1] が AI 再生中に高い）', inside.length > 20 && vapSummary.vad_sys_inside > vapSummary.vad_sys_outside + 0.2, vapSummary);
  check('VAP: 偽の値ではない（model_variant が実 MaAI）', vap.length > 0 && !vap.some((v) => v.model_variant === 'FAKE_NOT_MAAI'), vapSummary.model_variant);

  // 視線: AI 発話中のポーズで gaze.decision が出て、gaze.rendered（rAF）が同じ向きで続く。
  const decisions = ofType(events, 'gaze.decision');
  const rendered = ofType(events, 'gaze.rendered');
  const inPause = decisions.filter((d) => d.in_speech_pause);
  // 同じ向きの繰り返し（user → user）は描画が変わらないので報告も出ない。向きが変わった判断だけを数える。
  const changes = decisions.filter((d, i) => d.target !== (i === 0 ? 'user' : decisions[i - 1]!.target));
  // ブラウザは目標の変化ごとに順に報告する（描画、または描画前に上書きされた未描画）。前から順に対応づけ、
  // 1つの報告を2つの判断に使わない（後の同じ向きの描画で、消えた報告を埋め合わせない）。
  type Outcome = { kind: 'rendered'; lag_ms: number } | { kind: 'superseded' | 'hidden' | 'missing' };
  let cursor = 0;
  const outcomes: Outcome[] = changes.map((d) => {
    for (let i = cursor; i < rendered.length; i += 1) {
      const r = rendered[i]!;
      if (r.target !== d.target) continue;
      const t = r.visible ? r.rendered_at : r.t_monotonic_ms;
      if (t < d.t_monotonic_ms - 5) continue;
      cursor = i + 1;
      if (r.visible) return { kind: 'rendered', lag_ms: r.rendered_at - d.t_monotonic_ms };
      return { kind: r.null_reason === 'superseded_before_render' ? 'superseded' : 'hidden' };
    }
    return { kind: 'missing' };
  });
  const reflected = outcomes.filter((o) => o.kind === 'rendered' && o.lag_ms <= 1000);
  const superseded = outcomes.filter((o) => o.kind === 'superseded');
  // 保持時間（原著にない、docs/known_gaps.md §7）: 逸らしの長さと、戻してから再び逸らすまでの間。
  const holdAway = gazeSettings.hold_away_min_ms;
  const reAvert = gazeSettings.re_avert_min_ms;
  const shortAway: { ms: number; reason: string }[] = [];
  const shortReAvert: { ms: number }[] = [];
  const awayMs: number[] = [];
  for (let i = 1; i < changes.length; i += 1) {
    const prev = changes[i - 1]!;
    const cur = changes[i]!;
    const ms = Math.round(cur.t_monotonic_ms - prev.t_monotonic_ms);
    if (prev.target === 'away' && cur.target === 'user') {
      awayMs.push(ms);
      if (holdAway !== null && ms < holdAway && !IMMEDIATE_RETURN.test(cur.reason)) shortAway.push({ ms, reason: cur.reason });
    }
    if (prev.target === 'user' && cur.target === 'away' && reAvert !== null && ms < reAvert) shortReAvert.push({ ms });
  }
  results.gaze = {
    decisions: decisions.length,
    in_pause: inPause.length,
    away: decisions.filter((d) => d.target === 'away').length,
    reasons: [...new Set(decisions.map((d) => d.reason.split(':')[0]))],
    rendered: rendered.length,
    target_changes: changes.length,
    reflected_within_1s: reflected.length,
    superseded_before_render: superseded.length,
    outcomes: outcomes.map((o) => (o.kind === 'rendered' ? Math.round(o.lag_ms) : o.kind)),
    away_ms: awayMs,
    away_returned_immediately: changes.filter((c, i) => c.target === 'user' && changes[i - 1]?.target === 'away' && IMMEDIATE_RETURN.test(c.reason)).map((c) => c.reason),
    hold_away_min_ms: holdAway,
    re_avert_min_ms: reAvert,
    rendered_basis: [...new Set(rendered.map((r) => r.time_basis.source))],
  };
  check('視線: AI 発話中のポーズで gaze.decision が発生', inPause.length >= 1, results.gaze);
  check(
    '視線: 向きの変わった gaze.decision ごとに、1 秒以内の描画（同じ向き）か「未描画で上書き」の報告がある',
    changes.length > 0 && reflected.length + superseded.length === changes.length,
    results.gaze,
  );
  check('視線: 逸らしが保持時間より短く戻らない（人の発話、割り込み、発話の終わり、鮮度切れを除く）', shortAway.length === 0, { hold_away_min_ms: holdAway, short: shortAway });
  check('視線: 戻した後、再逸らしまでの最短を守る', shortReAvert.length === 0, { re_avert_min_ms: reAvert, short: shortReAvert });

  const clock = ofType(events, 'clock.sync').filter((e) => e.source === 'browser_rtt');
  check('時計: clock.report から browser_rtt の clock.sync が出る', clock.length >= 1, { n: clock.length, last: clock.at(-1) && { offset: clock.at(-1)!.offset_ms, error: clock.at(-1)!.error_ms } });
  const client = ofType(events, 'session.client');
  check('session.client に AudioContext の実レートと user_agent', client.length >= 1 && client[0]!.audio_context_sample_rate_hz > 0 && client[0]!.user_agent !== '', client.map((c) => ({ rate: c.audio_context_sample_rate_hz, connection: c.connection })));
  const health = ofType(events, 'audio.health').filter((e) => e.reporter === 'browser');
  const lastHealth = health.at(-1) as Extract<Ev<'audio.health'>, { reporter: 'browser' }> | undefined;
  check('audio.health に任意4項目と TrackSettings.latency', lastHealth !== undefined && lastHealth.reconnects !== undefined && lastHealth.render_lag_ms !== undefined && lastHealth.track_settings.latency !== undefined, lastHealth && { reconnects: lastHealth.reconnects, orphan: lastHealth.orphan_pcm_frames, gaps: lastHealth.pcm_seq_gaps, lag: lastHealth.render_lag_ms, latency: lastHealth.track_settings.latency, frames_lost: lastHealth.frames_lost, underruns: lastHealth.underrun_count });
  const prefetch = ofType(events, 'prefetch.started');
  check('prefetch.started.trigger を記録', prefetch.length > 0 && prefetch.every((p) => p.trigger !== undefined), prefetch.map((p) => p.trigger));
  const cancelled = ofType(events, 'prefetch.cancelled');
  results.prefetch_cancelled = cancelled.map((c) => ({ reason: c.cancel_reason, chunks: c.discarded_chunks, samples: c.discarded_samples }));
  const worker = ofType(events, 'audio.health').filter((e) => e.reporter === 'worker') as Extract<Ev<'audio.health'>, { reporter: 'worker' }>[];
  results.worker_health_last = worker.at(-1);
  results.counters = session.counters;
  results.turn_allowed_sources = ofType(events, 'turn.allowed').reduce<Record<string, number>>((acc, e) => {
    const key = `${e.turn_allowed}:${e.decision_source}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
