/**
 * スロットごとの範囲つき emitter（docs/design/two_ai/06 §4.1）。封筒の two_ai に ai_id と point_id を入れる。
 * point_id は関数で受ける（発話ごとに変わる。speech.* は発話の origin の point_id を優先する）。
 * 渡した options.two_ai があればそれを優先する（呼び手が明示した範囲）。two_ai_context のない emitter では無視される。
 */
import type { AiId, EmitOptions, EventDraft, EventEmitter, ResearchEvent } from '@llm-vap/contracts';

export function scopedEmitter(inner: EventEmitter, scope: { ai_id: AiId | null; point_id?: () => string | null }): EventEmitter {
  return {
    emit(draft: EventDraft, options?: EmitOptions): ResearchEvent {
      if (options?.two_ai !== undefined) return inner.emit(draft, options);
      const own = (draft as { origin?: unknown; point_id?: unknown }).origin === 'two_ai_turn' ? ((draft as { point_id?: string | null }).point_id ?? null) : undefined;
      const point_id = own !== undefined ? own : (scope.point_id?.() ?? null);
      return inner.emit(draft, { ...(options ?? {}), two_ai: { ai_id: scope.ai_id, point_id } });
    },
  };
}

/** 進行役の emit の行動など、ai_id と point_id を 1 件ごとに決めるとき。 */
export function emitScoped(inner: EventEmitter, draft: EventDraft, scope: { ai_id: AiId | null; point_id: string | null }, at?: EmitOptions['at']): ResearchEvent {
  return inner.emit(draft, { ...(at ? { at } : {}), two_ai: scope });
}
