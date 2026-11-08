/**
 * アバターの差し替えの設定（three に依存しない）。既定は VRM のまま。別のモデルは URL（?avatar=rocketbox）か
 * 環境変数（NEXT_PUBLIC_AVATAR）で指定したときだけ使う。参加者画面に選択肢は出さない。
 * 手順と比較の結果は docs/avatar_swap_eval.md。モデルのファイルは apps/web/public/models/（git に入れない）。
 */

export type AvatarId = 'vrm' | 'rocketbox' | RocketboxCandidateId | MpfbCandidateId | 'none';
export const DEFAULT_AVATAR_ID: AvatarId = 'vrm';
/** 顔の候補（Rocketbox の Assets/Avatars/*。選定の根拠は docs/avatar_swap_eval.md）。人が見て選ぶ。 */
export type RocketboxCandidateId = 'rb_fa03' | 'rb_chef01' | 'rb_bf03' | 'rb_ma09' | 'rb_ma10' | 'rb_bm02';
export const ROCKETBOX_CANDIDATES: readonly RocketboxCandidateId[] = ['rb_fa03', 'rb_chef01', 'rb_bf03', 'rb_ma09', 'rb_ma10', 'rb_bm02'];
/** MakeHuman（MPFB の配布データ）から作った候補。手順は docs/avatar_swap_eval.md。 */
export type MpfbCandidateId = 'mpfb_ja' | 'mpfb_ja_m';

export const DEFAULT_VRM_URL = '/models/Sendagaya_Shino.vrm';

/** モーフ（ブレンドシェイプ）への対応。形状が無いモデルはその分を省く。 */
export interface MorphBind {
  morph: string;
  weight: number;
}

/** 視線の入力（度）→ 眼の回転（度）。VRM の range map と同じ意味。 */
export interface EyeRange {
  inputMaxDeg: number;
  outerDeg: number;
  innerDeg: number;
  upDeg: number;
  downDeg: number;
}

/** VRM 以外の glTF の対応表。骨は VRM のヒューマノイドの役割名 → ノード名（glTF の名前のまま）。 */
export interface GlbModelSpec {
  kind: 'glb';
  bones: Record<string, string>;
  expressions: Record<string, MorphBind[]>;
  eyeRange: EyeRange;
  /** バインドが T ポーズでない上腕。RestPoseLayer は T ポーズ前提なので、差を読み込み時に求めて打ち消す。 */
  tPoseArms?: boolean;
  /**
   * 親の回転を打ち消す骨（役割 → 親の役割）。Rocketbox は鎖骨が首の子なので、そのままだと視線で肩が動く。
   */
  counterParent?: Record<string, string>;
  /** 髪やまつげなど透過の材質（名前の一部）。アルファカットにして前後のちらつきを避ける。 */
  cutoutMaterials?: string[];
}

export interface VrmModelSpec {
  kind: 'vrm';
}

export type AvatarModelSpec = VrmModelSpec | GlbModelSpec;

