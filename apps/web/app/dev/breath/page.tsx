'use client';

/**
 * 準備吸気の単体調整ページ（レーン H2、計画 §4.7 の /lab/breath 相当）。参加者には見せない。
 * スライダで通常呼吸と準備吸気のパラメータを変え、「吸気」「脱力」「発話開始」で確かめる。
 * 発話開始は模擬の音量包絡で口を動かす（音は鳴らさない、実音声ではない）。
 * 「一連の動作」は台本（motion_sequences.ts）を時刻どおりに当て、局面の実時刻を時刻つきで出す（録画や連続画像で比較するため）。
 * クエリ: ?model=/models/xxx.vrm、?framing=face。実ブラウザ確認は window.__breathDev を使う。
 * 値はすべて暫定。自然さは録画で利用者が判断する。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Avatar, AvatarModelInfo, AvatarTelemetry, BreathPhaseEvent, Framing, NormalBreathParams, PrepBreathParams } from '../../../src/avatar';
import { DEFAULT_INHALE_MS, DEFAULT_NORMAL_BREATH, DEFAULT_PREP_BREATH } from '../../../src/avatar/breath';
import { MOTION_SEQUENCES, applyMotionStep, type MotionSequence, type MotionStep, type SequenceTarget } from '../../../src/avatar/motion_sequences';

const DEFAULT_MODEL = '/models/Sendagaya_Shino.vrm';
const FEED_MS = 20;

interface BreathDevHandle {
  avatar(): Avatar | null;
  error(): string | null;
  events: BreathPhaseEvent[];
  /** 模擬の発話の音量を流す（ms）。release('speech_started') は呼ばない。 */
  speak(durationMs: number): void;
  sequences: readonly MotionSequence[];
  /** 台本を実時間で再生する（今の動作は止める）。 */
  playSequence(id: string): void;
}

declare global {
  interface Window {
    __breathDev?: BreathDevHandle;
  }
}

type NumericKeys<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

const PREP_SLIDERS: { key: NumericKeys<PrepBreathParams>; label: string; min: number; max: number; step: number }[] = [
  { key: 'depth', label: '深さ（胸郭モーフ）', min: 0, max: 1, step: 0.01 },
  { key: 'chestPitchDeg', label: '上胸の反り（度、負で後ろ）', min: -5, max: 1, step: 0.1 },
  { key: 'neckCompensation', label: '首で戻す割合', min: 0, max: 1, step: 0.05 },
  { key: 'armPitchCompensation', label: '反りを上腕で戻す割合', min: 0, max: 1, step: 0.05 },
  { key: 'shoulderDeg', label: '肩・鎖骨の挙上（度）', min: 0, max: 8, step: 0.1 },
  { key: 'armCompensation', label: '上腕の逆補正', min: 0, max: 1, step: 0.05 },
  { key: 'headPitchDeg', label: '頭の上下（度、負で上）', min: -5, max: 2, step: 0.1 },
  { key: 'mouthOpen', label: '口の準備（aa）', min: 0, max: 0.4, step: 0.01 },
  { key: 'brow', label: '眉（browUp）', min: 0, max: 0.6, step: 0.01 },
  { key: 'holdMaxMs', label: '保持の上限（ms）', min: 200, max: 3000, step: 50 },
  { key: 'holdChestLevel', label: '保持中の胸（頂点比）', min: 0.5, max: 1, step: 0.01 },
  { key: 'holdMouthLevel', label: '保持中の口（頂点比）', min: 0, max: 1, step: 0.05 },
  { key: 'speechExhaleMs', label: '成功: 発話中の呼気（ms）', min: 300, max: 5000, step: 100 },
  { key: 'speechMouthYieldMs', label: '成功: 口を譲る速さ（ms）', min: 0, max: 300, step: 10 },
  { key: 'deferredExhaleMs', label: 'deferred: 声なしで吐く長さ（ms）', min: 200, max: 3000, step: 50 },
  { key: 'deferredChestResidual', label: 'deferred: 残す胸', min: 0, max: 0.6, step: 0.05 },
  { key: 'deferredMouthResidual', label: 'deferred: 残す唇の開き', min: 0, max: 1, step: 0.05 },
  { key: 'deferredHeadResidual', label: 'deferred: 残す頭', min: 0, max: 1, step: 0.05 },
  { key: 'deferredLingerMs', label: 'deferred: 残りが消える長さ（ms）', min: 0, max: 6000, step: 100 },
  { key: 'withdrawnExhaleMs', label: 'withdrawn: 戻る長さ（ms）', min: 200, max: 2500, step: 50 },
  { key: 'withdrawnMouthCloseMs', label: 'withdrawn: 口を閉じる（ms）', min: 0, max: 600, step: 10 },
  { key: 'shortPrepMs', label: '短い準備の長さ（ms）', min: 80, max: 800, step: 10 },
  { key: 'shortChest', label: '短い準備の胸', min: 0, max: 1, step: 0.05 },
  { key: 'shortMouth', label: '短い準備の口', min: 0, max: 1, step: 0.05 },
  { key: 'postSuppressMs', label: '脱力後の待機の抑制（ms）', min: 0, max: 3000, step: 50 },
  { key: 'idleDuringPrep', label: '吸気中の待機の揺れ', min: 0, max: 1, step: 0.05 },
  { key: 'idleSuppressMs', label: '待機の揺れを抑える時定数（ms）', min: 40, max: 800, step: 10 },
];

