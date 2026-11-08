'use client';

/**
 * アバターの負荷の測定ページ（dev 専用）。1 モデルだけ描き、待機のフレーム時間と、吸気の合図から描画までの時間を測る。
 * 開くと自動で測り、結果を画面に出す。?report= があれば結果を JSON で POST する（WSL の収集スクリプト用）。
 * クエリ: ?avatar=vrm|rocketbox ?idle=60（秒） ?cues=20 ?report=http://localhost:8899/report ?tag=任意
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Avatar, FrameTiming } from '../../../src/avatar';
import { AVATAR_MODELS, isAvatarId, type AvatarId } from '../../../src/avatar/avatar_models';
import { frameStats, summarize, type DurationSummary, type FrameStats } from '../../../src/avatar/dev_measure';

export interface MeasureReport {
  tag: string;
  avatar: AvatarId;
  renderer: string | null;
  vendor: string | null;
  userAgent: string;
  devicePixelRatio: number;
  canvasCss: [number, number];
  idle: { seconds: number; frame: FrameStats; renderCpu: DurationSummary };
  cue: {
    n: number;
    latencyToRenderedFrameMs: DurationSummary;
    latencyToWeight002Ms: DurationSummary;
    latencyMs: number[];
  };
  modelInfo: { morphTargets: number; vertices: number; movedVertices: number; maxDisplacementMm: number; chestBone: string; primitives: number };
  loadMs: number;
  errors: string[];
}

declare global {
  interface Window {
    __avatarMeasure?: { state(): string; report(): MeasureReport | null };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (values: number[]) => summarize(values).median ?? 0;

export default function AvatarMeasurePage() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState('準備中');
  const reportRef = useRef<MeasureReport | null>(null);
  const stateRef = useRef('init');

  useEffect(() => {
    window.__avatarMeasure = { state: () => stateRef.current, report: () => reportRef.current };
    const query = new URLSearchParams(window.location.search);
    const idParam = query.get('avatar') ?? 'vrm';
    const id: AvatarId = isAvatarId(idParam) ? idParam : 'vrm';
    const idleSeconds = Number(query.get('idle') ?? 60);
    const cueCount = Number(query.get('cues') ?? 20);
    const reportUrl = query.get('report');
    const tag = query.get('tag') ?? '';
    const definition = AVATAR_MODELS[id];
    let disposed = false;
    const log = (message: string) => {
      stateRef.current = message;
      setText(message);
    };

    void (async () => {
      const errors: string[] = [];
      const container = stageRef.current;
      if (!container || !definition.url || !definition.spec) return;
      const raf: number[] = [];
      const cpu: number[] = [];
      let recording = false;
      let cueStart: number | null = null;
      let phaseFrameRaf: number | null = null;
      let phaseSeen = false;
      const latency: number[] = [];
      const weightLatency: number[] = [];
      let baseline = 0;
      const onFrame = (t: FrameTiming) => {
        if (recording) {
          raf.push(t.rafMs);
          cpu.push(t.renderedMs - t.startedMs);
        }
        if (cueStart !== null) {
          if (phaseFrameRaf !== null && t.rafMs === phaseFrameRaf && !phaseSeen) {
            phaseSeen = true;
            latency.push(t.renderedMs - cueStart);
          }
          if (phaseSeen && t.chestWeight - baseline >= 0.02 && weightLatency.length < latency.length) {
            weightLatency.push(t.renderedMs - cueStart);
            cueStart = null;
          }
        }
      };
      const t0 = performance.now();
      const { createAvatar } = await import('../../../src/avatar/runtime');
      log(`${id}: 読み込み中`);
      let avatar: Avatar;
      try {
        avatar = await createAvatar({
          container,
          modelUrl: definition.url,
          model: definition.spec,
          framing: 'bust',
          onFrameRendered: onFrame,
          onBreathPhase: (event) => {
            if (event.phase === 'inhale' && cueStart !== null) phaseFrameRaf = event.nowMs;
          },
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log(`読み込み失敗: ${message}`);
        if (reportUrl) await fetch(reportUrl, { method: 'POST', mode: 'cors', body: JSON.stringify({ tag, avatar: id, error: message }) });
        return;
      }
      if (disposed) {
        avatar.dispose();
        return;
      }
      const loadMs = performance.now() - t0;
      const canvas = container.querySelector('canvas') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl2');
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer = gl && dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null;
      const vendor = gl && dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : null;
      const info = avatar.getModelInfo();
      log(`${id}: 安定待ち 5 秒`);
      await sleep(5000);
      recording = true;
      log(`${id}: 待機のフレーム時間 ${idleSeconds} 秒`);
      await sleep(idleSeconds * 1000);
      recording = false;
      const frame = frameStats(raf);
      const renderCpu = summarize(cpu);

      for (let i = 0; i < cueCount && !disposed; i += 1) {
        log(`${id}: 吸気の合図 ${i + 1}/${cueCount}`);
        await sleep(600 + Math.random() * 500);
        baseline = avatar.getTelemetry().breath.chestWeight;
        phaseFrameRaf = null;
        phaseSeen = false;
        cueStart = performance.now();
        avatar.breath.startInhale({ cue_id: `measure-${i}`, duration_ms: 700 });
        await sleep(900);
        if (cueStart !== null && !phaseSeen) errors.push(`cue ${i} の吸気が描かれなかった`);
        cueStart = null;
        avatar.breath.release('withdrawn');
        await sleep(1200);
      }
      const report: MeasureReport = {
        tag,
        avatar: id,
        renderer,
        vendor,
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
        canvasCss: [container.clientWidth, container.clientHeight],
        idle: { seconds: idleSeconds, frame, renderCpu },
        cue: {
          n: latency.length,
          latencyToRenderedFrameMs: summarize(latency),
          latencyToWeight002Ms: summarize(weightLatency),
          latencyMs: latency,
        },
        modelInfo: {
          morphTargets: info.meshes.reduce((s, m) => s + m.morphTargets.length, 0),
          vertices: info.meshes.reduce((s, m) => s + m.vertices, 0),
          movedVertices: info.breathMorph.movedVertices,
          maxDisplacementMm: info.breathMorph.maxDisplacementMm,
          chestBone: info.breathMorph.chestBone,
          primitives: info.meshes.reduce((s, m) => s + m.primitives, 0),
        },
        loadMs,
        errors,
      };
      reportRef.current = report;
      log(`完了: ${id} 中央値 ${(frame.median ?? 0).toFixed(2)}ms p95 ${(frame.p95 ?? 0).toFixed(2)}ms / 吸気 ${median(latency).toFixed(1)}ms`);
      if (reportUrl) {
        try {
          await fetch(reportUrl, { method: 'POST', mode: 'cors', body: JSON.stringify(report) });
          log(`完了（送信済み）: ${id}`);
        } catch (e) {
          log(`完了（送信失敗 ${e instanceof Error ? e.message : String(e)}）。結果は下に出す`);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  return (
    <main style={styles.main}>
      <p style={styles.status} data-testid="measure-state">
        {text}
      </p>
      <div ref={stageRef} style={styles.stage} />
      <Result reportRef={reportRef} text={text} />
    </main>
  );
}

function Result({ reportRef, text }: { reportRef: { current: MeasureReport | null }; text: string }) {
  return reportRef.current ? (
    <pre style={styles.result} data-testid="measure-result">
      {JSON.stringify(reportRef.current, null, 1)}
    </pre>
  ) : (
    <pre style={styles.result}>{text}</pre>
  );
}

const styles: Record<string, CSSProperties> = {
  main: { fontFamily: 'system-ui, sans-serif', margin: 0, padding: 8 },
  status: { fontSize: 14, margin: '0 0 8px' },
  stage: { position: 'relative', width: 1280, height: 720, background: '#eee' },
  result: { fontSize: 11, marginTop: 8, whiteSpace: 'pre-wrap' },
};
