/**
 * /research の WS の上りと接続時の下り（I2 が追加。server.ts からは数行で呼ぶ）。
 *  - 接続の直後に research.config を送り、画面に p の添字を伝える。
 *  - 研究者のメモ（research.note）を今のセッションのログへ research.note イベントとして書き、ack を返す。
 * 契約は packages/contracts/src/research_rpc.ts。
 */
import { ResearchToNode, type EventEmitter, type NodeToResearch, type Policy } from '@llm-vap/contracts';
import { vapDirectionSettings } from '../control/vap_direction';

export function researchConfigMessage(policy: Policy, condition: string): NodeToResearch {
  const direction = vapDirectionSettings(policy);
  return {
    type: 'research.config',
    policy_id: policy.policy_id,
    p_ai_index: direction.p_ai_index,
    direction_status: direction.direction_status,
    condition,
  };
}

export interface NoteTarget {
  session_id: string;
  emitter: EventEmitter;
}

/** 上りの 1 テキスト枠を処理して、返す ack を返す。target は今のセッション（なければ null）。 */
export function handleResearchMessage(text: string, target: NoteTarget | null): NodeToResearch {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { type: 'research.note.ack', note_id: null, status: 'invalid', detail: 'not_json' };
  }
  const parsed = ResearchToNode.safeParse(raw);
  if (!parsed.success) {
    const id = (raw as { note_id?: unknown } | null)?.note_id;
    const first = parsed.error.issues[0];
    return {
      type: 'research.note.ack',
      note_id: typeof id === 'string' && id !== '' ? id : null,
      status: 'invalid',
      detail: first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'contract_violation',
    };
  }
  const note = parsed.data;
  if (target === null) {
    return { type: 'research.note.ack', note_id: note.note_id, status: 'no_session', detail: 'no_active_session' };
  }
  target.emitter.emit({
    event: 'research.note',
    note_id: note.note_id,
    text: note.text,
    client_wall_clock: note.client_wall_clock,
  });
  return { type: 'research.note.ack', note_id: note.note_id, status: 'logged', session_id: target.session_id };
}
