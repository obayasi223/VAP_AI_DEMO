'use client';

/**
 * アバターの確認ページ（レーン H1）。参加者には見せない。
 * クエリ: ?model=/models/xxx.vrm（既定は /models/Sendagaya_Shino.vrm）、?framing=face
 * モデルが配信されていないときは、ローカルのファイルを選んでも読める。
 * 実ブラウザ確認（src/avatar/browser_check）は window.__avatarDev を使う。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { GazeReport, GazeTarget } from '@llm-vap/contracts';
import type { Avatar, AvatarModelInfo, AvatarTelemetry, Framing } from '../../../src/avatar';

const DEFAULT_MODEL = '/models/Sendagaya_Shino.vrm';
/** 音量の送り間隔。実際の再生の PCM 枠に近い 20ms。 */
const FEED_MS = 20;
const PCM_SAMPLES = 320;

interface AvatarDevHandle {
  avatar(): Avatar | null;
  /** 手動の音量（RMS）。null で送らない。 */
  setManualRms(rms: number | null): void;
  /** 模擬の音声包絡を PCM で流す。実音声ではない。 */
  setSyntheticSpeech(on: boolean): void;
  gazeReports: GazeReport[];
  error(): string | null;
}

declare global {
  interface Window {
    __avatarDev?: AvatarDevHandle;
  }
}

/** 音節らしい包絡の雑音。pushPcm の経路を通すためだけのもので、口形の評価には使えない。 */
function createSyntheticSpeech() {
  let phase = 0;
  let rate = 5;
  let untilChangeMs = 0;
  let pauseMs = 0;
  return (frameMs: number): Float32Array => {
    untilChangeMs -= frameMs;
    if (untilChangeMs <= 0) {
      rate = 3.5 + Math.random() * 4;
      untilChangeMs = 300 + Math.random() * 900;
      if (Math.random() < 0.15) pauseMs = 150 + Math.random() * 350;
    }
    pauseMs = Math.max(0, pauseMs - frameMs);
    phase += 2 * Math.PI * rate * (frameMs / 1000);
    const envelope = pauseMs > 0 ? 0 : Math.pow(Math.max(0, Math.sin(phase)), 0.7) * 0.25;
    const out = new Float32Array(PCM_SAMPLES);
    for (let i = 0; i < out.length; i += 1) out[i] = (Math.random() * 2 - 1) * envelope;
    return out;
  };
}

function rmsFromDb(db: number): number {
  return Math.pow(10, db / 20);
}

