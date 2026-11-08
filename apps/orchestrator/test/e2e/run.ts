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
import { CURRENT_DESIRE_PROMPT_VERSION } from '../../src/cognition/initiative/staged_prompt';
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
// 偽マイクの無音の長さ。台本の応答は約 12 秒なので、12 秒だと次の人の声と AI の声の重なりが最後の 1 秒未満になり、
// VAP の割り込みの条件がほとんど成立しない（通るのは MaAI が遅れて fallback に落ちた回だけだった）。
const SILENCE_S = Number(process.env.E2E_SILENCE_S ?? 6);
const BROWSER_NICE = 15;
/** 最初のセッションのページを閉じた時刻。閉じた後（直前の 1 秒を含む）の視線の判断は描画の報告が返らないので検査から外す。 */
let mainPageClosedAtWall: number | null = null;
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

/**
 * ブラウザを低い優先度で起動するラッパーを作る（G0 の実測で、ソフトウェア描画が MaAI を詰まらせたため）。
 * Linux の nice はスレッドごとなので、起動後に renice しても既存のスレッドに効かない。起動の時点で下げて、
 * 子プロセスとスレッドへ継承させる。
 */
async function lowPriorityChromium(dir: string): Promise<string> {
  const wrapper = path.join(dir, 'chromium-nice.sh');
  await writeFile(wrapper, `#!/bin/sh\nexec nice -n ${BROWSER_NICE} ${JSON.stringify(chromium.executablePath())} "$@"\n`, { mode: 0o755 });
  return wrapper;
}

