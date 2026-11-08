/**
 * AI の発話の結果の分類（観測だけ、判断に使わない）の表。値は作り物で、実測ではない。
 */
import { describe, expect, it } from 'vitest';
import { absent, present, type TurnAllowedPayload, type TurnOutcomeLabel } from '@llm-vap/contracts';
import { buildTurnOutcome, continuationAfter, noResponseOutcome } from '../../src/control/turn_outcome';
import type { OutcomeSettings, OutcomeSttRow, OutcomeVapRow } from '../../src/control/turn_outcome';

const FPMS = 16;
const SETTINGS: OutcomeSettings = {
  continuation_window_ms: 1500,
  settle_ms: 1000,
  user_just_before_ms: 1500,
  premature_onset_max_ms: 800,
  overlap_min_ms: 240,
  interrupted_early_max_ms: 2000,
  no_response_wait_ms: 4000,
  echo_text_similarity: 0.6,
  echo_overlap_ratio: 0.7,
  speaking_threshold: 0.5,
  backchannel_phrases: ['はい', 'うん', 'なるほど'],
};
const T0 = 10_000;
const FRAME0 = T0 * FPMS;

const payload = (over: Partial<TurnAllowedPayload> = {}): TurnAllowedPayload => ({
  turn_allowed: true,
  invitation: { detected: false },
  user_speaking: false,
  p_now: present(0.66),
  p_future: present(0.7),
  completion_p: present(0.75),
  completion_revision: present(5),
  gap_ms: present(600),
  priority: absent('no_priority'),
  policy_id: 'ja',
  decision_source: 'vap',
  vap_freshness: 'fresh',
  fallback_energy: absent('vap_is_fresh'),
  reason: 'L67_vap_yield',
  ...over,
});

/** 開始 T0、再生 T0+40〜T0+4040（4 秒）。vad はフレームごとの値（80ms 周期）。 */
function vapRows(voiced: (offsetMs: number) => boolean, from = -2000, to = 5000): OutcomeVapRow[] {
  const rows: OutcomeVapRow[] = [];
  for (let off = from; off <= to; off += 80) rows.push({ t: T0 + off, frame: FRAME0 + off * FPMS, vad_user: voiced(off) ? 0.9 : 0.1 });
  return rows;
}

const stt = (offsetMs: number, text: string, key = 1, audioOffsetMs = offsetMs): OutcomeSttRow => ({
  t: T0 + offsetMs,
  key,
  audio_frame_end: FRAME0 + audioOffsetMs * FPMS,
  text,
});

interface Case {
  name: string;
  voiced?: (off: number) => boolean;
  stt?: OutcomeSttRow[];
  interrupted?: boolean;
  playedMs?: number;
  spoken?: string | null;
  previous?: boolean;
  nullReason?: string | null;
  playback?: boolean;
  phrases?: string[] | null;
  labels: TurnOutcomeLabel[] | { null: string };
}

const lastVoiceBefore = (off: number) => off < -600; // 既定: 開始の 600ms 前まで声

