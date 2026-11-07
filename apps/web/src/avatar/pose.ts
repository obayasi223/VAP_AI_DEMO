/**
 * 合成の層。瞬き、口、視線、待機（後から吸気や準備姿勢）はすべて AvatarLayer で、1つの更新ループが順に呼ぶ。
 * 層は PoseFrame へ加算で書くだけで、VRM には触らない。VRM へ当てるのは runtime.ts の1か所。
 * three に依存しないので、合成の規則は vitest で試験できる。
 */
import { clamp01 } from './util';

export interface LayerContext {
  dtMs: number;
  /** ループの時刻（rAF の値）。 */
  nowMs: number;
}

export interface BoneOffset {
  /**
   * オイラー角（ラジアン）。VRM 1.0 の規約で書く: モデルは +Z を向き、x の正が下を向く、y の正がモデルの左。
   * VRM 0.x のモデルでは runtime.ts が boneSignForMeta で変換する。
   */
  x: number;
  y: number;
  z: number;
}

export interface EyeOffset {
  /** vrm.lookAt へ渡す入力の角度（度）。実際の眼球の回転はモデルの range map で縮む。 */
  yawDeg: number;
  pitchDeg: number;
  /** 1 ならカメラを見る補正を全部使う、0 なら使わない。 */
  userWeight: number;
}

export class PoseFrame {
  readonly expressions = new Map<string, number>();
  readonly bones = new Map<string, BoneOffset>();
  readonly eye: EyeOffset = { yawDeg: 0, pitchDeg: 0, userWeight: 1 };

  /** 値だけ 0 に戻す。一度書かれた名前は残るので、層が止まると次のフレームで 0 が VRM へ当たる。 */
  begin(): void {
    for (const name of this.expressions.keys()) this.expressions.set(name, 0);
    for (const bone of this.bones.values()) {
      bone.x = 0;
      bone.y = 0;
      bone.z = 0;
    }
    this.eye.yawDeg = 0;
    this.eye.pitchDeg = 0;
    this.eye.userWeight = 1;
  }

  /** 加算して 0〜1 に収める。 */
  addExpression(name: string, weight: number): void {
    this.expressions.set(name, clamp01((this.expressions.get(name) ?? 0) + weight));
  }

  addBone(name: string, x: number, y: number, z: number): void {
    const bone = this.bones.get(name);
    if (bone) {
      bone.x += x;
      bone.y += y;
      bone.z += z;
    } else {
      this.bones.set(name, { x, y, z });
    }
  }

  expression(name: string): number {
    return this.expressions.get(name) ?? 0;
  }
}

export interface AvatarLayer {
  readonly name: string;
  update(context: LayerContext, frame: PoseFrame): void;
}

/** 順序つきの層の並び。H2 は addLayer(layer, { before: 'blink' }) で吸気などを足す。 */
export class LayerStack {
  private readonly layers: AvatarLayer[] = [];
  readonly frame = new PoseFrame();

  add(layer: AvatarLayer, position: { before: string } | null = null): void {
    if (this.layers.some((l) => l.name === layer.name)) {
      throw new Error(`avatar layer already exists: ${layer.name}`);
    }
    if (!position) {
      this.layers.push(layer);
      return;
    }
    const index = this.layers.findIndex((l) => l.name === position.before);
    if (index < 0) throw new Error(`avatar layer not found: ${position.before}`);
    this.layers.splice(index, 0, layer);
  }

  remove(name: string): void {
    const index = this.layers.findIndex((l) => l.name === name);
    if (index >= 0) this.layers.splice(index, 1);
  }

  names(): string[] {
    return this.layers.map((l) => l.name);
  }

  step(context: LayerContext): PoseFrame {
    this.frame.begin();
    for (const layer of this.layers) layer.update(context, this.frame);
    return this.frame;
  }
}

/**
 * 正規化ボーンの符号。three-vrm の VRM 0.x は rotateVRM0 で向きを変えても正規化ボーンの軸が 180 度回ったままなので、
 * x と z の符号が VRM 1.0 と逆になる。層はモデルの版を知らなくてよいように、適用の1か所で揃える。
 */
export function boneSignForMeta(metaVersion: string): { x: number; y: number; z: number } {
  return metaVersion === '0' ? { x: -1, y: 1, z: -1 } : { x: 1, y: 1, z: 1 };
}
