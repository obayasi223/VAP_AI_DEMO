'use client';

/**
 * 2 体のモードの参加者画面（URL は /two_ai。docs/design/two_ai/03 §1、§3.1、§3.2）。
 * 1 対 1 の画面（app/(participant)/page.tsx）と participant.ts は変えない。
 * クエリ: ?ws=ws://localhost:8787/ws（既定は NEXT_PUBLIC_ORCHESTRATOR_WS_URL、なければ同じホストの 8787。mode=two_ai は自動で足す）
 *         ?avatar_a=rb_fa03&avatar_b=rb_ma09（モデル。既定は Rocketbox の 2 体。none で描かない）
 *         ?layout_yaw=35&layout_spacing=0.9&fov=24（配置。使った値は avatar.report に残す）
 *         ?fps=30（描画の上限）  ?marker_side=left|right（印のボタンの置き場。マイクから遠い側）
 *         ?breath_sound=0.006 ?breath_profile=default|original|weak
 * 条件は受け取らない・選ばない（研究画面の arm で決まる）。試験は window.__twoAi を読む。
 */
import { useEffect, useRef, useState } from 'react';
import type { AiId } from '@llm-vap/contracts/common';
import type { AvatarReport } from '@llm-vap/contracts/browser_rpc';
import { AVATAR_MODELS, avatarRecord, isAvatarId, type AvatarChoice, type AvatarId } from '../../../src/avatar/avatar_models';
import { BREATH_PROFILES, parseBreathProfile } from '../../../src/avatar/breath_profile';
import { parseBreathSoundGain } from '../../../src/session/breath_sound';
import { MARKER_FLASH_MS } from '../../../src/session/two_ai_marker';
import { INITIAL_TWO_AI_VIEW, TwoAiParticipantController, type TwoAiView } from '../../../src/session/two_ai_participant';
import type { Stage } from '../../../src/avatar/stage';
import { TwoAiScreen } from './TwoAiScreen';

declare global {
  interface Window {
    __twoAi?: { controller: TwoAiParticipantController; stage: () => Stage | null };
  }
}

/** 既定のモデルの組（軽い Rocketbox の 2 体。未決事項 03 §8 の 1）。 */
const DEFAULT_AVATARS: Record<AiId, AvatarId> = { A: 'rb_fa03', B: 'rb_ma09' };
/** 案内のカードを出す長さ（03 §3.2）。 */
const INSTRUCTION_CARD_MS = 8000;
/** 同期の印を出す長さ（06 §4.7）。 */
const SYNC_FLASH_MS = 200;
/** 2 体の描画の上限の既定（03 §6）。 */
const TWO_AI_DEFAULT_MAX_FPS = 30;

function defaultWsUrl(): string {
  const query = new URLSearchParams(window.location.search).get('ws');
  if (query) return query;
  const env = process.env.NEXT_PUBLIC_ORCHESTRATOR_WS_URL;
  if (env) return env;
  return `ws://${window.location.hostname}:8787/ws`;
}

function choiceFor(ai_id: AiId, query: URLSearchParams): AvatarChoice {
  const raw = query.get(ai_id === 'A' ? 'avatar_a' : 'avatar_b');
  if (raw !== null && isAvatarId(raw)) return { ...AVATAR_MODELS[raw], source: 'query', rejected: null };
  return { ...AVATAR_MODELS[DEFAULT_AVATARS[ai_id]], source: 'default', rejected: raw };
}

