/**
 * 技術評価の偽マイクの素材（本人役の合成音声と、声でない音）を作る。
 *
 * - 声：Gemini TTS の合成音声だけ（tools/two_ai_eval/stimuli/*.wav と tools/provider_probe/out/reading_roundtrip/gemini__s*.wav）。
 *   実在の人の声（models/ja.wav を含む）は使わない。
 * - 声でない音：咳に似た雑音（帯域を絞った雑音の短い破裂 2〜3 回）、息（弱い／強い）。どちらもここで作る。
 * - 正解（truth.json）：各刺激の種類、ファイル上の声の始まりと終わり（秒）。始まりは素材の中で RMS が -40 dBFS を越えた最初の 10 ms。
 * - 台本の STT の文（stt_script.json）：EnergyScriptedSttProvider と同じ区切り（20 ms ごとの RMS ≥ -40 dBFS、600 ms の無音で final）を
 *   16 kHz で真似て、区間ごとに文を割り当てる。声でない音の区間は ''（文なし。実の STT が咳に文を返さない想定）。
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWavMono16, resampleInt16, writeWavMono16 } from '../../apps/web/test/audio_browser/signal';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../..');
const MIC_RATE = 48000;

export type StimKind = 'speech' | 'backchannel' | 'cough' | 'breath_soft' | 'breath_loud' | 'intake';
export interface Stim {
  idx: number;
  kind: StimKind;
  clip: string;
  text: string;
  /** ファイル上の声の始まりと終わり（秒）。 */
  onset_s: number;
  offset_s: number;
  rms_dbfs: number;
}

/** 本人役の声の文（台本の STT が返す）。clip の名前 → 文。 */
const SPEECH_TEXT: Record<string, string> = {
  sp_chigau: 'いや、そこは少し違うと思います。',
  sp_shimekiri: '締切は二月末で合っています。',
  sp_kenkyu: '研究が嫌いなわけではないんです。',
  sp_chotto: 'ちょっといいですか、それは前提が違います。',
  sp_sounan: 'そうなんですけど、お金のことも気になっていて。',
  sp_senpai: '先輩にも同じことを言われました。',
};
const BC_TEXT: Record<string, string> = { bc_un: 'うん', bc_hai: 'はい', bc_unun: 'うんうん', bc_naruhodo: 'なるほど' };
/** intake の穴を埋める文（2 体の e2e と同じ。U4）。声は gemini__s* を使い、文は台本の STT が返す。 */
export const INTAKE_TEXT = [
  '博士課程に進むか、インターンに応募して就職するかで迷っています。',
  'いちばん引っかかっているのは、自分に研究の才能があるか分からないことです。',
  'インターンの締切は 2 月末で、研究科の説明会は 1 月 15 日です。',
  'はい、そのとおりです。',
];
export const INTAKE_VOICE_AT_S = [3, 14, 26, 42];

/** 決まった種の乱数（mulberry32）。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rmsDb(x: ArrayLike<number>, s: number, e: number): number {
  let sum = 0;
  for (let i = s; i < e; i++) sum += (x[i] as number) ** 2;
  const r = Math.sqrt(sum / Math.max(1, e - s)) / 32768;
  return r > 0 ? 20 * Math.log10(r) : -150;
}

/** 素材の中の声の範囲（10 ms の RMS が thr を越える最初と最後）。 */
export function voicedSpan(x: Int16Array, rate: number, thr = -40): { on: number; off: number } {
  const w = Math.round(rate * 0.01);
  let on = -1;
  let off = -1;
  for (let i = 0; i + w <= x.length; i += w) {
    if (rmsDb(x, i, i + w) >= thr) {
      if (on < 0) on = i;
      off = i + w;
    }
  }
  return { on: Math.max(0, on), off: Math.max(0, off) };
}

/** 声の部分の RMS を target dBFS にそろえる。 */
function normalize(x: Int16Array, rate: number, targetDb: number): Int16Array {
  const { on, off } = voicedSpan(x, rate, -45);
  const cur = rmsDb(x, on, Math.max(on + 1, off));
  const g = 10 ** ((targetDb - cur) / 20);
  return Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(v * g))));
}

