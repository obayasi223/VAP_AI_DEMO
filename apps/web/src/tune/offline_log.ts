/**
 * 録音の再生で画面に出す記録の中身（events.jsonl）。React に依存しない。
 * VAP の値（2ch の vap.state）と、発話希望の流れに要るイベントだけを契約で検証して取り出す。
 * 判断の再計算は Node 側（/dev/replay）で、ここでは表示用に読むだけ。
 */
import { ResearchEvent } from '@llm-vap/contracts';
import type { VapLike } from './chart_spec';
import { buildInitiativeFlow, type FlowRow } from './initiative_flow';

const FLOW_EVENTS = new Set(['stt.interim', 'stt.final', 'llm.request', 'initiative.decision', 'candidate.state_changed', 'initiative.discarded', 'candidate.rejected']);

export interface OfflineLog {
  vap: VapLike[];
  flow: FlowRow[];
  /** 契約に合わず読み飛ばした行（表示に使う種類のみ数える）。 */
  invalid: number;
}

export function parseOfflineLog(text: string): OfflineLog {
  const vap: VapLike[] = [];
  const flowEvents: ResearchEvent[] = [];
  let invalid = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalid += 1;
      continue;
    }
    const name = (value as { event?: unknown } | null)?.event;
    if (name === 'vap.state') {
      const v = value as { channel_layout?: unknown; t_monotonic_ms?: unknown; p_now?: unknown; p_future?: unknown; vad?: unknown };
      const pair = (x: unknown): x is [number, number] => Array.isArray(x) && x.length === 2 && x.every((n) => typeof n === 'number');
      if (v.channel_layout === '2ch' && typeof v.t_monotonic_ms === 'number' && pair(v.p_now) && pair(v.p_future) && pair(v.vad))
        vap.push({ t: v.t_monotonic_ms, p_now: v.p_now, p_future: v.p_future, vad: v.vad });
      else if (v.channel_layout === '2ch') invalid += 1;
    } else if (typeof name === 'string' && FLOW_EVENTS.has(name)) {
      const parsed = ResearchEvent.safeParse(value);
      if (parsed.success) flowEvents.push(parsed.data);
      else invalid += 1;
    }
  }
  vap.sort((a, b) => a.t - b.t);
  return { vap, flow: buildInitiativeFlow(flowEvents), invalid };
}
