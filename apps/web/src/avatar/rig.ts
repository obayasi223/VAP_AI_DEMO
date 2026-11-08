/**
 * モデルの差を吸収する薄い層。runtime.ts の層の合成（瞬き、口、視線、吸気）は PoseFrame（役割名で書く）までで、
 * そこから先（骨・モーフ・眼へ当てる）だけをモデルごとに実装する。VRM は runtime.ts、それ以外は rig_glb.ts。
 */
import type * as THREE from 'three';
import type { BreathOutputNames } from './breath';
import type { AvatarModelInfo, BreathMorphInfo } from './runtime';
import type { PoseFrame } from './pose';

export interface EyeAngles {
  yawDeg: number;
  pitchDeg: number;
}

export interface AvatarRig {
  readonly kind: 'vrm' | 'glb';
  /** 描画するシーンのルート。 */
  readonly root: THREE.Object3D;
  readonly breathMorph: BreathMorphInfo;
  /** 吸気の層が書く名前の上書き（上胸の骨など）。 */
  readonly breathOutput: Partial<BreathOutputNames>;
  /** PoseFrame を骨・モーフ・眼へ当てる。 */
  applyFrame(frame: PoseFrame, camera: THREE.Camera, dtMs: number): void;
  /** 最初の姿勢の後の初期化（行列の更新、髪の揺れの初期化）。 */
  settle(): void;
  /** テクスチャの補間の設定（レンダラーの上限が要る）。 */
  prepareTextures(maxAnisotropy: number): void;
  eyeWorldPosition(target: THREE.Vector3): void;
  /** シーングラフ上の実際の骨（頭の向きの確認など）。役割名は VRM のヒューマノイド名。 */
  rawBone(role: string): THREE.Object3D | null;
  /** 眼の回転の読み出し（pitch の正が下、頭と同じ規約）。 */
  readEye(side: 'left' | 'right'): EyeAngles;
  /** 視線の入力（lookAt の度）。 */
  eyeInput(): EyeAngles;
  /** 今当たっている表情の重み。 */
  expressionValue(name: string): number;
  describe(): Omit<AvatarModelInfo, 'breathMorph'>;
  dispose(): void;
}