/** 咳に似た音：帯域（約 300〜3000 Hz）の雑音の破裂を 2〜3 回。速い立ち上がりと指数の減衰。 */
function cough(r: () => number): Int16Array {
  const bursts = 2 + Math.floor(r() * 2);
  const parts: number[] = [];
  let lp1 = 0;
  let lp2 = 0;
  for (let b = 0; b < bursts; b++) {
    const dur = Math.round(MIC_RATE * (0.09 + r() * 0.08));
    const amp = 0.35 * (b === 0 ? 1 : 0.55 + r() * 0.3);
    for (let i = 0; i < dur; i++) {
      const env = Math.min(1, i / (MIC_RATE * 0.006)) * Math.exp(-i / (MIC_RATE * 0.045));
      const n = r() * 2 - 1;
      lp1 += 0.35 * (n - lp1); // 低域通過
      lp2 += 0.02 * (lp1 - lp2); // その低域を引いて高域通過に
      parts.push((lp1 - lp2) * amp * env * 3);
    }
    const gap = Math.round(MIC_RATE * (0.06 + r() * 0.06));
    for (let i = 0; i < gap; i++) parts.push(0);
  }
  return Int16Array.from(parts, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
}

/** 息：広い帯域の雑音を滑らかな包絡で 0.5〜0.8 秒。 */
function breath(r: () => number, targetDb: number): Int16Array {
  const dur = Math.round(MIC_RATE * (0.5 + r() * 0.3));
  const out = new Float64Array(dur);
  let lp = 0;
  let hp = 0;
  for (let i = 0; i < dur; i++) {
    const n = r() * 2 - 1;
    lp += 0.5 * (n - lp);
    hp += 0.05 * (lp - hp);
    const env = Math.sin((Math.PI * i) / dur) ** 1.5;
    out[i] = (lp - hp) * env;
  }
  let sum = 0;
  for (let i = 0; i < dur; i++) sum += (out[i] as number) ** 2;
  const g = 10 ** (targetDb / 20) / Math.sqrt(sum / dur);
  return Int16Array.from(out, (v) => Math.max(-32768, Math.min(32767, Math.round(v * g * 32767))));
}

async function loadClip(file: string): Promise<Int16Array> {
  const w = await readWavMono16(file);
  return w.rate === MIC_RATE ? w.samples : resampleInt16(w.samples, w.rate, MIC_RATE);
}

export interface BuildOptions {
  outDir: string;
  seed: number;
  /** 話し合いの刺激の始まりと終わり（秒）。 */
  startS: number;
  endS: number;
  /** 刺激の間隔（秒、一様）。 */
  spacing: [number, number];
  /** 種類の重み。 */
  mix: Partial<Record<Exclude<StimKind, 'intake'>, number>>;
  /** ファイルの長さ（秒）。偽マイクはループするので、セッションより長くする。 */
  totalS: number;
  /** 中身のある発言を sp_*（文と声が合う合成）だけにする（実の STT の通し）。 */
  speechOwnOnly?: boolean;
}

export interface BuiltStimuli {
  mic: string;
  sttScript: string;
  truth: string;
  stims: Stim[];
  ttsWav: string;
}

const STIM_DIR = path.join(here, 'stimuli');
const GEMINI_DIR = path.join(repoRoot, 'tools/provider_probe/out/reading_roundtrip');

export async function buildStimuli(o: BuildOptions): Promise<BuiltStimuli> {
  await mkdir(o.outDir, { recursive: true });
  const r = rng(o.seed);
  const mic = new Int16Array(Math.round(o.totalS * MIC_RATE));
  // 実のマイクに近づけるため、-70 dBFS の雑音の床を敷く（全くの 0 は実機にない）。
  const floor = 10 ** (-70 / 20) * 32767 * Math.sqrt(3);
  for (let i = 0; i < mic.length; i++) mic[i] = Math.round((r() * 2 - 1) * floor);

  const geminiFiles = readdirSync(GEMINI_DIR).filter((f) => /^gemini__s\d+\.wav$/.test(f)).sort();
  const speechClips = Object.keys(SPEECH_TEXT).filter((c) => existsSync(path.join(STIM_DIR, `${c}.wav`)));
  const bcClips = Object.keys(BC_TEXT).filter((c) => existsSync(path.join(STIM_DIR, `${c}.wav`)));
  if (speechClips.length === 0 || bcClips.length === 0) throw new Error('stimuli/*.wav がない（synth_voices.mjs を先に）');

  const stims: Stim[] = [];
  const place = (kind: StimKind, clip: string, text: string, pcm: Int16Array, atS: number) => {
    const at = Math.round(atS * MIC_RATE);
    for (let i = 0; i < pcm.length && at + i < mic.length; i++) mic[at + i] = Math.max(-32768, Math.min(32767, (mic[at + i] as number) + (pcm[i] as number)));
    const thr = kind === 'breath_soft' ? -60 : -40;
    const span = voicedSpan(pcm, MIC_RATE, thr);
    stims.push({ idx: stims.length, kind, clip, text, onset_s: atS + span.on / MIC_RATE, offset_s: atS + span.off / MIC_RATE, rms_dbfs: Math.round(rmsDb(pcm, span.on, Math.max(span.on + 1, span.off))) });
  };

  // intake：合成の文（gemini__s01〜s04）。台本の STT が穴を埋める文を返す。
  // 中身の合った合成（in_1〜in_4）があればそれを使う（実の STT の通しに要る）。
  for (let k = 0; k < INTAKE_VOICE_AT_S.length; k++) {
    const own = path.join(STIM_DIR, `in_${k + 1}.wav`);
    const file = existsSync(own) ? own : path.join(GEMINI_DIR, geminiFiles[k] as string);
    const pcm = normalize(await loadClip(file), MIC_RATE, -20);
    place('intake', path.basename(file), INTAKE_TEXT[k] as string, pcm, INTAKE_VOICE_AT_S[k] as number);
  }

  const kinds = Object.entries(o.mix) as [Exclude<StimKind, 'intake'>, number][];
  const totalW = kinds.reduce((s, [, w]) => s + w, 0);
  const pick = (): Exclude<StimKind, 'intake'> => {
    let x = r() * totalW;
    for (const [k, w] of kinds) {
      if ((x -= w) < 0) return k;
    }
    return kinds[0]![0];
  };
  const extraSpeech = o.speechOwnOnly ? [] : geminiFiles.slice(INTAKE_VOICE_AT_S.length);
  let t = o.startS;
  let si = 0;
  while (t < o.endS) {
    const kind = pick();
    if (kind === 'speech') {
      // 中身のある発言：sp_* と、残りの gemini__s*（文は sp_* の文を使い回す。STT は台本）。
      const pool = [...speechClips.map((c) => path.join(STIM_DIR, `${c}.wav`)), ...extraSpeech.map((f) => path.join(GEMINI_DIR, f))];
      const file = pool[si % pool.length] as string;
      const base = path.basename(file, '.wav');
      const text = SPEECH_TEXT[base] ?? (SPEECH_TEXT[speechClips[si % speechClips.length] as string] as string);
      si += 1;
      place(kind, path.basename(file), text, normalize(await loadClip(file), MIC_RATE, -20 + (r() * 6 - 3)), t);
    } else if (kind === 'backchannel') {
      const c = bcClips[Math.floor(r() * bcClips.length)] as string;
      place(kind, `${c}.wav`, BC_TEXT[c] as string, normalize(await loadClip(path.join(STIM_DIR, `${c}.wav`)), MIC_RATE, -22 + (r() * 6 - 3)), t);
    } else if (kind === 'cough') {
      place(kind, 'synthetic_cough', '', normalize(cough(r), MIC_RATE, -18 + (r() * 6 - 3)), t);
    } else if (kind === 'breath_soft') {
      place(kind, 'synthetic_breath', '', breath(r, -50), t);
    } else {
      place(kind, 'synthetic_breath', '', breath(r, -34), t);
    }
    t += o.spacing[0] + r() * (o.spacing[1] - o.spacing[0]);
  }

  // 台本の STT の区切りを 16 kHz・20 ms で真似て、区間ごとに文を割り当てる。
  const mic16 = resampleInt16(mic, MIC_RATE, 16000);
  const F = 320;
  const segments: { start: number; end: number }[] = [];
  let active = false;
  let segStart = 0;
  let lastVoiced = 0;
  for (let i = 0; i + F <= mic16.length; i += F) {
    if (rmsDb(mic16, i, i + F) >= -40) {
      if (!active) {
        active = true;
        segStart = i;
      }
      lastVoiced = i + F;
    } else if (active && i + F - lastVoiced >= 0.6 * 16000) {
      active = false;
      segments.push({ start: segStart / 16000, end: lastVoiced / 16000 });
    }
  }
  const script: string[] = [];
  const segOwner: number[] = [];
  for (const seg of segments) {
    const owner = stims.find((s) => seg.start < s.offset_s + 0.05 && seg.end > s.onset_s - 0.05);
    // 同じ刺激の 2 つ目以降の区間は ''（文は最初の区間だけ）。
    const first = owner !== undefined && !segOwner.includes(owner.idx);
    script.push(owner !== undefined && first ? owner.text : '');
    segOwner.push(owner?.idx ?? -1);
  }

  // 台本の TTS（test_double）の声も合成音声にする（既定の models/ja.wav は使わない）：gemini 以外の合成（ElevenLabs）を並べる。
  const elFiles = readdirSync(GEMINI_DIR).filter((f) => /^el_ja__s\d+\.wav$/.test(f)).sort().slice(0, 8);
  const parts: Int16Array[] = [];
  for (const f of elFiles) {
    const w = await readWavMono16(path.join(GEMINI_DIR, f));
    parts.push(w.rate === 24000 ? w.samples : resampleInt16(w.samples, w.rate, 24000));
    parts.push(new Int16Array(24000 * 0.3));
  }
  const tts = new Int16Array(parts.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    tts.set(p, pos);
    pos += p.length;
  }
  const ttsWav = path.join(o.outDir, 'scripted_tts_voice_24k.wav');
  await writeWavMono16(ttsWav, 24000, tts);

  const micPath = path.join(o.outDir, 'fake_mic_48k.wav');
  await writeWavMono16(micPath, MIC_RATE, mic);
  const sttScript = path.join(o.outDir, 'stt_script.json');
  await writeFile(sttScript, JSON.stringify(script));
  const truth = path.join(o.outDir, 'truth.json');
  await writeFile(truth, JSON.stringify({ seed: o.seed, mic_rate: MIC_RATE, stims, stt_segments: segments.map((s, i) => ({ ...s, owner: segOwner[i], text: script[i] })) }, null, 2));
  return { mic: micPath, sttScript, truth, stims, ttsWav };
}
