/**
 * 描画の設定（照明、テクスチャの補間、MToon の加算マットキャップ、ピクセル比）。three に依存しない。
 * 値は SwiftShader のスクリーンショットで決めた。実 GPU と表示機器での確認は人が行う（未確認）。
 *
 * 見え方の切り分け（Sendagaya_Shino、VRM 0.x、VRoid 製）:
 *  - 服と肌の縁の明るい線: MToon の加算マットキャップ（_SphereAdd = Matcap_Rim、縁が金色）。照明と無関係に足される。
 *    モデルの設定どおりの描画だが、濃い服の縁で金色の帯になるので倍率を下げる。
 *  - テクスチャのちらつきと髪の縁のギザギザ: glTF のサンプラーが minFilter=LINEAR（ミップマップなし）。
 *    縮小表示で間引かれるので、不透明な髪・肌・服にミップマップと異方性フィルタを付ける（mipmapAllowed）。
 *  - 唇の下の白い点、瞳のオレンジ: 顔と虹彩のテクスチャに描かれている（モデルの意図、サムネイルでも同じ）。直さない。
 *  - 前髪の先が四角い: 姫カットの形状そのもの（髪のテクスチャのアルファは全面 255）。直さない。
 */

export interface MatcapScale {
  /** 材質名が _SKIN で終わるもの（VRoid の命名）。 */
  skin: number;
  cloth: number;
  hair: number;
  /** 上のどれでもない（目、口など）。 */
  other: number;
}

export interface RenderSettings {
  matcapScale: MatcapScale;
  /** ミップマップを付ける（glTF のサンプラーが LINEAR でも）。 */
  mipmaps: boolean;
  /** 異方性フィルタの上限。実際は GPU の上限で切る。 */
  anisotropy: number;
  /** 描画のピクセル比 = clamp(devicePixelRatio, min, max)。1 の画面でも少し高く描いて縮小し、細い線を滑らかにする。 */
  minPixelRatio: number;
  maxPixelRatio: number;
  /** 主光（平行光）の強さと向き（モデルの前方 +Z、上 +Y、右手側 -X が画面の左）。 */
  keyIntensity: number;
  keyPosition: [number, number, number];
  /** 環境光。MToon は GI を均すので、影の濃さにはあまり効かない。 */
  ambientIntensity: number;
  /** 髪と服の揺れ（spring bone）。 */
  springBones: boolean;
  background: number;
}

export const DEFAULT_RENDER: RenderSettings = {
  matcapScale: { skin: 0.3, cloth: 0.25, hair: 0.4, other: 1 },
  mipmaps: true,
  anisotropy: 4,
  minPixelRatio: 1.5,
  maxPixelRatio: 2,
  keyIntensity: 2.2,
  keyPosition: [0.4, 1.4, 2.0],
  ambientIntensity: 0.9,
  springBones: true,
  background: 0xe8ebef,
};

/** H1 の時点の設定（比較用）。 */
export const H1_RENDER: RenderSettings = {
  matcapScale: { skin: 1, cloth: 1, hair: 1, other: 1 },
  mipmaps: false,
  anisotropy: 1,
  minPixelRatio: 1,
  maxPixelRatio: 2,
  keyIntensity: 2.2,
  keyPosition: [0.6, 1.6, 1.8],
  ambientIntensity: 0.9,
  springBones: true,
  background: 0xe8ebef,
};

export function resolveRenderSettings(overrides: Partial<RenderSettings> | 'h1' | undefined): RenderSettings {
  if (overrides === 'h1') return H1_RENDER;
  return {
    ...DEFAULT_RENDER,
    ...overrides,
    matcapScale: { ...DEFAULT_RENDER.matcapScale, ...overrides?.matcapScale },
  };
}

export type MaterialKind = keyof MatcapScale;

/** VRoid の材質名（F00_000_00_Face_00_SKIN など）から種類を判定する。名前の規約が違うモデルは other。 */
export function materialKind(name: string): MaterialKind {
  const upper = name.toUpperCase();
  if (/_SKIN(\b|_|$)/.test(upper) || /_SKIN \(/.test(upper)) return 'skin';
  if (/_CLOTH(\b|_|$)/.test(upper)) return 'cloth';
  if (/_HAIR(\b|_|$)/.test(upper)) return 'hair';
  return 'other';
}

/**
 * ミップマップを付けてよい材質か。透明（BLEND）と目・顔の部品（まつげ、眉、虹彩）には付けない:
 * アルファ 0 の画素の色（黒）が縮小で混ざり、虹彩の縁が黒い輪になる（SwiftShader で確認）。
 */
export function mipmapAllowed(name: string, transparent: boolean): boolean {
  if (transparent) return false;
  const kind = materialKind(name);
  return kind === 'hair' || kind === 'skin' || kind === 'cloth';
}

export function matcapScaleFor(name: string, settings: RenderSettings): number {
  return settings.matcapScale[materialKind(name)];
}

export function pixelRatioFor(devicePixelRatio: number, settings: RenderSettings): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(settings.maxPixelRatio, Math.max(settings.minPixelRatio, dpr));
}
