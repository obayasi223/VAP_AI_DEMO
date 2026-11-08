'use client';

/**
 * アバターの比較ページ（dev 専用、参加者には見せない）。同じカメラ・同じ吸気の台本で VRM と Rocketbox を並べて再生する。
 * 自然さの判断は人の目で行う（docs/avatar_swap_eval.md の手順）。このページは見え方を揃えるだけで、良し悪しを判定しない。
 * クエリ: ?avatars=vrm,rocketbox（既定は全部）、?framing=face
 * 収集スクリプト用: ?series=speak,defer_withdraw&report=http://localhost:8899（層の時間を止めて連続画像を POST）
 * 確認用の口: window.__avatarCompare（capture、captureSeries）。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Avatar, AvatarModelInfo, FrameTiming } from '../../../src/avatar';
import { AVATAR_MODELS, COMPARE_AVATAR_IDS, SELECTABLE_AVATAR_IDS, isAvatarId, type AvatarId } from '../../../src/avatar/avatar_models';
import { MOTION_SEQUENCES, applyMotionStep, type MotionSequence, type MotionStep, type SequenceTarget } from '../../../src/avatar/motion_sequences';

const FEED_MS = 20;

interface Panel {
  id: AvatarId;
  avatar: Avatar;
  info: AvatarModelInfo;
  canvas: HTMLCanvasElement;
  /** 次の描画直後に呼ぶ（toDataURL は描画と同じタスクでないと空になる）。 */
  next: ((timing: FrameTiming) => void) | null;
}

export interface ComparePanelInfo {
  id: AvatarId;
  status: string;
  morphs: number;
  chestBone: string;
  movedVertices: number;
  maxDisplacementMm: number;
}

export interface CompareSample {
  tMs: number;
  phase: string;
  chestWeight: number;
  prep: Record<string, number>;
  bones: Record<string, { x: number; y: number; z: number } | null>;
  image: string | null;
}

declare global {
  interface Window {
    __avatarCompare?: {
      panels(): ComparePanelInfo[];
      errors(): Record<string, string>;
      play(id: string): void;
      /** 確認用: パネルのアバター。 */
      avatarOf(id: string): Avatar | null;
      capture(id: string): Promise<string>;
      captureSeries(sequenceId: string, sampleMs: number, totalMs?: number, withImages?: boolean): Promise<Record<string, CompareSample[]>>;
    };
  }
}