const NORMAL_SLIDERS: { key: NumericKeys<NormalBreathParams>; label: string; min: number; max: number; step: number }[] = [
  { key: 'depth', label: '深さ', min: 0, max: 0.6, step: 0.01 },
  { key: 'periodMs', label: '周期（ms）', min: 2000, max: 8000, step: 100 },
  { key: 'inhaleFraction', label: '吸う割合', min: 0.2, max: 0.7, step: 0.01 },
  { key: 'headPitchDeg', label: '頭の上下（度）', min: -1, max: 1, step: 0.05 },
  { key: 'shoulderDeg', label: '肩（度、既定 0）', min: 0, max: 2, step: 0.05 },
];

export default function DevBreathPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const avatarRef = useRef<Avatar | null>(null);
  const errorRef = useRef<string | null>(null);
  const eventsRef = useRef<BreathPhaseEvent[]>([]);
  const speechUntilRef = useRef(0);
  const cueCounter = useRef(0);
  const sequenceTimersRef = useRef<number[]>([]);
  const sequenceStartRef = useRef<number | null>(null);

  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [framing, setFraming] = useState<Framing>('bust');
  const [status, setStatus] = useState('読み込み前');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<AvatarModelInfo | null>(null);
  const [telemetry, setTelemetry] = useState<AvatarTelemetry | null>(null);
  const [inhaleMs, setInhaleMs] = useState(DEFAULT_INHALE_MS);
  const [prep, setPrep] = useState<PrepBreathParams>({ ...DEFAULT_PREP_BREATH });
  const [normal, setNormal] = useState<NormalBreathParams>({ ...DEFAULT_NORMAL_BREATH });
  const [idle, setIdle] = useState(true);
  const [saccades, setSaccades] = useState(true);
  const [autoBlink, setAutoBlink] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const [activeSequence, setActiveSequence] = useState<MotionSequence | null>(null);
  const [timeline, setTimeline] = useState<string[]>([]);

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
    (async () => {
      try {
        const { createAvatar } = await import('../../../src/avatar/runtime');
        if (cancelled) return;
        const avatar = await createAvatar({
          container,
          modelUrl,
          framing,
          onProgress: (loaded, total) => {
            if (!cancelled) setStatus(`読み込み中: ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`);
          },
          onBreathPhase: (event) => {
            eventsRef.current.push(event);
            const start = sequenceStartRef.current;
            if (start !== null) appendTimeline(`t=${(event.nowMs - start).toFixed(0).padStart(5)}ms  ${event.phase}${event.kind ? `[${event.kind}]` : ''}${event.cause ? `（${event.cause}）` : ''}`);
            setLog((prev) => [...prev.slice(-11), `${event.nowMs.toFixed(0)} ms  ${event.phase}${event.kind ? `[${event.kind}]` : ''}${event.cause ? `（${event.cause}）` : ''}${event.cueId ? `  ${event.cueId}` : ''}`]);
          },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUrl]);

  useEffect(() => {
    avatarRef.current?.setFraming(framing);
  }, [framing]);

  // 模擬の発話の音量（音節らしい山）。実音声ではない。
  useEffect(() => {
    let phase = 0;
    const timer = setInterval(() => {
      const avatar = avatarRef.current;
      if (!avatar) return;
      const now = performance.now();
      if (now < speechUntilRef.current) {
        phase += 2 * Math.PI * 5.5 * (FEED_MS / 1000);
        avatar.setMouthLevel(Math.pow(Math.max(0, Math.sin(phase)), 0.6) * 0.12 + 0.01);
      }
    }, FEED_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (avatarRef.current) setTelemetry(avatarRef.current.getTelemetry());
    }, 100);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    window.__breathDev = {
      avatar: () => avatarRef.current,
      error: () => errorRef.current,
      events: eventsRef.current,
      speak: (durationMs) => {
        speechUntilRef.current = performance.now() + durationMs;
      },
      sequences: MOTION_SEQUENCES,
      playSequence: (id) => {
        const sequence = MOTION_SEQUENCES.find((s) => s.id === id);
        if (sequence) playSequence(sequence);
      },
    };
    return () => {
      delete window.__breathDev;
    };
  }, []);

  const appendTimeline = (line: string) => setTimeline((prev) => [...prev, line]);

  /** 台本の再生。時刻は吸気の開始（最初の手）からの ms。今の動作が残っていたら先に聞き手へ戻してから始める。 */
  const playSequence = (sequence: MotionSequence) => {
    const current = avatarRef.current;
    if (!current) return;
    for (const timer of sequenceTimersRef.current) window.clearTimeout(timer);
    sequenceTimersRef.current = [];
    speechUntilRef.current = 0;
    const startDelay = current.breath.phase() === 'idle' ? 0 : 1500;
    if (startDelay > 0) current.breath.release('withdrawn');
    setActiveSequence(sequence);
    setTimeline([`${sequence.label}: ${sequence.note}（全体 ${sequence.totalMs}ms）`]);
    const target: SequenceTarget = {
      breath: current.breath,
      speak: (active) => {
        speechUntilRef.current = active ? performance.now() + 60000 : 0;
      },
    };
    const run = (step: MotionStep) => {
      if (sequenceStartRef.current === null) sequenceStartRef.current = performance.now();
      appendTimeline(`t=${step.atMs.toString().padStart(5)}ms  ▶ ${step.do}`);
      applyMotionStep(target, step);
    };
    sequenceStartRef.current = null;
    for (const step of [...sequence.steps].sort((a, b) => a.atMs - b.atMs)) {
      sequenceTimersRef.current.push(window.setTimeout(() => run(step), startDelay + step.atMs));
    }
    sequenceTimersRef.current.push(
      window.setTimeout(() => {
        setActiveSequence(null);
      }, startDelay + sequence.totalMs),
    );
  };

  const avatar = () => avatarRef.current;
  const inhale = () => {
    cueCounter.current += 1;
    avatar()?.breath.startInhale({ cue_id: `dev-${cueCounter.current}`, duration_ms: inhaleMs });
  };
  const relax = (reason: 'deferred' | 'withdrawn') => avatar()?.breath.release(reason);
  /** deferred の後に許可が出た場合: 再吸気せず短い準備動作 → 発話（計画 §4.6）。 */
  const permitAfterDefer = () => {
    avatar()?.breath.prepareShort?.();
    window.setTimeout(startSpeech, DEFAULT_PREP_BREATH.shortPrepMs + 50);
  };
  const startSpeech = () => {
    avatar()?.breath.release('speech_started');
    speechUntilRef.current = performance.now() + 2500;
  };

  const updatePrep = (patch: Partial<PrepBreathParams>) => {
    setPrep((prev) => ({ ...prev, ...patch }));
    avatar()?.setBreathParams({ prep: patch });
  };
  const updateNormal = (patch: Partial<NormalBreathParams>) => {
    setNormal((prev) => ({ ...prev, ...patch }));
    avatar()?.setBreathParams({ normal: patch });
  };

  const b = telemetry?.breath;

  return (
    <main style={styles.main}>
      <div style={styles.stage}>
        <div ref={containerRef} style={styles.canvas} data-testid="avatar-stage" />
      </div>
      <aside style={styles.panel}>
        <h1 style={styles.h1}>準備吸気の調整（H2）</h1>
        <p style={styles.status} data-testid="status">{status}</p>
        {error && (
          <p style={styles.error} role="alert">
            {error}（{DEFAULT_MODEL} を apps/web/public/models/ へ置くか、?model= で指定）
          </p>
        )}

        <fieldset style={styles.group}>
          <legend>操作</legend>
          <div style={styles.buttons}>
            <button type="button" onClick={inhale} data-testid="inhale">吸気</button>
            <button type="button" onClick={() => relax('deferred')} data-testid="relax">脱力（deferred）</button>
            <button type="button" onClick={() => relax('withdrawn')}>脱力（withdrawn）</button>
            <button type="button" onClick={startSpeech} data-testid="speech">発話開始</button>
            <button type="button" onClick={() => avatar()?.breath.prepareShort?.()}>短い準備（prepareShort）</button>
            <button type="button" onClick={permitAfterDefer}>許可 → 短い準備 → 発話</button>
          </div>
          <label style={styles.row}>
            <input type="range" min={200} max={1200} step={10} value={inhaleMs} onChange={(e) => setInhaleMs(Number(e.target.value))} />
            吸気の長さ {inhaleMs} ms（cue.duration_ms）
          </label>
          <p style={styles.mono} data-testid="phase">
            phase: {b?.phase ?? '-'} / 胸 {b?.chestWeight.toFixed(2) ?? '-'} / 肩 {b?.prep.shoulder.toFixed(2) ?? '-'} / 頭 {b?.prep.head.toFixed(2) ?? '-'} / 口{' '}
            {b?.prep.mouth.toFixed(2) ?? '-'} / 通常呼吸 {b?.normalGain.toFixed(2) ?? '-'} / 待機 {b?.idleScale.toFixed(2) ?? '-'}
            <br />
            種類: {b?.kind ?? '-'} / 戻り方: {b?.releaseKind ?? '-'} / 直近の脱力: {b?.lastReleaseCause ?? '-'} / 無視: {b?.ignoredStarts ?? 0}
          </p>
          <pre style={styles.log}>{log.join('\n')}</pre>
        </fieldset>

        <fieldset style={styles.group}>
          <legend>一連の動作の再生（値はすべて暫定。自然さの判断は録画で行う）</legend>
          <div style={styles.buttons}>
            {MOTION_SEQUENCES.map((sequence) => (
              <button key={sequence.id} type="button" onClick={() => playSequence(sequence)} data-testid={`sequence-${sequence.id}`}>
                {sequence.label}
              </button>
            ))}
          </div>
          <pre style={styles.log} data-testid="timeline">
            {activeSequence ? `再生中: ${activeSequence.label}\n` : ''}
            {timeline.join('\n')}
          </pre>
        </fieldset>

        <fieldset style={styles.group}>
          <legend>切り分け</legend>
          <label style={styles.row}>
            <input type="checkbox" checked={prep.gazeToUser} onChange={(e) => updatePrep({ gazeToUser: e.target.checked })} />
            吸気に合わせて視線を相手へ（既定オフ）
          </label>
          <label style={styles.row}>
            <input
              type="checkbox"
              checked={saccades}
              onChange={(e) => {
                setSaccades(e.target.checked);
                avatar()?.setSaccades(e.target.checked);
              }}
            />
            小さな視線移動
          </label>
          <label style={styles.row}>
            <input
              type="checkbox"
              checked={idle}
              onChange={(e) => {
                setIdle(e.target.checked);
                avatar()?.setIdleIntensity(e.target.checked ? 1 : 0);
              }}
            />
            待機の揺れ
          </label>
          <label style={styles.row}>
            <input
              type="checkbox"
              checked={autoBlink}
              onChange={(e) => {
                setAutoBlink(e.target.checked);
                avatar()?.setAutoBlink(e.target.checked);
              }}
            />
            自動の瞬き
          </label>
          <label style={styles.row}>
            <input type="radio" name="framing" checked={framing === 'bust'} onChange={() => setFraming('bust')} />
            胸から上
            <input type="radio" name="framing" checked={framing === 'face'} onChange={() => setFraming('face')} />
            顔
          </label>
        </fieldset>

        <fieldset style={styles.group}>
          <legend>準備吸気（暫定値）</legend>
          {PREP_SLIDERS.map(({ key, label, min, max, step }) => (
            <label key={key} style={styles.row}>
              <input type="range" min={min} max={max} step={step} value={prep[key]} onChange={(e) => updatePrep({ [key]: Number(e.target.value) })} />
              {label} {prep[key]}
            </label>
          ))}
          <button
            type="button"
            onClick={() => {
              setPrep({ ...DEFAULT_PREP_BREATH });
              avatar()?.setBreathParams({ prep: DEFAULT_PREP_BREATH });
            }}
          >
            既定に戻す
          </button>
        </fieldset>

        <fieldset style={styles.group}>
          <legend>通常呼吸（暫定値）</legend>
          {NORMAL_SLIDERS.map(({ key, label, min, max, step }) => (
            <label key={key} style={styles.row}>
              <input type="range" min={min} max={max} step={step} value={normal[key]} onChange={(e) => updateNormal({ [key]: Number(e.target.value) })} />
              {label} {normal[key]}
            </label>
          ))}
        </fieldset>

        {info && (
          <p style={styles.mono}>
            胸郭モーフ: {info.breathMorph.meshes.length} 面、{info.breathMorph.movedVertices} 頂点、最大 {info.breathMorph.maxDisplacementMm.toFixed(1)} mm（重み 1）、反らすボーン{' '}
            {info.breathMorph.chestBone}
          </p>
        )}
      </aside>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  main: { display: 'flex', height: '100vh', margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f4f4f2', color: '#222' },
  stage: { flex: '1 1 auto', minWidth: 0, position: 'relative' },
  canvas: { position: 'absolute', inset: 0 },
  panel: { width: 380, flex: '0 0 380px', overflowY: 'auto', padding: 12, borderLeft: '1px solid #ccc', background: '#fff', fontSize: 13 },
  h1: { fontSize: 16, margin: '0 0 6px' },
  status: { margin: '0 0 8px', color: '#555' },
  error: { color: '#a00', margin: '0 0 8px' },
  group: { border: '1px solid #ddd', margin: '0 0 10px', padding: 8, display: 'flex', flexDirection: 'column', gap: 4 },
  row: { display: 'flex', alignItems: 'center', gap: 6 },
  buttons: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: 12, margin: '4px 0' },
  log: { fontSize: 11, background: '#f6f6f6', margin: 0, padding: 4, minHeight: 60, whiteSpace: 'pre-wrap' },
};
