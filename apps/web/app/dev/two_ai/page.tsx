'use client';

/**
 * 2 体のステージの確認ページ（docs/design/two_ai/03 §3.6）。Node なしで、A／B ごとに視線（user／peer／away）、
 * 吸気（startInhale／release）、口（音量のつまみ）を押して確かめる。参加者には見せない。
 * クエリ: ?a=rb_fa03&b=rb_ma09（avatar_models.ts の ID。既定は Rocketbox の 2 体）、
 *   ?layout_yaw=35 ?layout_spacing=0.9（眼の間の全幅 m）?fov=24、?fps=30（0 で上限なし）。
 * 性能の測定（04 S6、WP3c の quick_rtf）もこのページを使える。fps、フレーム時間の p95、droppedByCap を出す。
 * 確認スクリプト（src/avatar/browser_check/two_ai_shots.ts）は window.__twoAiDev を使う。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AiId, GazeReport, GazeTarget } from '@llm-vap/contracts';
import { AVATAR_MODELS, isAvatarId, type AvatarId } from '../../../src/avatar/avatar_models';
import type { Stage, StageTelemetry } from '../../../src/avatar/stage';
import { parseLayoutQuery } from '../../../src/avatar/stage_layout';

const AI_IDS: AiId[] = ['A', 'B'];
const DEFAULT_IDS: Record<AiId, AvatarId> = { A: 'rb_fa03', B: 'rb_ma09' };
const GAZE_TARGETS: GazeTarget[] = ['user', 'peer', 'away'];

interface TwoAiDevHandle {
  stage(): Stage | null;
  gazeReports: (GazeReport & { ai_id: AiId })[];
  errors(): Partial<Record<AiId, string>>;
}

declare global {
  interface Window {
    __twoAiDev?: TwoAiDevHandle;
  }
}

function modelFor(ai: AiId, query: URLSearchParams) {
  const raw = query.get(ai.toLowerCase());
  const id: AvatarId = raw !== null && isAvatarId(raw) && raw !== 'none' ? raw : DEFAULT_IDS[ai];
  const def = AVATAR_MODELS[id];
  return { id, url: def.url!, spec: def.spec! };
}

function parseFps(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 240) return undefined;
  return value === 0 ? null : value;
}

export default function TwoAiDevPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Stage | null>(null);
  const reportsRef = useRef<(GazeReport & { ai_id: AiId })[]>([]);
  const [errors, setErrors] = useState<Partial<Record<AiId, string>>>({});
  const errorsRef = useRef(errors);
  errorsRef.current = errors;
  const [loading, setLoading] = useState(true);
  const [telemetry, setTelemetry] = useState<StageTelemetry | null>(null);
  const [mouth, setMouth] = useState<Record<AiId, number>>({ A: 0, B: 0 });
  const [gaze, setGaze] = useState<Record<AiId, GazeTarget>>({ A: 'user', B: 'user' });
  const [models, setModels] = useState<Record<AiId, string>>({ A: DEFAULT_IDS.A, B: DEFAULT_IDS.B });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let created: Stage | null = null;
    const query = new URLSearchParams(window.location.search);
    const chosen = { A: modelFor('A', query), B: modelFor('B', query) };
    setModels({ A: chosen.A.id, B: chosen.B.id });
    const fps = parseFps(query.get('fps'));
    (async () => {
      const { createStage } = await import('../../../src/avatar/stage');
      const stage = await createStage({
        container,
        avatars: AI_IDS.map((ai) => ({ ai_id: ai, modelUrl: chosen[ai].url, model: chosen[ai].spec })),
        layout: parseLayoutQuery(window.location.search),
        ...(fps !== undefined ? { maxFps: fps } : {}),
        onGazeReport: (ai_id, report) => {
          reportsRef.current.push({ ...report, ai_id });
          if (reportsRef.current.length > 200) reportsRef.current.shift();
        },
        onAvatarLoad: (ai_id, result) => {
          if (result.status === 'failed') setErrors((prev) => ({ ...prev, [ai_id]: result.error }));
        },
      });
      if (cancelled) {
        stage.dispose();
        return;
      }
      created = stage;
      stageRef.current = stage;
      setLoading(false);
    })().catch((error: unknown) => {
      setErrors({ A: String(error), B: String(error) });
      setLoading(false);
    });
    return () => {
      cancelled = true;
      created?.dispose();
      stageRef.current = null;
    };
  }, []);

  useEffect(() => {
    window.__twoAiDev = { stage: () => stageRef.current, gazeReports: reportsRef.current, errors: () => errorsRef.current };
    const timer = setInterval(() => setTelemetry(stageRef.current?.getTelemetry() ?? null), 500);
    return () => {
      clearInterval(timer);
      delete window.__twoAiDev;
    };
  }, []);

  // 手動の音量を毎フレーム（20ms ごと）入れる。0 の AI には何も送らない（口は自然に閉じる）。
  useEffect(() => {
    const timer = setInterval(() => {
      for (const ai of AI_IDS) if (mouth[ai] > 0) stageRef.current?.avatar(ai)?.setMouthLevel(mouth[ai]);
    }, 20);
    return () => clearInterval(timer);
  }, [mouth]);

  const act = (ai: AiId, fn: (avatar: NonNullable<ReturnType<Stage['avatar']>>) => void) => {
    const avatar = stageRef.current?.avatar(ai);
    if (avatar) fn(avatar);
  };

  return (
    <main style={styles.main}>
      <div style={styles.stage}>
        <div ref={containerRef} style={styles.canvas} data-testid="two-ai-stage" />
        {loading && <p style={styles.status}>読み込み中…</p>}
      </div>
      <aside style={styles.panel}>
        <h1 style={styles.h1}>2 体のステージの確認</h1>
        {AI_IDS.map((ai) => (
          <section key={ai} style={styles.section} data-testid={`two-ai-controls-${ai}`}>
            <h2 style={styles.h2}>
              {ai}（{models[ai]}）{errors[ai] ? <span style={styles.error}> 読み込み失敗: {errors[ai]}</span> : null}
            </h2>
            <div style={styles.row}>
              視線:
              {GAZE_TARGETS.map((target) => (
                <button
                  key={target}
                  type="button"
                  style={gaze[ai] === target ? styles.active : styles.button}
                  onClick={() => {
                    act(ai, (a) => a.setGaze(target));
                    setGaze((prev) => ({ ...prev, [ai]: target }));
                  }}
                >
                  {target}
                </button>
              ))}
            </div>
            <div style={styles.row}>
              吸気:
              <button type="button" style={styles.button} onClick={() => act(ai, (a) => a.breath.startInhale({ cue_id: `dev_${Date.now()}`, duration_ms: 600 }))}>
                startInhale
              </button>
              <button type="button" style={styles.button} onClick={() => act(ai, (a) => a.breath.release('speech_started'))}>
                release（発話へ）
              </button>
              <button type="button" style={styles.button} onClick={() => act(ai, (a) => a.breath.release('withdrawn'))}>
                release（脱力）
              </button>
            </div>
            <label style={styles.row}>
              口の音量（RMS）
              <input
                type="range"
                min={0}
                max={0.3}
                step={0.005}
                value={mouth[ai]}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  setMouth((prev) => ({ ...prev, [ai]: value }));
                  if (value === 0) act(ai, (a) => a.closeMouth());
                }}
              />
              {mouth[ai].toFixed(3)}
            </label>
          </section>
        ))}
        <section style={styles.section} data-testid="two-ai-telemetry">
          <h2 style={styles.h2}>描画</h2>
          {telemetry === null ? (
            <p>未計測</p>
          ) : (
            <ul style={styles.list}>
              <li>fps {telemetry.fps.toFixed(1)}（中央値 {telemetry.fpsMedian.toFixed(1)}、5% {telemetry.fpsP5.toFixed(1)}）</li>
              <li>フレーム時間 p95 {telemetry.frameMsP95.toFixed(1)} ms</li>
              <li>上限で落とした rAF {telemetry.droppedByCap}</li>
              <li>フレーム {telemetry.frame}、アバター {telemetry.avatars}、ピクセル比 {telemetry.pixelRatio}</li>
              <li>レンダラー {telemetry.renderer}{telemetry.contextLost ? '（コンテキスト喪失）' : ''}</li>
            </ul>
          )}
          <p style={styles.note}>SwiftShader の値は実機の GPU の値ではありません。</p>
        </section>
      </aside>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  main: { display: 'flex', height: '100vh', margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f4f5f7' },
  stage: { position: 'relative', flex: 1, minWidth: 0 },
  canvas: { position: 'absolute', inset: 0 },
  status: { position: 'absolute', top: 16, left: 16, margin: 0 },
  panel: { width: 380, overflowY: 'auto', padding: 16, borderLeft: '1px solid #d0d4da', background: '#fff' },
  h1: { fontSize: 18, margin: '0 0 12px' },
  h2: { fontSize: 15, margin: '0 0 8px' },
  section: { marginBottom: 16 },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 14 },
  button: { padding: '4px 8px', border: '1px solid #9aa3ad', borderRadius: 4, background: '#fff', cursor: 'pointer' },
  active: { padding: '4px 8px', border: '1px solid #2f5d9e', borderRadius: 4, background: '#dbe7f7', cursor: 'pointer' },
  list: { margin: 0, paddingLeft: 18, fontSize: 14 },
  note: { fontSize: 12, color: '#5a6470' },
  error: { color: '#b3261e', fontWeight: 'normal' },
};