const CASES: Case[] = [
  { name: 'VAP も ASR も問題なし', voiced: lastVoiceBefore, labels: [] },
  {
    name: 'VAP が正常なのに人の発話の途中で始めた（50.28 秒の形: 直前まで声、続きの文）',
    voiced: (off) => off < -500 || (off > 40 && off < 400),
    stt: [stt(-200, '話の前半です', 1, -500), stt(400, 'で', 2)],
    labels: ['user_continued_after_start', 'suspected_premature_start', 'user_overlap'],
  },
  {
    name: '相槌だけの重なりは user_overlap にしない',
    voiced: (off) => off < -600 || (off > 40 && off < 500),
    stt: [stt(-200, '話の前半です', 1, -500), stt(450, 'はい', 2)],
    labels: ['backchannel_overlap'],
  },
  {
    name: '相槌の文があり vad の重なりが短いときも backchannel_overlap',
    voiced: lastVoiceBefore,
    stt: [stt(-200, '話の前半です', 1, -500), stt(300, 'うん', 2, 200)],
    labels: ['backchannel_overlap'],
  },
  {
    name: '声はあるが ASR の文がない重なり',
    voiced: (off) => off < -600 || (off > 1000 && off < 1600),
    labels: ['overlap_without_asr'],
  },
  {
    name: '短い vad の重なりと内容の文（重なりは数えない、続きは数える）',
    voiced: (off) => off < -600 || (off > 40 && off < 100),
    stt: [stt(-200, '前半', 1, -500), stt(300, 'それは違います', 2)],
    labels: ['user_continued_after_start', 'suspected_premature_start'],
  },
  {
    name: '直前の声が古いときは suspected_premature_start にしない',
    voiced: (off) => off < -4000,
    stt: [stt(300, '別の話です', 2)],
    labels: ['user_continued_after_start'],
  },
  {
    name: 'VAP の値がない区間の内容の文は user_overlap',
    voiced: lastVoiceBefore,
    stt: [stt(1000, '聞いてください', 2)],
    labels: ['user_continued_after_start', 'user_overlap'],
  },
  { name: '短いうちに割り込まれた', voiced: lastVoiceBefore, interrupted: true, playedMs: 1500, labels: ['ai_interrupted_early'] },
  { name: '長く話してから割り込まれた', voiced: lastVoiceBefore, interrupted: true, playedMs: 4000, labels: [] },
  {
    name: '前の AI の発話の後に人の声がないまま話し始めた（58.08 秒の形）',
    voiced: (off) => off < -5000,
    previous: true,
    labels: ['spoke_twice'],
  },
  {
    name: 'エコーの疑い（文が AI の発話文と似て、再生のほとんどで声）は分類しない',
    voiced: (off) => off > 40,
    stt: [stt(1000, '今日はとても良い天気ですね', 2)],
    spoken: '今日はとても良い天気ですね',
    labels: { null: 'echo_suspected' },
  },
  {
    name: '文が似ていても声の割合が低ければエコーにしない',
    voiced: (off) => off < -600 || (off > 40 && off < 420),
    stt: [stt(1000, '今日はとても良い天気ですね', 2)],
    spoken: '今日はとても良い天気ですね',
    labels: ['user_continued_after_start', 'suspected_premature_start', 'user_overlap'],
  },
  {
    name: '再生の中止で確定しない（理由を null_reason に残す）',
    voiced: lastVoiceBefore,
    stt: [stt(300, 'それは違います', 2)],
    nullReason: 'playback_ended_abnormally',
    labels: { null: 'playback_ended_abnormally' },
  },
  { name: '音声が流れなかった', playback: false, nullReason: 'no_audio_played', labels: { null: 'no_audio_played' } },
  {
    name: 'hri2025 は相槌の語句がないので文を内容として扱う',
    voiced: (off) => off < -600 || (off > 40 && off < 500),
    stt: [stt(-200, '話の前半です', 1, -500), stt(450, 'はい', 2)],
    phrases: null,
    labels: ['user_continued_after_start', 'suspected_premature_start', 'user_overlap'],
  },
];

function run(c: Case) {
  const noVap = c.name === 'VAP の値がない区間の内容の文は user_overlap';
  const played = c.playedMs ?? 4000;
  const vap = noVap ? vapRows(lastVoiceBefore).filter((r) => r.frame <= FRAME0) : vapRows(c.voiced ?? lastVoiceBefore);
  return buildTurnOutcome(
    {
      start: {
        audio_playback_id: 7,
        segment_id: 3,
        origin: 'response',
        candidate_id: absent('normal_response'),
        conversation_kind: absent('none'),
        decided_at: T0,
        audio_frame: FRAME0,
        payload: payload(),
        vad: { user: 0.1, ai: 0.1 },
        vap_age_ms: 30,
      },
      playback:
        c.playback === false
          ? null
          : {
              started_at: T0 + 40,
              start_frame: FRAME0 + 40 * FPMS,
              ended_at: T0 + 40 + played,
              end_frame: FRAME0 + (40 + played) * FPMS,
              interrupted: c.interrupted ?? false,
              spoken_text: c.spoken ?? '別の文を話しています',
            },
      null_reason: c.nullReason ?? null,
      vap,
      stt: c.stt ?? [],
      previous_ai_end: c.previous ? { at: T0 - 1000 } : null,
    },
    { ...SETTINGS, backchannel_phrases: c.phrases === undefined ? SETTINGS.backchannel_phrases : c.phrases },
  );
}