/** コマンドラインに marker を含むプロセスと、その子孫の nice の値。 */
function niceOfProcessTree(marker: string): number[] {
  const pgrep = (args: string[]): number[] => {
    try {
      return execFileSync('pgrep', args, { encoding: 'utf8' }).split('\n').map(Number).filter((n) => n > 0);
    } catch {
      return [];
    }
  };
  const all = new Set<number>(pgrep(['-f', marker]).filter((p) => p !== process.pid));
  const queue = [...all];
  while (queue.length > 0) {
    for (const child of pgrep(['-P', String(queue.pop())])) {
      if (!all.has(child)) {
        all.add(child);
        queue.push(child);
      }
    }
  }
  const out = execFileSync('ps', ['-o', 'ni=', '-p', [...all].join(',')], { encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter((l) => l !== '').map(Number);
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
      executablePath: await lowPriorityChromium(workDir),
      headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${fakeWav}`],
    });

    // ---- 1. 通常の対話 -------------------------------------------------------------
    let page = await openParticipant(browser);
    const browserNice = niceOfProcessTree(fakeWav);
    check('ブラウザの全プロセスの優先度が下がっている（描画が MaAI を詰まらせない）', browserNice.length >= 3 && browserNice.every((n) => n === BROWSER_NICE), browserNice);
    results.avatar_error = await page.evaluate(() => window.__participant!.avatarError());
    // ?condition= も NEXT_PUBLIC_DEFAULT_CONDITION もないとき、開始画面は未選択（条件を送らず orchestrator の CONDITION に任せる）。
    const pickedDefault = await page.evaluate(() => (document.querySelector('input[name="condition"]:checked') as HTMLInputElement | null)?.value ?? null);
    await page.click('#start');
    const session1 = await waitFor('session', () => server.current(), 30_000);
    if (session1 === null) throw new Error('session did not start');
    check('条件を選ばなければ送らず、Node の既定（CONDITION、この試験では reactive）になる', pickedDefault === '' && session1.condition === 'reactive', {
      picked: pickedDefault,
      session: session1.condition,
    });
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

    mainPageClosedAtWall = Date.now();
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

    // ---- 3b. 二段判定の WAIT_FOR_TURN_END（台本のときだけ）: 吸気せず候補の文も話さず通常応答へ回す。候補は保留のまま。方式と種類は URL で選ぶ --------
    let session3: Session | null = null;
    let session4: Session | null = null;
    let session5: Session | null = null;
    let session6: Session | null = null;
    if (!REAL) {
      env.SCRIPTED_INITIATIVE = 'wait_on_input';
      page = await openParticipant(browser, '&condition=initiative_inhale&conversation_kind=companion&timing_strategy=llm');
      const pickedKind = await page.evaluate(() => (document.querySelector('input[name="conversation_kind"]:checked') as HTMLInputElement | null)?.value ?? null);
      await page.click('#start');
      session3 = await waitFor('third session', () => {
        const s = server.current();
        return s !== null && s !== session2 ? s : null;
      }, 30_000);
      check('開始画面の会話の種類の選択が ?conversation_kind= の値', pickedKind === 'companion', { pickedKind });
      const answered = session3
        ? await waitFor('normal response without cue', () => session3!.history.snapshot().some((h) => h.role === 'assistant' && h.origin.kind === 'response') || null, 45_000, 100)
        : null;
      await sleep(3000);
      const breath3 = await page.evaluate(() => window.__participant!.controller.record.breathCommands);
      results.session3 = session3
        ? {
            normal_response: answered !== null,
            candidate_spoken: session3.history.snapshot().some((h) => h.role === 'assistant' && h.origin.kind === 'candidate'),
            breath: breath3,
          }
        : null;
      await page.close();
      await server.endSession('e2e_done');

      // ---- 3c. immediate（すぐ申し出る）: タイミング段の LLM を呼ばず、吸気で提示してから許可で発声する --------
      env.SCRIPTED_INITIATIVE = 'new_on_input';
      page = await openParticipant(browser, '&condition=initiative_inhale&conversation_kind=joint_thinking&timing_strategy=immediate');
      await page.click('#start');
      session4 = await waitFor('fourth session', () => {
        const s = server.current();
        return s !== null && s !== session3 ? s : null;
      }, 30_000);
      const spoke4 = session4
        ? await waitFor('immediate candidate speech', () => session4!.history.snapshot().some((h) => h.role === 'assistant' && h.origin.kind === 'candidate') || null, 45_000, 100)
        : null;
      await sleep(3000);
      const breath4 = await page.evaluate(() => window.__participant!.controller.record.breathCommands);
      results.session4 = session4 ? { candidate_spoken: spoke4 !== null, breath: breath4 } : null;
      await page.close();
      await server.endSession('e2e_done');

      // ---- 3d. 話し続ける → 延期 → 内容更新（REVISE）→ 譲られたら新しい版を話す（台本）。方式は llm --------
      env.SCRIPTED_INITIATIVE = 'revise_on_input';
      page = await openParticipant(browser, '&condition=initiative_inhale&conversation_kind=joint_thinking&timing_strategy=llm');
      await page.click('#start');
      session5 = await waitFor('fifth session', () => {
        const s = server.current();
        return s !== null && s !== session4 ? s : null;
      }, 30_000);
      const spoke5 = session5
        ? await waitFor('revised candidate speech', () => session5!.history.snapshot().some((h) => h.role === 'assistant' && h.origin.kind === 'candidate') || null, 45_000, 100)
        : null;
      await sleep(3000);
      const breath5 = await page.evaluate(() => window.__participant!.controller.record.breathCommands);
      results.session5 = session5 ? { candidate_spoken: spoke5 !== null, breath: breath5 } : null;
      await page.close();
      await server.endSession('e2e_done');

      // ---- 3e. 話し続ける → 撤回（WITHDRAW）: 声を出さず聞き手に戻る（台本）。方式は immediate --------
      env.SCRIPTED_INITIATIVE = 'withdraw_on_input';
      page = await openParticipant(browser, '&condition=initiative_inhale&conversation_kind=joint_thinking&timing_strategy=immediate');
      await page.click('#start');
      session6 = await waitFor('sixth session', () => {
        const s = server.current();
        return s !== null && s !== session5 ? s : null;
      }, 30_000);
      const withdrawn6 = session6
        ? await waitFor('candidate withdrawn', () => session6!.candidates?.list({ include_resolved: true }).some((c) => c.candidate_id === 'c_0001' && c.state === 'WITHDRAWN') || null, 45_000, 100)
        : null;
      await sleep(3000);
      const breath6 = await page.evaluate(() => window.__participant!.controller.record.breathCommands);
      results.session6 = session6 ? { withdrawn: withdrawn6 !== null, breath: breath6 } : null;
      await page.close();
      await server.endSession('e2e_done');
    }

    // ---- 4. ログの検査 -----------------------------------------------------------------
    for (const [label, session] of [['session1', session1], ['session2', session2], ['session3', session3], ['session4', session4], ['session5', session5], ['session6', session6]] as [string, Session | null][]) {
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
      if (!REAL) analyseOfferNow(e2);
    }
    if (session3) {
      const dir3 = path.join(config.sessions_dir, session3.session_id);
      analyseWaitForTurnEnd(readEvents(path.join(dir3, 'events.jsonl')), JSON.parse(readFileSync(path.join(dir3, 'manifest.json'), 'utf8')) as Record<string, unknown>, results.session3 as { normal_response: boolean; candidate_spoken: boolean; breath: unknown[] } | null);
    }
    if (session4) {
      const dir4 = path.join(config.sessions_dir, session4.session_id);
      analyseImmediate(readEvents(path.join(dir4, 'events.jsonl')), JSON.parse(readFileSync(path.join(dir4, 'manifest.json'), 'utf8')) as Record<string, unknown>);
    }
    if (session5) analyseRevise(readEvents(path.join(config.sessions_dir, session5.session_id, 'events.jsonl')), results.session5 as { candidate_spoken: boolean; breath: { type: string }[] } | null);
    if (session6) analyseWithdraw(readEvents(path.join(config.sessions_dir, session6.session_id, 'events.jsonl')), results.session6 as { withdrawn: boolean; breath: { type: string; reason?: string }[] } | null);
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

/** 二段判定で OFFER_NOW のとき: 生成段 → タイミング段 → 合図の順に記録が残る（台本）。 */
function analyseOfferNow(events: ResearchEvent[]): void {
  const desire = ofType(events, 'initiative.desire').find((e) => e.outcome === 'registered');
  const timing = ofType(events, 'initiative.timing').find((e) => e.timing === 'OFFER_NOW');
  const cue = ofType(events, 'signal.sent').find((e) => e.phase === 'inhale');
  results.offer_now = { desire: desire?.request_id ?? null, timing: timing?.timing_strategy ?? null, cue_sent_at: cue?.sent_at ?? null };
  check(
    '二段判定 OFFER_NOW: 生成段（registered）→ タイミング段（OFFER_NOW）→ 吸気の合図の順',
    desire !== undefined && timing !== undefined && cue !== undefined && desire.t_monotonic_ms <= timing.t_monotonic_ms && timing.t_monotonic_ms <= cue.t_monotonic_ms,
    results.offer_now,
  );
}

/** 二段判定で WAIT_FOR_TURN_END のとき: 吸気せず候補の文も話さず通常応答へ回し、候補は保留のまま。種類と方式が manifest に残る（台本）。 */
function analyseWaitForTurnEnd(events: ResearchEvent[], manifest: Record<string, unknown>, session3: { normal_response: boolean; candidate_spoken: boolean; breath: unknown[] } | null): void {
  const states = ofType(events, 'candidate.state_changed');
  const id = states[0]?.candidate_id;
  const path = id ? states.filter((e) => e.candidate_id === id).map((e) => e.to) : [];
  const timing = ofType(events, 'initiative.timing').filter((e) => e.candidate_id === id);
  const signals = ofType(events, 'signal.sent').filter((e) => e.candidate_id === id);
  const notOffered = ofType(events, 'initiative.not_offered').filter((e) => e.candidate_id === id);
  const material = ofType(events, 'initiative.response_material').filter((e) => e.candidate_id === id);
  const selection = ofType(events, 'negotiation.decision').find((e) => e.stage === 'speech_selection' && e.reasons.includes('timing_wait_for_turn_end'));
  results.wait_for_turn_end = { path, timing: timing.map((e) => e.timing), signals: signals.length, not_offered: notOffered.length, material: material.length, outcome: selection?.outcome ?? null, breath: session3?.breath ?? null };
  check('二段判定 WAIT_FOR_TURN_END: 候補を話さず通常応答が出る', session3?.normal_response === true && session3.candidate_spoken === false, session3);
  check('二段判定 WAIT_FOR_TURN_END: 候補は吸気も発声も経ない（SPEAKING に入らない）', path[0] === 'INTENT_READY' && !path.includes('BREATH_INHALE') && !path.includes('SPEAKING'), path);
  check('二段判定 WAIT_FOR_TURN_END: タイミング段の判定はすべて WAIT_FOR_TURN_END', timing.length >= 1 && timing.every((e) => e.timing === 'WAIT_FOR_TURN_END'), timing.map((e) => e.timing));
  check('二段判定 WAIT_FOR_TURN_END: 合図（signal.sent）もブラウザの呼吸の指示もない', signals.length === 0 && (session3?.breath.length ?? 1) === 0, results.wait_for_turn_end);
  check('二段判定 WAIT_FOR_TURN_END: 発話の選択は通常応答で、理由に残る', selection?.outcome === 'response', selection?.reasons);
  check('二段判定 WAIT_FOR_TURN_END: 通常応答の開始で候補を持ち越した記録（initiative.not_offered）がある', notOffered.length === 1, results.wait_for_turn_end);
  // 材料は準備の時点で手元にある判定だけを使う（応答を待たせない）。WAIT の判定の後に準備した応答があったときだけ、渡した記録を求める。
  const verdictAt = timing[0]?.t_monotonic_ms ?? Infinity;
  const startedAt = notOffered[0]?.t_monotonic_ms ?? -Infinity;
  const preparedAfterVerdict = ofType(events, 'llm.request').filter((e) => e.purpose === 'prefetch' && e.t_monotonic_ms > verdictAt && e.t_monotonic_ms < startedAt).length;
  check('二段判定 WAIT_FOR_TURN_END: WAIT の判定の後に準備した応答があれば、材料として渡した記録がある', preparedAfterVerdict === 0 || material.length >= 1, { prepared_after_verdict: preparedAfterVerdict, material: material.length });
  const initiative = (manifest.initiative ?? {}) as Record<string, unknown>;
  check(
    'manifest に会話の種類（client）、方式、版が残る',
    initiative.conversation_kind === 'companion' && initiative.conversation_kind_source === 'client' && initiative.timing_strategy === 'llm' && initiative.desire_prompt_version === CURRENT_DESIRE_PROMPT_VERSION,
    initiative,
  );
}

/** immediate のとき: タイミング段の LLM を呼ばず、吸気 → 発声の順で話し、合図への反応が cue ごとに残る（台本）。 */
function analyseImmediate(events: ResearchEvent[], manifest: Record<string, unknown>): void {
  const states = ofType(events, 'candidate.state_changed');
  const spoken = states.find((e) => e.to === 'SPOKEN' || e.to === 'SPEAKING');
  const id = spoken?.candidate_id;
  const path = id ? states.filter((e) => e.candidate_id === id).map((e) => e.to) : [];
  const timing = ofType(events, 'initiative.timing').filter((e) => e.candidate_id === id);
  const cue = ofType(events, 'signal.sent').find((e) => e.candidate_id === id && e.phase === 'inhale');
  const speaking = states.find((e) => e.candidate_id === id && e.to === 'SPEAKING');
  const reaction = ofType(events, 'negotiation.cue_reaction').filter((e) => e.candidate_id === id);
  results.immediate = { path, timing: timing.map((e) => [e.timing_strategy, e.timing]), cue_sent_at: cue?.sent_at ?? null, speaking_at: speaking?.t_monotonic_ms ?? null, reactions: reaction.map((e) => e.ended_by) };
  check('immediate: タイミング段は LLM を呼ばず OFFER_NOW 相当', timing.length >= 1 && timing.every((e) => e.timing_strategy === 'immediate' && e.timing === 'OFFER_NOW' && e.model_call === false), timing.map((e) => e.timing));
  check('immediate: 候補は吸気を経て話す（INTENT_READY → BREATH_INHALE → … → SPEAKING）', path[0] === 'INTENT_READY' && path[1] === 'BREATH_INHALE' && path.includes('SPEAKING'), path);
  check('immediate: 吸気の合図が発声より先', cue !== undefined && speaking !== undefined && cue.t_monotonic_ms < speaking.t_monotonic_ms, results.immediate);
  check('immediate: 合図の後の人の反応が記録される', reaction.length === 1, reaction.map((e) => e.ended_by));
  check('immediate: manifest の方式', ((manifest.initiative ?? {}) as Record<string, unknown>).timing_strategy === 'immediate', manifest.initiative);
}

/** 話し続けて内容更新（台本 revise_on_input、方式 llm）: 延期の後に REVISE し、新しい版を再吸気なしで話す。古い版の PCM は話さない。 */
function analyseRevise(events: ResearchEvent[], session5: { candidate_spoken: boolean; breath: { type: string }[] } | null): void {
  const states = ofType(events, 'candidate.state_changed').filter((e) => e.candidate_id === 'c_0001');
  const path = states.map((e) => (e.cause_source === 'code' ? `${e.to}:${e.cause}` : `${e.to}:${e.decision}`));
  const cue = ofType(events, 'signal.sent').filter((e) => e.candidate_id === 'c_0001' && e.phase === 'inhale');
  const revise = states.find((e) => e.cause_source === 'model_decision' && e.decision === 'REVISE');
  const speech = ofType(events, 'speech.started').filter((e): e is Extract<Ev<'speech.started'>, { origin: 'candidate' }> => e.origin === 'candidate' && e.candidate_id === 'c_0001');
  const reaction = ofType(events, 'negotiation.cue_reaction').filter((e) => e.candidate_id === 'c_0001');
  const llmDesires = ofType(events, 'initiative.desire').map((e) => e.outcome);
  results.revise = { path, cues: cue.length, desires: llmDesires, reactions: reaction.map((e) => ({ by: e.ended_by, at_cue: e.user_speaking_at_cue })), spoken_version: speech.map((e) => e.candidate_version), breath: session5?.breath.map((c) => c.type) ?? null };
  check('内容更新: 候補を話した（台本 revise_on_input、延期中の更新の経路）', session5?.candidate_spoken === true && speech.length === 1, results.revise);
  check('内容更新: 延期（DEFERRED）に入り、その後に REVISE（再吸気なし）', path.some((p) => p.startsWith('DEFERRED:')) && revise !== undefined && cue.length === 1, results.revise);
  check('内容更新: 話した音声は新しい版（版 2、古い版の PCM は話さない）', speech.length === 1 && speech[0]!.candidate_version === 2 && revise?.candidate_version === 2, results.revise);
  check('内容更新: DEFERRED からの発話なのでブラウザに breath.prepare（短い準備）が届き、再吸気の breath.cue は 1 回', (session5?.breath.filter((c) => c.type === 'breath.prepare').length ?? 0) === 1 && (session5?.breath.filter((c) => c.type === 'breath.cue').length ?? 0) === 1, results.revise);
  check('内容更新: 合図の後の人の反応が 1 件（譲ったとは断定しない値）', reaction.length === 1 && !JSON.stringify(reaction[0]).match(/yield|gave_way/), reaction.length);
}

/** 話し続けて撤回（台本 withdraw_on_input、方式 immediate）: 分類つきで撤回し、声を出さず聞き手に戻る。 */
function analyseWithdraw(events: ResearchEvent[], session6: { withdrawn: boolean; breath: { type: string; reason?: string }[] } | null): void {
  const states = ofType(events, 'candidate.state_changed').filter((e) => e.candidate_id === 'c_0001');
  const path = states.map((e) => (e.cause_source === 'code' ? `${e.to}:${e.cause}` : `${e.to}:${e.decision}`));
  const withdrawn = states.find((e) => e.to === 'WITHDRAWN');
  const speech = ofType(events, 'speech.started').filter((e) => e.origin === 'candidate' && e.candidate_id === 'c_0001');
  const releases = ofType(events, 'signal.sent').filter((e) => e.candidate_id === 'c_0001' && e.parameters.reason !== undefined).map((e) => e.parameters.reason);
  const reaction = ofType(events, 'negotiation.cue_reaction').filter((e) => e.candidate_id === 'c_0001');
  const timing = ofType(events, 'initiative.timing').filter((e) => e.candidate_id === 'c_0001');
  results.withdraw = { path, releases, reactions: reaction.map((e) => e.ended_by), breath: session6?.breath.map((c) => `${c.type}:${c.reason ?? ''}`) ?? null, timing: timing.map((e) => e.timing_strategy) };
  const kind = withdrawn && withdrawn.cause_source === 'model_decision' ? (withdrawn.withdraw_kind?.value ?? null) : null;
  check('撤回: 候補は WITHDRAW で閉じ、withdraw_kind が残る（question_resolved）', session6?.withdrawn === true && withdrawn?.cause_source === 'model_decision' && withdrawn.decision === 'WITHDRAW' && kind === 'question_resolved', { ...(results.withdraw as object), kind });
  check('撤回: 声を出さない（候補の speech.started がない）', speech.length === 0, speech.length);
  check('撤回: ブラウザへ breath.release(withdrawn) が届き、再吸気なし', releases.includes('withdrawn') && (session6?.breath.filter((c) => c.type === 'breath.cue').length ?? 0) === 1 && (session6?.breath.some((c) => c.type === 'breath.release' && c.reason === 'withdrawn') ?? false), results.withdraw);
  check('撤回: immediate（タイミング段は LLM を呼ばない）', timing.length >= 1 && timing.every((e) => e.timing_strategy === 'immediate' && e.model_call === false), results.withdraw);
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
  check('割り込み: speech.interrupted が発生（VAP 由来）', interrupted.some((e) => e.decision_source === 'vap'), interrupted.map((e) => e.decision_source));

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
  // 対応づけと遅れは、orchestrator が受け取った順と時刻で見る。rendered_at はブラウザの時計を換算した値で、
  // 実測では判断より 0.5〜0.7 秒前になる回があり（報告の受信は判断の後）、時刻で照合すると別の描画に対応してしまう。
  type Outcome = { kind: 'rendered'; lag_ms: number; rendered_at_minus_decision_ms: number } | { kind: 'superseded' | 'hidden' | 'missing' | 'page_closed' };
  const logIndex = new Map<ResearchEvent, number>(events.map((e, i) => [e, i]));
  let cursor = 0;
  const outcomes: Outcome[] = changes.map((d) => {
    for (let i = cursor; i < rendered.length; i += 1) {
      const r = rendered[i]!;
      if (r.target !== d.target) continue;
      if (logIndex.get(r)! < logIndex.get(d)!) continue;
      cursor = i + 1;
      if (r.visible) return { kind: 'rendered', lag_ms: Date.parse(r.wall_clock) - Date.parse(d.wall_clock), rendered_at_minus_decision_ms: r.rendered_at - d.t_monotonic_ms };
      return { kind: r.null_reason === 'superseded_before_render' ? 'superseded' : 'hidden' };
    }
    if (mainPageClosedAtWall !== null && Date.parse(d.wall_clock) >= mainPageClosedAtWall - 1000) return { kind: 'page_closed' };
    return { kind: 'missing' };
  });
  // 1 秒以内: 受信までの遅れ（描画の遅れの上限。報告の戻りの遅れも含む）か、ブラウザの描画時刻のどちらかで確かめる。
  // 描画時刻が判断より前になった回は時計の値が信用できないので、描画時刻の根拠には使わない。
  const reflected = outcomes.filter(
    (o) => o.kind === 'rendered' && (o.lag_ms <= 1000 || (o.rendered_at_minus_decision_ms >= 0 && o.rendered_at_minus_decision_ms <= 1000)),
  );
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
    rendered_at_minus_decision_ms: outcomes.flatMap((o) => (o.kind === 'rendered' ? [Math.round(o.rendered_at_minus_decision_ms)] : [])),
    away_ms: awayMs,
    away_returned_immediately: changes.filter((c, i) => c.target === 'user' && changes[i - 1]?.target === 'away' && IMMEDIATE_RETURN.test(c.reason)).map((c) => c.reason),
    hold_away_min_ms: holdAway,
    re_avert_min_ms: reAvert,
    rendered_basis: [...new Set(rendered.map((r) => r.time_basis.source))],
  };
  check('視線: AI 発話中のポーズで gaze.decision が発生', inPause.length >= 1, results.gaze);
  check(
    '視線: 向きの変わった gaze.decision ごとに、1 秒以内の描画（同じ向き）か「未描画で上書き」の報告がある',
    changes.length > 0 && reflected.length + superseded.length + outcomes.filter((o) => o.kind === 'page_closed').length === changes.length,
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
