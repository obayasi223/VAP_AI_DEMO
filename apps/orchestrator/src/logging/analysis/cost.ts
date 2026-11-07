/**
 * cost.usage の集計（純粋関数。ブラウザからも読む）。
 *
 * 表示できるのは「定価から計算した推定」だけで、請求額ではない。無料枠、プラン同梱分、丸め、
 * 取消分の課金は反映していない（provider_matrix §2.5、§3、§8）。
 *
 * cost.usage にはモデル名がなく、単価を選び直せない（Gemini はモデルで単価が違う）。そこで発行側の
 * 推定値から単価を逆算し、provider_matrix に根拠のある単価のどれかと一致するときだけ合計に入れる。
 * 一致しない値と null は「不明」として数え、0 として足さない。
 */
import type { ResearchEvent } from '@llm-vap/contracts';

export interface EvidencedRate {
  provider: string;
  unit: string;
  usd_per_unit: number;
  /** この日以降に有効（ISO 8601）。なければ期間の制限なし。 */
  valid_from: string | null;
  valid_until: string | null;
  /** docs/provider_matrix.md の節と原文の表記。 */
  source: string;
  /** 価格は確認済みでも、適用の前提が未確認のもの。 */
  caveat: string | null;
}

const PER_MTOK = 1 / 1_000_000;
const GEMINI_3_8_RATE_CHANGE = '2027-01-01T00:00:00.000Z';

/** docs/provider_matrix.md に根拠がある単価のすべて。試験で文書の表記と照合する。 */
export const EVIDENCED_RATES: readonly EvidencedRate[] = [
  {
    provider: 'google_stt_v2',
    unit: 'audio_seconds',
    usd_per_unit: 0.016 / 60,
    valid_from: null,
    valid_until: null,
    source: '§2.5 V2 の Standard $0.016／分',
    caveat: 'モデルの区分は Standard と仮定、1 秒単位の切り上げは未反映、重ねた 2 本の課金は要実測',
  },
  {
    provider: 'elevenlabs',
    unit: 'characters',
    usd_per_unit: 0.04 / 1000,
    valid_from: null,
    valid_until: null,
    source: '§3 Flash／Turbo は $0.04／1千文字',
    caveat: '取消分の課金は記載なし（全額と見なしている）。プラン同梱分は未反映',
  },
  {
    provider: 'elevenlabs',
    unit: 'characters',
    usd_per_unit: 0.08 / 1000,
    valid_from: null,
    valid_until: null,
    source: '§3 Multilingual v2 は $0.08',
    caveat: '取消分の課金は記載なし（全額と見なしている）。プラン同梱分は未反映',
  },
  ...geminiRates('gemini-3.5-flash-lite', 0.3, 2.5, null, null),
  ...geminiRates('gemini-3.8-flash', 0.75, 3.75, null, GEMINI_3_8_RATE_CHANGE),
  ...geminiRates('gemini-3.8-flash', 1.5, 7.5, GEMINI_3_8_RATE_CHANGE, null),
];

function geminiRates(
  model: string,
  input: number,
  output: number,
  valid_from: string | null,
  valid_until: string | null,
): EvidencedRate[] {
  const base = {
    provider: 'gemini',
    valid_from,
    valid_until,
    caveat: '無料枠は未反映。中断しても課金は続く（中断分は数量が取れず不明）',
  };
  return [
    {
      ...base,
      unit: 'input_tokens',
      usd_per_unit: input * PER_MTOK,
      source: `§4 ${model} 入力 $${input}（100 万トークン）`,
    },
    {
      ...base,
      unit: 'output_tokens',
      usd_per_unit: output * PER_MTOK,
      source: `§4 ${model} 出力 $${output}（100 万トークン）`,
    },
  ];
}

const RATE_TOLERANCE = 1e-6;