/** ARKit／視素の名前からの対応（Rocketbox の FBX の名前。glTF でもそのまま）。 */
const ROCKETBOX_SPEC: GlbModelSpec = {
  kind: 'glb',
  tPoseArms: true,
  bones: {
    hips: 'Bip01 Pelvis',
    spine: 'Bip01 Spine',
    chest: 'Bip01 Spine1',
    upperChest: 'Bip01 Spine2',
    neck: 'Bip01 Neck',
    head: 'Bip01 Head',
    leftShoulder: 'Bip01 L Clavicle',
    rightShoulder: 'Bip01 R Clavicle',
    leftUpperArm: 'Bip01 L UpperArm',
    rightUpperArm: 'Bip01 R UpperArm',
    leftLowerArm: 'Bip01 L Forearm',
    rightLowerArm: 'Bip01 R Forearm',
    leftHand: 'Bip01 L Hand',
    rightHand: 'Bip01 R Hand',
    leftEye: 'Bip01 LEye',
    rightEye: 'Bip01 REye',
    jaw: 'Bip01 MJaw',
  },
  // 鎖骨が首の子。視線と吸気の首の回転が肩へ伝わらないように打ち消す（hips より下の脚は見えないので扱わない）。
  counterParent: { leftShoulder: 'neck', rightShoulder: 'neck' },
  // 視素の重みは目視で決めた暫定（aa を 1 にすると VRM より大きく開く。比較の連続画像 2026-11-08）。
  expressions: {
    aa: [{ morph: 'AA_VI_10_aa', weight: 0.62 }],
    ih: [{ morph: 'AA_VI_12_I', weight: 0.6 }],
    ou: [{ morph: 'AA_VI_14_U', weight: 0.6 }],
    ee: [{ morph: 'AA_VI_11_E', weight: 0.6 }],
    oh: [{ morph: 'AA_VI_13_O', weight: 0.6 }],
    blink: [
      { morph: 'AK_09_EyeBlinkLeft', weight: 1 },
      { morph: 'AK_10_EyeBlinkRight', weight: 1 },
    ],
    browUp: [
      { morph: 'AK_03_BrowInnerUp', weight: 0.7 },
      { morph: 'AK_04_BrowOuterUpLeft', weight: 0.35 },
      { morph: 'AK_05_BrowOuterUpRight', weight: 0.35 },
    ],
    relaxed: [
      { morph: 'AK_44_MouthSmileLeft', weight: 0.25 },
      { morph: 'AK_45_MouthSmileRight', weight: 0.25 },
    ],
  },
  eyeRange: { inputMaxDeg: 90, outerDeg: 12, innerDeg: 8, upDeg: 10, downDeg: 10 },
  cutoutMaterials: ['opacity'],
};

/** MakeHuman の既定リグの骨と表情の単位ターゲット（シェイプキーの名前は MH_ + ターゲット名）。鎖骨は背骨の子なので counterParent は不要。 */
const MPFB_SPEC: GlbModelSpec = {
  kind: 'glb',
  tPoseArms: true,
  bones: {
    hips: 'spine05',
    spine: 'spine03',
    chest: 'spine02',
    upperChest: 'spine01',
    neck: 'neck01',
    head: 'head',
    leftShoulder: 'clavicle.L',
    rightShoulder: 'clavicle.R',
    leftUpperArm: 'upperarm01.L',
    rightUpperArm: 'upperarm01.R',
    leftLowerArm: 'lowerarm01.L',
    rightLowerArm: 'lowerarm01.R',
    leftHand: 'wrist.L',
    rightHand: 'wrist.R',
    leftEye: 'eye.L',
    rightEye: 'eye.R',
    jaw: 'jaw',
  },
  expressions: {
    aa: [{ morph: 'MH_mouth_open', weight: 0.7 }],
    ih: [
      { morph: 'MH_mouth_open', weight: 0.2 },
      { morph: 'MH_mouth_retraction', weight: 0.5 },
    ],
    ou: [
      { morph: 'MH_mouth_open', weight: 0.15 },
      { morph: 'MH_mouth_pursing', weight: 0.6 },
    ],
    ee: [
      { morph: 'MH_mouth_open', weight: 0.35 },
      { morph: 'MH_mouth_retraction', weight: 0.4 },
    ],
    oh: [
      { morph: 'MH_mouth_open', weight: 0.5 },
      { morph: 'MH_mouth_pursing', weight: 0.35 },
    ],
    blink: [
      { morph: 'MH_eye_left_closure', weight: 1 },
      { morph: 'MH_eye_right_closure', weight: 1 },
    ],
    browUp: [
      { morph: 'MH_eyebrows_left_inner_up', weight: 0.5 },
      { morph: 'MH_eyebrows_right_inner_up', weight: 0.5 },
      { morph: 'MH_eyebrows_left_up', weight: 0.3 },
      { morph: 'MH_eyebrows_right_up', weight: 0.3 },
    ],
    relaxed: [{ morph: 'MH_mouth_corner_puller', weight: 0.25 }],
  },
  eyeRange: { inputMaxDeg: 90, outerDeg: 12, innerDeg: 8, upDeg: 10, downDeg: 10 },
  cutoutMaterials: ['hair', 'eyebrow', 'eyelash', 'eyes'],
};

export interface AvatarDefinition {
  id: AvatarId;
  url: string | null;
  spec: AvatarModelSpec | null;
}

