/**
 * 有理比の polyphase FIR リサンプラ（計画 §3.2）。依存なし。Worklet と Worker の両方で使う。
 *
 * - フィルタは Kaiser 窓つき sinc の線形位相。阻止域の端を変換後のナイキスト周波数に置くので、
 *   ナイキスト以上の成分は折り返す前に減衰する。
 * - **群遅延を出力の時間軸で打ち消す。** 全タップ数を N=2rM+1 にして遅延を出力 r サンプルちょうどにし、
 *   最初の r 個の出力を捨てる。残った出力 n は入力時刻 n*M/L に一致する。
 *   これで audio_frame i は「コンテキストのフレーム i*入力レート/16000」を指す。
 * - 同じ設計（ResamplerDesign）を共有する2つのインスタンスへ同じ数の入力を与えれば、
 *   出力の個数と位相は常に一致する。mic と sys の群遅延が揃うのはこのため。
 */

export interface ResamplerDesign {
  readonly inRate: number;
  readonly outRate: number;
  /** 補間率 */
  readonly L: number;
  /** 間引き率 */
  readonly M: number;
  /** 位相あたりのタップ数 */
  readonly K: number;
  /** 全タップ数。入力レート×L で動くフィルタとしての長さ。 */
  readonly N: number;
  /** phase * K + j の順に並べた係数。 */
  readonly table: Float64Array;
  /** 打ち消す遅延（出力サンプル数）。 */
  readonly skipOutputs: number;
  /** 打ち消す遅延（ミリ秒）。先読みとして実際の遅れになる。 */
  readonly delayMs: number;
  readonly stopbandDb: number;
  readonly passbandEdgeHz: number;
  readonly stopbandEdgeHz: number;
}

export interface ResamplerDesignOptions {
  /** 阻止域の減衰量（dB）。 */
  stopbandDb?: number;
  /** 遷移帯域の幅（Hz）。既定は変換後または変換前の小さい方のナイキストの 1/8。 */
  transitionHz?: number;
}

export const DEFAULT_STOPBAND_DB = 80;

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** 第1種変形ベッセル関数 I0。Kaiser 窓用。 */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

function kaiserBeta(stopbandDb: number): number {
  if (stopbandDb > 50) return 0.1102 * (stopbandDb - 8.7);
  if (stopbandDb >= 21) return 0.5842 * (stopbandDb - 21) ** 0.4 + 0.07886 * (stopbandDb - 21);
  return 0;
}

export function designResampler(
  inRate: number,
  outRate: number,
  options: ResamplerDesignOptions = {},
): ResamplerDesign {
  if (!Number.isInteger(inRate) || !Number.isInteger(outRate) || inRate <= 0 || outRate <= 0) {
    throw new Error(`rates must be positive integers: ${inRate} -> ${outRate}`);
  }
  const stopbandDb = options.stopbandDb ?? DEFAULT_STOPBAND_DB;
  const nyquist = Math.min(inRate, outRate) / 2;
  if (inRate === outRate) {
    return {
      inRate,
      outRate,
      L: 1,
      M: 1,
      K: 1,
      N: 1,
      table: Float64Array.of(1),
      skipOutputs: 0,
      delayMs: 0,
      stopbandDb,
      passbandEdgeHz: nyquist,
      stopbandEdgeHz: nyquist,
    };
  }
  const g = gcd(inRate, outRate);
  const L = outRate / g;
  const M = inRate / g;
  const base = inRate * L;
  const transition = options.transitionHz ?? nyquist / 8;
  const stopEdge = nyquist;
  const passEdge = nyquist - transition;
  const cutoff = (passEdge + stopEdge) / 2;

  const dw = (2 * Math.PI * transition) / base;
  const minTaps = Math.ceil((stopbandDb - 7.95) / (2.285 * dw)) + 1;
  // N=2rM+1 にすると遅延が出力サンプルの整数倍になる。
  const r = Math.ceil((minTaps - 1) / (2 * M));
  const N = 2 * r * M + 1;
  const D = r * M;

  const beta = kaiserBeta(stopbandDb);
  const i0beta = besselI0(beta);
  const fc = (2 * cutoff) / base;
  const h = new Float64Array(N);
  let sum = 0;
  for (let n = 0; n < N; n++) {
    const x = n - D;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * fc * x) / (Math.PI * fc * x);
    const ratio = x / D;
    const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / i0beta;
    const value = fc * sinc * window;
    h[n] = value;
    sum += value;
  }
  // 補間で振幅が 1/L になる分を含めて DC 利得を 1 にする。
  const scale = L / sum;
  const K = Math.ceil(N / L);
  const table = new Float64Array(L * K);
  for (let phase = 0; phase < L; phase++) {
    for (let j = 0; j < K; j++) {
      const index = phase + j * L;
      table[phase * K + j] = index < N ? (h[index] as number) * scale : 0;
    }
  }
  return {
    inRate,
    outRate,
    L,
    M,
    K,
    N,
    table,
    skipOutputs: r,
    delayMs: (r * 1000) / outRate,
    stopbandDb,
    passbandEdgeHz: passEdge,
    stopbandEdgeHz: stopEdge,
  };
}

export class PolyphaseResampler {
  private readonly history: Float64Array;
  private pos = 0;
  /** 次の出力の基準レート上の時刻を、現在の入力サンプルからの差で持つ。 */
  private rel = 0;
  private toSkip: number;
  private inputCount = 0;
  private emitted = 0;

  constructor(readonly design: ResamplerDesign) {
    this.history = new Float64Array(design.K * 2);
    this.toSkip = design.skipOutputs;
  }

  /** input の長さ n に対する出力の上限。 */
  maxOutput(n: number): number {
    return Math.ceil((n * this.design.L) / this.design.M) + 1;
  }

  /** 入力を消費し、output の outOffset から書く。書いた個数を返す。実行中に確保しない。 */
  process(
    input: Float32Array,
    inputOffset: number,
    inputLength: number,
    output: Float32Array,
    outputOffset: number,
  ): number {
    const { K, L, M, table } = this.design;
    const history = this.history;
    let written = 0;
    let pos = this.pos;
    let rel = this.rel;
    for (let i = 0; i < inputLength; i++) {
      pos = pos === 0 ? K - 1 : pos - 1;
      const x = input[inputOffset + i] as number;
      history[pos] = x;
      history[pos + K] = x;
      while (rel < L) {
        if (this.toSkip > 0) {
          this.toSkip--;
        } else {
          const start = rel * K;
          let acc = 0;
          for (let j = 0; j < K; j++) {
            acc += (table[start + j] as number) * (history[pos + j] as number);
          }
          output[outputOffset + written] = acc;
          written++;
        }
        rel += M;
      }
      rel -= L;
    }
    this.pos = pos;
    this.rel = rel;
    this.inputCount += inputLength;
    this.emitted += written;
    return written;
  }

  /**
   * ストリームの終端。先読みで残った分をゼロ入力で押し出す。
   * 全出力の個数は ceil(入力数*L/M) になる。
   */
  flush(): Float32Array {
    const { L, M, K, skipOutputs } = this.design;
    const expected = Math.ceil((this.inputCount * L) / M);
    const missing = expected - this.emitted;
    if (missing <= 0) return new Float32Array(0);
    const zerosNeeded = Math.ceil(((skipOutputs + 1) * M) / L) + K;
    const zeros = new Float32Array(zerosNeeded);
    const out = new Float32Array(this.maxOutput(zerosNeeded));
    const count = this.process(zeros, 0, zerosNeeded, out, 0);
    return out.subarray(0, Math.min(count, missing));
  }
}