function matchRate(
  provider: string,
  unit: string,
  quantity: number,
  usd: number,
  wallClock: string,
): EvidencedRate | null {
  const at = Date.parse(wallClock);
  for (const rate of EVIDENCED_RATES) {
    if (rate.provider !== provider || rate.unit !== unit) continue;
    if (rate.valid_from !== null && at < Date.parse(rate.valid_from)) continue;
    if (rate.valid_until !== null && at >= Date.parse(rate.valid_until)) continue;
    const expected = quantity * rate.usd_per_unit;
    if (Math.abs(usd - expected) <= Math.max(expected, 1e-12) * RATE_TOLERANCE) return rate;
  }
  return null;
}

export interface CostQuantity {
  unit: string;
  quantity: number;
}

export interface ProviderCost {
  provider: string;
  /** 根拠のある推定の合計。1 件もなければ null（0 ではない）。 */
  estimated_usd: number | null;
  /** 合計に入れた件数。 */
  evidenced_count: number;
  /** 不明の件数。 */
  unknown_count: number;
  /** 不明の理由ごとの件数。 */
  unknown_reasons: Record<string, number>;
  quantities: CostQuantity[];
  /** 適用した単価の根拠と前提。 */
  rate_sources: string[];
  caveats: string[];
}

export interface CostSummary {
  /** 表示に必ず添える区分。 */
  kind: 'estimate_from_list_price_not_invoice';
  /**
   * no_usage: cost.usage が 1 件もない（未計測で、0 円ではない）
   * partial: 不明を含む。estimated_usd は下限
   * complete: すべての件に根拠のある単価がある
   */
  status: 'no_usage' | 'partial' | 'complete';
  estimated_usd: number | null;
  event_count: number;
  unknown_count: number;
  by_provider: ProviderCost[];
}

export const REASON_RATE_NOT_IN_MATRIX = 'rate_not_in_provider_matrix';

export function summarizeCost(events: Iterable<ResearchEvent>): CostSummary {
  const providers = new Map<string, ProviderCost>();
  let event_count = 0;
  let unknown_count = 0;
  let estimated_usd: number | null = null;
  for (const event of events) {
    if (event.event !== 'cost.usage') continue;
    event_count += 1;
    let row = providers.get(event.provider);
    if (row === undefined) {
      row = {
        provider: event.provider,
        estimated_usd: null,
        evidenced_count: 0,
        unknown_count: 0,
        unknown_reasons: {},
        quantities: [],
        rate_sources: [],
        caveats: [],
      };
      providers.set(event.provider, row);
    }
    const quantity = row.quantities.find((q) => q.unit === event.unit);
    if (quantity === undefined) row.quantities.push({ unit: event.unit, quantity: event.quantity });
    else quantity.quantity += event.quantity;

    const reported = event.estimated_cost_usd;
    const rate =
      reported.value === null
        ? null
        : matchRate(event.provider, event.unit, event.quantity, reported.value, event.wall_clock);
    if (reported.value !== null && rate !== null) {
      row.estimated_usd = (row.estimated_usd ?? 0) + reported.value;
      row.evidenced_count += 1;
      estimated_usd = (estimated_usd ?? 0) + reported.value;
      if (!row.rate_sources.includes(rate.source)) row.rate_sources.push(rate.source);
      if (rate.caveat !== null && !row.caveats.includes(rate.caveat)) row.caveats.push(rate.caveat);
    } else {
      const reason = reported.value === null ? reported.null_reason : REASON_RATE_NOT_IN_MATRIX;
      row.unknown_count += 1;
      row.unknown_reasons[reason] = (row.unknown_reasons[reason] ?? 0) + 1;
      unknown_count += 1;
    }
  }
  return {
    kind: 'estimate_from_list_price_not_invoice',
    status: event_count === 0 ? 'no_usage' : unknown_count > 0 ? 'partial' : 'complete',
    estimated_usd,
    event_count,
    unknown_count,
    by_provider: [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
  };
}
