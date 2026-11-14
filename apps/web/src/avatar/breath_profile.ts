/**
 * 吸気の合図の動きの大きさの切り替え（`?breath_profile=`）。動きの種類は変えず、準備吸気の振幅だけを変える。
 * 比較用で、既定の動きは変えない。どの大きさが適切かは未評価。使った値は manifest の avatar.breath_profile に残す。
 *
 * - default:  現在の既定（2026-11-08 に大きくした値）。
 * - original: 大きくする前の値（f157f74 の前）。胸のモーフの変位は既定のままなので、深さで元の変位の大きさに合わせている。
 * - weak:     original のおよそ半分（手で置いた暫定値）。
 */
import type { PrepBreathParams } from './breath';

export const BREATH_PROFILE_IDS = ['default', 'original', 'weak'] as const;
export type BreathProfileId = (typeof BREATH_PROFILE_IDS)[number];

export const BREATH_PROFILES: Record<BreathProfileId, Partial<PrepBreathParams>> = {
  default: {},
  original: {
    depth: 0.76,
    chestPitchDeg: -1.6,
    shoulderDeg: 3.2,
    headPitchDeg: -1.4,
    mouthOpen: 0.12,
    brow: 0.18,
    shortChest: 0.4,
    shortHead: 0.6,
    shortShoulder: 0.2,
    shortBrow: 0.3,
  },
  weak: {
    depth: 0.38,
    chestPitchDeg: -0.8,
    shoulderDeg: 1.6,
    headPitchDeg: -0.7,
    mouthOpen: 0.06,
    brow: 0.09,
    shortChest: 0.4,
    shortHead: 0.6,
    shortShoulder: 0.2,
    shortBrow: 0.3,
  },
};

/** `?breath_profile=` の値。未指定と不正な値は既定。 */
export function parseBreathProfile(raw: string | null | undefined): BreathProfileId {
  return BREATH_PROFILE_IDS.find((id) => id === raw) ?? 'default';
}