describe('発話の結果の分類（表）', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const outcome = run(c);
    if ('null' in c.labels) {
      expect(outcome.labels).toEqual({ value: null, null_reason: c.labels.null });
    } else {
      expect(outcome.labels.value).toEqual(expect.arrayContaining(c.labels));
      expect(outcome.labels.value).toHaveLength(c.labels.length);
    }
  });

  it('エコーの疑いの発話は分類せず、印を残す', () => {
    const outcome = run(CASES.find((c) => c.name.startsWith('エコーの疑い'))!);
    expect(outcome.observed.echo.suspected).toBe(true);
    expect(outcome.observed.echo.text_similarity.value).toBeGreaterThan(0.9);
  });
  it('発話の途中の開始の値（開始の後の音声の位置と文字数）を残す', () => {
    const outcome = run(CASES[1]!);
    expect(outcome.observed.continuation.continued).toBe(true);
    expect(outcome.observed.continuation.first_audio_offset_ms.value).toBe(400);
    expect(outcome.observed.continuation.text_kind).toBe('content');
    expect(outcome.observed.user_voice_gap_before_ms.value).toBeLessThanOrEqual(1500);
    expect(outcome.observed.overlap.overlap_ms.value).toBeGreaterThanOrEqual(240);
  });
  it('VAP が区間にないと overlap_ms は null と理由', () => {
    const outcome = run(CASES.find((c) => c.name.startsWith('VAP の値がない'))!);
    expect(outcome.observed.overlap.overlap_ms).toEqual({ value: null, null_reason: 'no_vap_during_speech' });
  });
});

describe('話すべき間に話さなかった場合', () => {
  const state = (over: Partial<Parameters<typeof noResponseOutcome>[0]['state']> = {}) => ({
    speaking: { phase: 'silent' as const },
    user_speaking: false,
    asr_result: 'これで終わりです',
    asr_revision: 9,
    asr_is_final: true,
    last_asr_time: 1000,
    ignored_fragment: null,
    segment_id: 2,
    permitted_to_speak: false,
    vap_freshness: 'fresh' as const,
    ...over,
  });
  const base = { now: 6000, latest_allowed: payload(), last_user_voice_at: 1000, last_ai_end_at: 500, start_blocked_reason: null, fired_key: null };

  it('声と ASR が止まってから待ちを超えたら1回記録する', () => {
    const result = noResponseOutcome({ ...base, state: state() }, SETTINGS);
    expect(result?.body.kind).toBe('no_response');
    expect(result?.body.labels.value).toEqual(['no_response_after_user_yield']);
    expect(result?.body.waited_ms).toBe(5000);
    expect(result?.body.wait_state).toBe('not_permitted');
  });
  it.each([
    ['待ちの前', { now: 4000 }],
    ['AI の発話の後の声ではない', { last_ai_end_at: 2000 }],
    ['開始を止める理由がある間（吸気の保留など）', { start_blocked_reason: 'hold' }],
    ['同じ発話は1回だけ', { fired_key: '2:9' }],
  ])('%s は記録しない', (_name, over) => {
    expect(noResponseOutcome({ ...base, state: state(), ...over }, SETTINGS)).toBeNull();
  });
  it('AI の発話の断片（ignored_fragment）は対象にしない', () => {
    expect(noResponseOutcome({ ...base, state: state({ ignored_fragment: { segment_id: 2, text: 'で', transcript_revision: 9, reason: 'short', at: 900 } }) }, SETTINGS)).toBeNull();
  });
  it('発話の文がなければ対象にしない', () => {
    expect(noResponseOutcome({ ...base, state: state({ asr_result: null }) }, SETTINGS)).toBeNull();
  });
});

describe('/tune の定義の再利用', () => {
  it('continuationAfter は開始より後の音声の伸びだけを数える', () => {
    const rows: OutcomeSttRow[] = [
      { t: T0 - 300, key: 1, audio_frame_end: FRAME0 - 100, text: 'まえ' },
      { t: T0 + 500, key: 1, audio_frame_end: FRAME0 - 50, text: 'まえの伸び' }, // 音声が開始より前
    ];
    expect(continuationAfter(rows, FRAME0, T0, 1500).continued).toBe(false);
    rows.push({ t: T0 + 700, key: 2, audio_frame_end: FRAME0 + 16000, text: 'つづき' });
    expect(continuationAfter(rows, FRAME0, T0, 1500)).toMatchObject({ continued: true, text: 'つづき' });
  });
});