export default function AvatarComparePage() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const panelsRef = useRef<Map<AvatarId, Panel>>(new Map());
  const errorsRef = useRef<Record<string, string>>({});
  const speakUntilRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  const [ids, setIds] = useState<AvatarId[]>([]);
  const [framing, setFraming] = useState<'bust' | 'face'>('bust');
  const [panels, setPanels] = useState<ComparePanelInfo[]>([]);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string>('');

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const list = (query.get('avatars') ?? COMPARE_AVATAR_IDS.join(',')).split(',').filter(isAvatarId);
    if (query.get('framing') === 'face') setFraming('face');
    setIds(list.length > 0 ? list : COMPARE_AVATAR_IDS);
  }, []);

  useEffect(() => {
    if (ids.length === 0) return;
    let cancelled = false;
    const created: Avatar[] = [];
    const setStatus = (id: AvatarId, status: string) => setStatuses((prev) => ({ ...prev, [id]: status }));
    const initialFraming = new URLSearchParams(window.location.search).get('framing') === 'face' ? 'face' : 'bust';
    void (async () => {
      const { createAvatar } = await import('../../../src/avatar/runtime');
      for (const id of ids) {
        if (cancelled) return;
        const definition = AVATAR_MODELS[id];
        const container = document.querySelector<HTMLElement>(`[data-panel="${id}"]`);
        if (!container || !definition.url || !definition.spec) continue;
        setStatus(id, '読み込み中');
        try {
          let panel: Panel | null = null;
          const avatar = await createAvatar({
            container,
            modelUrl: definition.url,
            model: definition.spec,
            framing: initialFraming,
            onFrameRendered: (timing) => {
              const next = panel?.next;
              if (panel && next) {
                panel.next = null;
                next(timing);
              }
            },
          });
          if (cancelled) {
            avatar.dispose();
            return;
          }
          created.push(avatar);
          const canvas = container.querySelector('canvas') as HTMLCanvasElement;
          panel = { id, avatar, info: avatar.getModelInfo(), canvas, next: null };
          panelsRef.current.set(id, panel);
          setStatus(id, '表示中');
          setPanels(
            [...panelsRef.current.values()].map((p) => ({
              id: p.id,
              status: '表示中',
              morphs: p.info.meshes.reduce((s, m) => s + m.morphTargets.length, 0),
              chestBone: p.info.breathMorph.chestBone,
              movedVertices: p.info.breathMorph.movedVertices,
              maxDisplacementMm: p.info.breathMorph.maxDisplacementMm,
            })),
          );
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          errorsRef.current[id] = message;
          setStatus(id, `読み込み失敗: ${message}`);
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const avatar of created) avatar.dispose();
      panelsRef.current.clear();
    };
  }, [ids]);

  useEffect(() => {
    for (const panel of panelsRef.current.values()) panel.avatar.setFraming(framing);
  }, [framing]);

  // 模擬の発話の音量（/dev/breath と同じ）。音は鳴らさない。
  useEffect(() => {
    let phase = 0;
    const timer = setInterval(() => {
      if (performance.now() >= speakUntilRef.current) return;
      phase += 2 * Math.PI * 5.5 * (FEED_MS / 1000);
      const level = Math.pow(Math.max(0, Math.sin(phase)), 0.6) * 0.12 + 0.01;
      for (const panel of panelsRef.current.values()) panel.avatar.setMouthLevel(level);
    }, FEED_MS);
    return () => clearInterval(timer);
  }, []);

  const play = (sequence: MotionSequence) => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
    speakUntilRef.current = 0;
    setActive(sequence.label);
    const list = [...panelsRef.current.values()];
    const delay = list.some((p) => p.avatar.breath.phase() !== 'idle') ? 1500 : 0;
    if (delay > 0) for (const p of list) p.avatar.breath.release('withdrawn');
    const targets: SequenceTarget[] = list.map((p) => ({
      breath: p.avatar.breath,
      speak: (speaking) => {
        speakUntilRef.current = speaking ? performance.now() + 60000 : 0;
      },
    }));
    for (const step of sequence.steps) {
      timersRef.current.push(
        window.setTimeout(() => {
          for (const target of targets) applyMotionStep(target, step);
        }, delay + step.atMs),
      );
    }
    timersRef.current.push(
      window.setTimeout(() => {
        setActive('');
      }, delay + sequence.totalMs),
    );
  };

  useEffect(() => {
    const capturePanel = (panel: Panel) =>
      new Promise<string>((resolve) => {
        panel.next = () => resolve(panel.canvas.toDataURL('image/png'));
      });
    const nextFrame = (panel: Panel) =>
      new Promise<void>((resolve) => {
        panel.next = () => resolve();
      });
    const BONE_ROLES = ['leftShoulder', 'rightShoulder', 'upperChest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm'];
    const boneSnapshot = (avatar: Avatar): CompareSample['bones'] => {
      const bones: CompareSample['bones'] = {};
      for (const role of BONE_ROLES) bones[role] = avatar.getBoneWorldPosition(role);
      return bones;
    };
    window.__avatarCompare = {
      panels: () =>
        [...panelsRef.current.values()].map((p) => ({
          id: p.id,
          status: 'loaded',
          morphs: p.info.meshes.reduce((s, m) => s + m.morphTargets.length, 0),
          chestBone: p.info.breathMorph.chestBone,
          movedVertices: p.info.breathMorph.movedVertices,
          maxDisplacementMm: p.info.breathMorph.maxDisplacementMm,
        })),
      errors: () => ({ ...errorsRef.current }),
      play: (id) => {
        const sequence = MOTION_SEQUENCES.find((s) => s.id === id);
        if (sequence) play(sequence);
      },
      avatarOf: (id) => panelsRef.current.get(id as AvatarId)?.avatar ?? null,
      capture: async (id) => {
        const panel = panelsRef.current.get(id as AvatarId);
        if (!panel) throw new Error(`no panel ${id}`);
        return capturePanel(panel);
      },
      /** 層の時間を止めて、同じ台本を sampleMs 刻みで進めて記録する（描画の速さの差を除く）。 */
      captureSeries: async (sequenceId, sampleMs, totalMs, withImages = true) => {
        const sequence = MOTION_SEQUENCES.find((s) => s.id === sequenceId);
        if (!sequence) throw new Error(`no sequence ${sequenceId}`);
        const out: Record<string, CompareSample[]> = {};
        for (const panel of panelsRef.current.values()) {
          const { avatar } = panel;
          avatar.setAutoBlink(false);
          avatar.setSaccades(false);
          avatar.setIdleIntensity(0);
          avatar.setTimeScale(0);
          await nextFrame(panel);
          const samples: CompareSample[] = [];
          const end = totalMs ?? sequence.totalMs;
          const steps = [...sequence.steps].sort((a, b) => a.atMs - b.atMs);
          let stepIndex = 0;
          let speaking = false;
          const target: SequenceTarget = { breath: avatar.breath, speak: (s) => (speaking = s) };
          let phaseAngle = 0;
          const baseline = avatar.getTelemetry();
          samples.push({ tMs: 0, phase: baseline.breath.phase, chestWeight: baseline.breath.chestWeight, prep: { ...baseline.breath.prep }, bones: boneSnapshot(avatar), image: withImages ? await capturePanel(panel) : null });
          for (let t = 0; t + sampleMs <= end; t += sampleMs) {
            let step: MotionStep | undefined;
            while ((step = steps[stepIndex]) && step.atMs <= t) {
              applyMotionStep(target, step);
              stepIndex += 1;
            }
            for (let ms = 0; ms < sampleMs; ms += FEED_MS) {
              if (speaking) {
                phaseAngle += 2 * Math.PI * 5.5 * (FEED_MS / 1000);
                avatar.setMouthLevel(Math.pow(Math.max(0, Math.sin(phaseAngle)), 0.6) * 0.12 + 0.01);
              }
              avatar.advanceTime(Math.min(FEED_MS, sampleMs - ms));
              await nextFrame(panel);
            }
            const telemetry = avatar.getTelemetry();
            const bones = boneSnapshot(avatar);
            samples.push({
              // 台本の時刻（ここまで sampleMs 進めた後の姿勢）。
              tMs: t + sampleMs,
              phase: telemetry.breath.phase,
              chestWeight: telemetry.breath.chestWeight,
              prep: { ...telemetry.breath.prep },
              bones,
              image: withImages ? await capturePanel(panel) : null,
            });
          }
          avatar.setAutoBlink(true);
          avatar.setSaccades(true);
          avatar.setIdleIntensity(1);
          avatar.setTimeScale(1);
          out[panel.id] = samples;
        }
        return out;
      },
    };
    // 収集スクリプト用: ?series=speak,defer_withdraw&report=http://localhost:8899（結果を POST する）。
    const query = new URLSearchParams(window.location.search);
    const seriesParam = query.get('series');
    const reportBase = query.get('report');
    if (seriesParam && reportBase) {
      const seriesWanted = seriesParam.split(',');
      const stride = Number(query.get('imageEvery') ?? 2);
      void (async () => {
        await new Promise((r) => setTimeout(r, Number(query.get('warmupMs') ?? 3000)));
        const compare = window.__avatarCompare;
        if (!compare) return;
        for (const seq of seriesWanted) {
          const data = await compare.captureSeries(seq, 100, undefined, true);
          for (const [id, samples] of Object.entries(data)) {
            const images = samples.filter((_, i) => i % stride === 0);
            for (const sample of images) {
              if (sample.image) await fetch(`${reportBase}/shot?n=${encodeURIComponent(`${id}_${seq}_t${String(sample.tMs).padStart(5, '0')}.png`)}`, { method: 'POST', mode: 'cors', body: sample.image });
            }
            await fetch(`${reportBase}/report`, {
              method: 'POST',
              mode: 'cors',
              body: JSON.stringify({ tag: `series_${seq}`, avatar: id, samples: samples.map((x) => ({ ...x, image: null })) }),
            });
          }
        }
        await fetch(`${reportBase}/report`, { method: 'POST', mode: 'cors', body: JSON.stringify({ tag: 'series_done', avatar: 'all' }) });
      })();
    }
    return () => {
      delete window.__avatarCompare;
    };
  }, []);

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <strong>アバター比較（dev 専用）</strong>
        <span style={styles.note}>同じカメラ、同じ吸気の台本。自然さは人が録画や実物で判断する。</span>
        <label>
          枠{' '}
          <select value={framing} onChange={(e) => setFraming(e.target.value as 'bust' | 'face')}>
            <option value="bust">胸から上</option>
            <option value="face">顔</option>
          </select>
        </label>
      </header>
      <div style={styles.buttons}>
        <span style={styles.note}>並べるモデル:</span>
        {SELECTABLE_AVATAR_IDS.map((id) => (
          <label key={id} style={styles.pick}>
            <input
              type="checkbox"
              checked={ids.includes(id)}
              onChange={(e) => {
                const next = e.target.checked ? [...ids, id] : ids.filter((x) => x !== id);
                const q = new URLSearchParams(window.location.search);
                q.set('avatars', next.join(','));
                window.location.search = q.toString();
              }}
            />
            {id}
          </label>
        ))}
      </div>
      <div style={styles.buttons}>
        {MOTION_SEQUENCES.map((s) => (
          <button key={s.id} type="button" onClick={() => play(s)} title={s.note}>
            {s.label}
          </button>
        ))}
        {active && <span style={styles.note}>再生中: {active}</span>}
      </div>
      <div ref={stageRef} style={styles.grid}>
        {ids.map((id) => (
          <section key={id} style={styles.cell}>
            <div style={styles.label}>
              <b>{id}</b> {statuses[id] ?? ''}
            </div>
            <div data-panel={id} style={styles.canvas} />
          </section>
        ))}
      </div>
      <ul style={styles.info}>
        {panels.map((p) => (
          <li key={p.id}>
            {p.id}: モーフ {p.morphs}, 胸の骨 {p.chestBone}, 動く頂点 {p.movedVertices}, 変位の最大 {p.maxDisplacementMm.toFixed(1)}mm
          </li>
        ))}
      </ul>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  main: { fontFamily: 'system-ui, sans-serif', padding: 8, background: '#f4f4f2', color: '#222', minHeight: '100vh' },
  header: { display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' },
  note: { color: '#666', fontSize: 12 },
  pick: { fontSize: 12, display: 'flex', gap: 2, alignItems: 'center' },
  buttons: { display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 8 },
  cell: { background: '#fff', border: '1px solid #ccc' },
  label: { fontSize: 12, padding: 4 },
  canvas: { position: 'relative', width: '100%', aspectRatio: '1 / 1' },
  info: { fontSize: 12, color: '#444' },
};
