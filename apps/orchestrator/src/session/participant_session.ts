/**
 * 1 対 1 と 2 体が共通に満たす口（server の配線の共通部分だけ。docs/design/two_ai/06 §10）。
 */
import type { BrowserToNode, ClientHello, SessionCondition } from '@llm-vap/contracts';
import type { BrowserLink, SessionStatusView } from './session';

export interface ParticipantSession {
  readonly session_id: string;
  readonly condition: SessionCondition;
  readonly attached: boolean;
  start(link: BrowserLink, hello: ClientHello): Promise<void>;
  reattach(link: BrowserLink, hello: ClientHello): void;
  detach(reason: string): void;
  handleBinary(data: Uint8Array): void;
  handleJson(message: BrowserToNode): void;
  status(): SessionStatusView;
  close(reason: string): Promise<void>;
}