export const AVATAR_MODELS: Readonly<Record<AvatarId, AvatarDefinition>> = {
  vrm: { id: 'vrm', url: DEFAULT_VRM_URL, spec: { kind: 'vrm' } },
  rocketbox: { id: 'rocketbox', url: '/models/rocketbox_f001.glb', spec: ROCKETBOX_SPEC },
  rb_fa03: { id: 'rb_fa03', url: '/models/rb_fa03.glb', spec: ROCKETBOX_SPEC },
  rb_chef01: { id: 'rb_chef01', url: '/models/rb_chef01.glb', spec: ROCKETBOX_SPEC },
  rb_bf03: { id: 'rb_bf03', url: '/models/rb_bf03.glb', spec: ROCKETBOX_SPEC },
  rb_ma09: { id: 'rb_ma09', url: '/models/rb_ma09.glb', spec: ROCKETBOX_SPEC },
  rb_ma10: { id: 'rb_ma10', url: '/models/rb_ma10.glb', spec: ROCKETBOX_SPEC },
  rb_bm02: { id: 'rb_bm02', url: '/models/rb_bm02.glb', spec: ROCKETBOX_SPEC },
  // MakeHuman のデータだけから作った候補（アドオンのコードは実行しない）。
  mpfb_ja: { id: 'mpfb_ja', url: '/models/mpfb_ja.glb', spec: MPFB_SPEC },
  mpfb_ja_m: { id: 'mpfb_ja_m', url: '/models/mpfb_ja_m.glb', spec: MPFB_SPEC },
  none: { id: 'none', url: null, spec: null },
};

export function isAvatarId(value: string): value is AvatarId {
  return Object.prototype.hasOwnProperty.call(AVATAR_MODELS, value);
}

export interface AvatarChoice extends AvatarDefinition {
  /** 実際に選ばれた理由（manifest の source）。 */
  source: 'default' | 'query' | 'env' | 'model_query';
  /** 認識できなかった指定（既定へ戻した）。無ければ null。 */
  rejected: string | null;
}

/**
 * ?model=（従来の VRM の URL 指定）> ?avatar= > NEXT_PUBLIC_AVATAR > 既定。
 * 知らない id は既定の VRM に戻し、rejected に残す（実験の刺激が黙って変わらないように）。
 */
export function resolveAvatarChoice(input: { avatarQuery?: string | null; modelQuery?: string | null; env?: string | undefined }): AvatarChoice {
  const { avatarQuery, modelQuery, env } = input;
  if (modelQuery) return { id: 'vrm', url: modelQuery, spec: { kind: 'vrm' }, source: 'model_query', rejected: null };
  let rejected: string | null = null;
  for (const [value, source] of [
    [avatarQuery, 'query'],
    [env, 'env'],
  ] as const) {
    if (value === undefined || value === null || value === '') continue;
    if (isAvatarId(value)) return { ...AVATAR_MODELS[value], source, rejected: null };
    rejected = value;
    break;
  }
  return { ...AVATAR_MODELS[DEFAULT_AVATAR_ID], source: 'default', rejected };
}

/** 比較ページの並び（dev 専用）。 */
export const COMPARE_AVATAR_IDS: AvatarId[] = ['vrm', 'rocketbox', 'rb_fa03', 'mpfb_ja'];
/** 比較ページで選べる全部（?avatars= の既定は COMPARE_AVATAR_IDS）。 */
export const SELECTABLE_AVATAR_IDS: AvatarId[] = ['vrm', 'rocketbox', ...ROCKETBOX_CANDIDATES, 'mpfb_ja', 'mpfb_ja_m'];

export interface AvatarRecord {
  avatar_id: string;
  kind: 'vrm' | 'glb' | 'none';
  model_url: string | null;
  source: AvatarChoice['source'];
  status: 'loaded' | 'failed' | 'disabled';
  error: string | null;
}

/** manifest の記録の元（browser_rpc の avatar.report）。 */
export function avatarRecord(choice: AvatarChoice, status: AvatarRecord['status'], error: string | null = null): AvatarRecord {
  return { avatar_id: choice.id, kind: choice.spec?.kind ?? 'none', model_url: choice.url, source: choice.source, status, error };
}
