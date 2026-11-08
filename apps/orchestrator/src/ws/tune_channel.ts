/**
 * 開発用の調整画面（/tune）向けの下り（/research の WS に ?tune=1 を付けた接続だけ）。契約は research_rpc.ts。
 *  - 接続の直後に research.policy（実際に使っている方策と上書きの記録）。
 *  - 約 100ms ごとと turn.allowed のたびに research.turn_diagnostic（TurnManager の state からの読み出し、dev/turn_diagnostic.ts）。
 * 送るのは調整画面の接続だけで、/research の画面（view_store は知らない type を不正として数える）には送らない。
 * セッションの tick には何もしない（state を読むだけ）。
 */
import { WebSocket } from 'ws';
import type { NodeToTune, ResearchEvent, TimeSource, Vap2chState } from '@llm-vap/contracts';
import type { OrchestratorConfig } from '../app/config';
import { controlSettings } from '../control';
import type { ControlSettings, TurnState } from '../control';
import { buildTurnDiagnostic } from '../dev/turn_diagnostic';

export interface TuneSessionView {
  session_id: string;
  turnState: TurnState;
}

const DIAGNOSTIC_INTERVAL_MS = 100;

export class TuneChannel {
  private readonly clients = new Set<WebSocket>();
  private readonly settings: ControlSettings;
  private latestVap: Vap2chState | null = null;
  private lastReason: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: OrchestratorConfig,
    private readonly current: () => { session: TuneSessionView; time: TimeSource } | null,
  ) {
    const policy = config.policy;
    this.settings = controlSettings(policy, {
      fallback_energy_silence_threshold: policy.policy_id === 'ja' ? (policy.turn.fallback_energy_silence_dbfs ?? null) : null,
    });
  }

  attach(ws: WebSocket): void {
    this.sendTo(ws, {
      type: 'research.policy',
      policy: this.config.policy,
      policy_file: this.config.policy_file,
      override: this.config.policy_override,
    });
    this.clients.add(ws);
    ws.on('close', () => {
      this.clients.delete(ws);
      if (this.clients.size === 0) this.stopTimer();
    });
    if (this.timer === null) this.timer = setInterval(() => this.push(), DIAGNOSTIC_INTERVAL_MS);
  }

  /** 新しいセッションの前に、前のセッションの値を捨てる。 */
  resetSession(): void {
    this.latestVap = null;
    this.lastReason = null;
  }

  /** broadcast するイベントを見る（server.ts から）。 */
  observe(event: ResearchEvent): void {
    if (event.event === 'vap.state' && event.channel_layout === '2ch') {
      const { schema_version: _s, t_monotonic_ms: _t, wall_clock: _w, session_id: _id, condition: _c, time_basis: _b, event: _e, ...rest } = event;
      this.latestVap = rest as Vap2chState;
    } else if (event.event === 'turn.allowed') {
      this.lastReason = event.reason;
      if (this.clients.size > 0) this.push();
    }
  }

  close(): void {
    this.stopTimer();
    for (const client of this.clients) client.terminate();
    this.clients.clear();
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private push(): void {
    const current = this.current();
    if (current === null || this.clients.size === 0) return;
    let message: NodeToTune;
    try {
      message = {
        type: 'research.turn_diagnostic',
        session_id: current.session.session_id,
        ...buildTurnDiagnostic(this.settings, current.session.turnState, this.latestVap, current.time.monotonicMs(), this.lastReason),
      };
    } catch {
      return; // 読み出しの失敗で会話の経路を止めない
    }
    const line = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 1024 * 1024) client.send(line);
    }
  }

  private sendTo(ws: WebSocket, message: NodeToTune): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }
}