function numberParam(query: URLSearchParams, name: string): number | null {
  const raw = query.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export default function TwoAiPage() {
  const stageRef = useRef<Stage | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<TwoAiParticipantController | null>(null);
  const [view, setView] = useState<TwoAiView>(INITIAL_TWO_AI_VIEW);
  const [syncFlash, setSyncFlash] = useState(false);
  const [markerFlash, setMarkerFlash] = useState(false);
  const [instructionCard, setInstructionCard] = useState(false);
  const [markerSide, setMarkerSide] = useState<'left' | 'right'>('left');

  if (controllerRef.current === null && typeof window !== 'undefined') {
    const query = new URLSearchParams(window.location.search);
    controllerRef.current = new TwoAiParticipantController({
      wsUrl: defaultWsUrl(),
      stage: () => stageRef.current,
      onView: setView,
      breathSoundGain: parseBreathSoundGain(query.get('breath_sound')),
      breathProfile: parseBreathProfile(query.get('breath_profile')),
      onSyncMark: () => {
        setSyncFlash(true);
        setTimeout(() => setSyncFlash(false), SYNC_FLASH_MS);
      },
    });
  }

  useEffect(() => {
    setMarkerSide(new URLSearchParams(window.location.search).get('marker_side') === 'right' ? 'right' : 'left');
  }, []);

  // 2 体のステージ（1 つの canvas、1 つのレンダラー）。片方の失敗でもう片方を止めない。
  useEffect(() => {
    const container = containerRef.current;
    const controller = controllerRef.current;
    if (!container || !controller) return;
    const query = new URLSearchParams(window.location.search);
    const choices: Record<AiId, AvatarChoice> = { A: choiceFor('A', query), B: choiceFor('B', query) };
    let cancelled = false;
    let created: Stage | null = null;
    const specs = (['A', 'B'] as AiId[]).filter((ai_id) => choices[ai_id].spec !== null && choices[ai_id].url !== null);
    for (const ai_id of ['A', 'B'] as AiId[]) {
      if (!specs.includes(ai_id)) controller.setAvatarRecord(ai_id, avatarRecord(choices[ai_id], 'disabled'));
    }
    if (specs.length === 0) return;
    (async () => {
      try {
        const { createStage } = await import('../../../src/avatar/stage');
        const { parseLayoutQuery } = await import('../../../src/avatar/stage_layout');
        const { TWO_AI_RENDER } = await import('../../../src/avatar/render_settings');
        const fpsQuery = numberParam(query, 'fps');
        /** このページは描画の上限を常に明示する（記録の値と実際を合わせる。2 体の既定 30、03 §6）。 */
        const maxFps = fpsQuery !== null && fpsQuery > 0 ? fpsQuery : TWO_AI_DEFAULT_MAX_FPS;
        const stage = await createStage({
          container,
          avatars: specs.map((ai_id) => ({ ai_id, modelUrl: choices[ai_id].url as string, model: choices[ai_id].spec as NonNullable<AvatarChoice['spec']> })),
          layout: parseLayoutQuery(window.location.search),
          render: TWO_AI_RENDER,
          maxFps,
          onGazeReport: (ai_id, report) => controllerRef.current?.gazeRendered(ai_id, report),
          onAvatarLoad: (ai_id, result) => {
            if (result.status === 'failed') controllerRef.current?.setAvatarRecord(ai_id, avatarRecord(choices[ai_id], 'failed', result.error.slice(0, 300)));
          },
          onContextLost: () => {
            for (const ai_id of specs) controllerRef.current?.setAvatarRecord(ai_id, avatarRecord(choices[ai_id], 'failed', 'context_lost'));
          },
        });
        if (cancelled) {
          stage.dispose();
          return;
        }
        created = stage;
        stageRef.current = stage;
        const telemetry = stage.getTelemetry();
        const extra: Pick<AvatarReport, 'render_profile' | 'layout'> = {
          render_profile: {
            max_fps: maxFps,
            pixel_ratio: telemetry.pixelRatio,
            spring_bones: TWO_AI_RENDER.springBones === false ? 'none' : 'all',
          },
        };
        const profile = BREATH_PROFILES[parseBreathProfile(query.get('breath_profile'))];
        for (const ai_id of specs) {
          const avatar = stage.avatar(ai_id);
          if (avatar === null) continue;
          avatar.setBreathParams({ prep: profile });
          controllerRef.current?.setAvatarRecord(ai_id, avatarRecord(choices[ai_id], 'loaded'), {
            ...extra,
            layout: { side: ai_id === 'A' ? 'left' : 'right', body_yaw_deg: stage.layout.bodyYawDeg, spacing_m: stage.layout.halfSpacingM * 2 },
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const ai_id of specs) controllerRef.current?.setAvatarRecord(ai_id, avatarRecord(choices[ai_id], 'failed', message.slice(0, 300)));
      }
    })();
    return () => {
      cancelled = true;
      created?.dispose();
      stageRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    window.__twoAi = { controller, stage: () => stageRef.current };
    return () => {
      delete window.__twoAi;
    };
  }, []);

  // discussion の始めに案内のカードを 8 秒出し、その後は上端の 1 行に残す（両条件で同じ時機）。
  useEffect(() => {
    if (view.phase !== 'discussion') {
      setInstructionCard(false);
      return;
    }
    setInstructionCard(true);
    const timer = setTimeout(() => setInstructionCard(false), INSTRUCTION_CARD_MS);
    return () => clearTimeout(timer);
  }, [view.phase]);

  // 印のボタンの短い光（両条件で同じ。AI の表示は変えない）。
  useEffect(() => {
    if (view.markerPresses === 0) return;
    setMarkerFlash(true);
    const timer = setTimeout(() => setMarkerFlash(false), MARKER_FLASH_MS);
    return () => clearTimeout(timer);
  }, [view.markerPresses]);

  return (
    <TwoAiScreen
      view={view}
      stageRef={containerRef}
      instructionCard={instructionCard}
      markerFlash={markerFlash}
      syncFlash={syncFlash}
      markerSide={markerSide}
      onStart={() => void controllerRef.current?.start({ scenario: null })}
      onStop={() => void controllerRef.current?.stop()}
      onMark={() => controllerRef.current?.mark()}
      onPick={(card_id) => controllerRef.current?.pick(card_id)}
    />
  );
}