export default function DevAvatarPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const avatarRef = useRef<Avatar | null>(null);
  const manualRmsRef = useRef<number | null>(null);
  const syntheticRef = useRef(false);
  const gazeReportsRef = useRef<GazeReport[]>([]);
  const errorRef = useRef<string | null>(null);

  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [framing, setFraming] = useState<Framing>('bust');
  const [status, setStatus] = useState('読み込み前');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<AvatarModelInfo | null>(null);
  const [telemetry, setTelemetry] = useState<AvatarTelemetry | null>(null);
  const [manualOn, setManualOn] = useState(false);
  const [db, setDb] = useState(-20);
  const [synthetic, setSynthetic] = useState(false);
  const [gaze, setGaze] = useState<GazeTarget>('user');
  const [autoBlink, setAutoBlink] = useState(true);
  const [idle, setIdle] = useState(1);

  // クエリの読み取りはクライアントだけで行う。
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setModelUrl(query.get('model') ?? DEFAULT_MODEL);
    if (query.get('framing') === 'face') setFraming('face');
  }, []);

  useEffect(() => {
    if (!modelUrl) return;
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let created: Avatar | null = null;
    setStatus(`読み込み中: ${modelUrl}`);
    setError(null);
    errorRef.current = null;
    (async () => {
      try {
        // three を SSR に持ち込まない。
        const { createAvatar } = await import('../../../src/avatar/runtime');
        if (cancelled) return;
        const avatar = await createAvatar({
          container,
          modelUrl,
          framing,
          onProgress: (loaded, total) => {
            if (!cancelled) setStatus(`読み込み中: ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`);
          },
          onGazeReport: (report) => gazeReportsRef.current.push(report),
        });
        if (cancelled) {
          avatar.dispose();
          return;
        }
        created = avatar;
        avatarRef.current = avatar;
        setInfo(avatar.getModelInfo());
        setStatus(`表示中: ${modelUrl}`);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        errorRef.current = message;
        setError(message);
        setStatus('読み込み失敗');
      }
    })();
    return () => {
      cancelled = true;
      created?.dispose();
      if (avatarRef.current === created) avatarRef.current = null;
    };
    // framing の変更は setFraming で反映するので作り直さない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUrl]);

  useEffect(() => {
    avatarRef.current?.setFraming(framing);
  }, [framing]);

  // 音量の送り。再生中の PCM と同じ間隔で流す（来なくなると口は閉じる）。
  useEffect(() => {
    const speech = createSyntheticSpeech();
    const timer = setInterval(() => {
      const avatar = avatarRef.current;
      if (!avatar) return;
      if (syntheticRef.current) avatar.pushPcm(speech(FEED_MS));
      else if (manualRmsRef.current !== null) avatar.setMouthLevel(manualRmsRef.current);
    }, FEED_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (avatarRef.current) setTelemetry(avatarRef.current.getTelemetry());
    }, 200);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    window.__avatarDev = {
      avatar: () => avatarRef.current,
      setManualRms: (rms) => {
        manualRmsRef.current = rms;
      },
      setSyntheticSpeech: (on) => {
        syntheticRef.current = on;
      },
      gazeReports: gazeReportsRef.current,
      error: () => errorRef.current,
    };
    return () => {
      delete window.__avatarDev;
    };
  }, []);

  const applyManual = useCallback((on: boolean, nextDb: number) => {
    manualRmsRef.current = on ? rmsFromDb(nextDb) : null;
  }, []);

  const chooseGaze = (target: GazeTarget) => {
    setGaze(target);
    avatarRef.current?.setGaze(target);
  };

  return (
    <main style={styles.main}>
      <div style={styles.stage}>
        <div ref={containerRef} style={styles.canvas} data-testid="avatar-stage" />
      </div>
      <aside style={styles.panel}>
        <h1 style={styles.h1}>アバター確認（H1）</h1>
        <p style={styles.status} data-testid="status">{status}</p>
        {error && (
          <div style={styles.error} role="alert">
            <p style={{ margin: 0 }}>{error}</p>
            <p style={{ margin: '4px 0 0' }}>
              {DEFAULT_MODEL} が配信されていないときは apps/web/public/models/ へ置くか、下でファイルを選んでください。
            </p>
          </div>
        )}
        <label style={styles.row}>
          モデル
          <input
            type="file"
            accept=".vrm"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) setModelUrl(URL.createObjectURL(file));
            }}
          />
        </label>

        <fieldset style={styles.group}>
          <legend>口（音量）</legend>
          <label style={styles.row}>
            <input
              type="checkbox"
              checked={manualOn}
              onChange={(e) => {
                setManualOn(e.target.checked);
                applyManual(e.target.checked, db);
              }}
            />
            手動の音量を送る
          </label>
          <label style={styles.row}>
            <input
              type="range"
              min={-60}
              max={-6}
              step={1}
              value={db}
              onChange={(e) => {
                const next = Number(e.target.value);
                setDb(next);
                applyManual(manualOn, next);
              }}
            />
            {db} dBFS
          </label>
          <label style={styles.row}>
            <input
              type="checkbox"
              checked={synthetic}
              onChange={(e) => {
                setSynthetic(e.target.checked);
                syntheticRef.current = e.target.checked;
              }}
            />
            模擬の音声包絡（実音声ではない）
          </label>
          <button
            type="button"
            onClick={() => {
              setManualOn(false);
              setSynthetic(false);
              manualRmsRef.current = null;
              syntheticRef.current = false;
              avatarRef.current?.closeMouth();
            }}
          >
            発話停止（すぐ閉じる）
          </button>
        </fieldset>

        <fieldset style={styles.group}>
          <legend>視線（外部入力の代わり）</legend>
          <label style={styles.row}>
            <input type="radio" name="gaze" checked={gaze === 'user'} onChange={() => chooseGaze('user')} />
            見る
          </label>
          <label style={styles.row}>
            <input type="radio" name="gaze" checked={gaze === 'away'} onChange={() => chooseGaze('away')} />
            そらす
          </label>
        </fieldset>

        <fieldset style={styles.group}>
          <legend>待機</legend>
          <label style={styles.row}>
            <input
              type="checkbox"
              checked={autoBlink}
              onChange={(e) => {
                setAutoBlink(e.target.checked);
                avatarRef.current?.setAutoBlink(e.target.checked);
              }}
            />
            自動の瞬き
          </label>
          <button type="button" onClick={() => avatarRef.current?.triggerBlink()}>
            今すぐ瞬き
          </button>
          <label style={styles.row}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={idle}
              onChange={(e) => {
                const next = Number(e.target.value);
                setIdle(next);
                avatarRef.current?.setIdleIntensity(next);
              }}
            />
            揺れ {idle.toFixed(2)}
          </label>
        </fieldset>

        <label style={styles.row}>
          <input
            type="checkbox"
            checked={framing === 'face'}
            onChange={(e) => setFraming(e.target.checked ? 'face' : 'bust')}
          />
          顔に寄る
        </label>

        <h2 style={styles.h2}>値</h2>
        <pre style={styles.pre} data-testid="telemetry">
          {telemetry
            ? [
                `fps ${telemetry.fps.toFixed(1)}  frame ${telemetry.frame}`,
                `mouth.open ${telemetry.mouth.open.toFixed(3)}  aa ${telemetry.mouth.appliedAa.toFixed(3)}`,
                `blink ${telemetry.blink.weight.toFixed(2)}  count ${telemetry.blink.count}`,
                `gaze ${telemetry.gaze.target}  away ${telemetry.gaze.awayAmount.toFixed(2)}  settled ${telemetry.gaze.settled}`,
                `eye(L) yaw ${telemetry.gaze.leftEyeYawDeg.toFixed(2)}  pitch ${telemetry.gaze.leftEyePitchDeg.toFixed(2)}`,
                `eye(R) yaw ${telemetry.gaze.rightEyeYawDeg.toFixed(2)}  pitch ${telemetry.gaze.rightEyePitchDeg.toFixed(2)}`,
                `head yaw ${telemetry.head.yawDeg.toFixed(2)}  pitch ${telemetry.head.pitchDeg.toFixed(2)}  roll ${telemetry.head.rollDeg.toFixed(2)}`,
                `layers ${telemetry.layers.join(' > ')}`,
              ].join('\n')
            : 'まだ描画していない'}
        </pre>

        {info && (
          <details>
            <summary>モデルの情報</summary>
            <pre style={styles.pre}>
              {JSON.stringify(
                {
                  expressions: info.expressions,
                  lookAt: info.lookAt,
                  meshes: info.meshes.map((m) => ({ ...m, morphTargets: m.morphTargets.length })),
                  missingHumanBones: info.missingHumanBones,
                },
                null,
                1,
              )}
            </pre>
          </details>
        )}
      </aside>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  main: {
    display: 'flex',
    flexWrap: 'wrap',
    minHeight: '100vh',
    margin: 0,
    fontFamily: 'system-ui, sans-serif',
    fontSize: 14,
    color: '#1f2328',
    background: '#f6f7f8',
  },
  stage: { flex: '1 1 480px', minWidth: 320, height: '100vh', position: 'relative' },
  canvas: { position: 'absolute', inset: 0 },
  panel: {
    flex: '0 1 340px',
    padding: 16,
    boxSizing: 'border-box',
    maxHeight: '100vh',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    background: '#ffffff',
    borderLeft: '1px solid #d8dbe0',
  },
  h1: { fontSize: 18, margin: 0 },
  h2: { fontSize: 14, margin: '6px 0 0' },
  status: { margin: 0, color: '#57606a', overflowWrap: 'anywhere' },
  error: { padding: 8, background: '#fde8e8', color: '#7a1212', borderRadius: 4, overflowWrap: 'anywhere' },
  group: { display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid #d8dbe0', borderRadius: 4 },
  row: { display: 'flex', alignItems: 'center', gap: 6 },
  pre: { margin: 0, padding: 8, background: '#f0f2f4', fontSize: 12, overflowX: 'auto' },
};
