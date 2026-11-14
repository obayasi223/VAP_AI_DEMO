/**
 * MaAI の配線（session.ts の attachMaai と overlapsZeroFill から切り出し。docs/design/two_ai/06 §11、01 §1.3。WP1a）。
 */
import type { EventEmitter, Unsubscribe, Vap2chState } from '@llm-vap/contracts';
import type { WorkerClockRecorder } from '../../logging';
import { attachMaaiEventBridge } from '../../maai';
import type { MaaiWorkerClient } from '../../maai';

/** vap.state の入力の窓（worker の1周期）。raw.worker_input がないときの代わり。 */
const ZERO_FILL_VAP_WINDOW_FRAMES = 1280;

function stripType<T extends { type: unknown }>(message: T): Omit<T, 'type'> {
  const { type: _type, ...rest } = message;
  return rest;
}

export type VapStateMessage = Vap2chState & { type: 'VAP_STATE'; raw: unknown };

export class MaaiSessionWiring {
  private state: Vap2chState | null = null;
  private receivedAt: number | null = null;
  private readyAt: number | null = null;
  /** ネットワーク欠損でゼロ埋めされた音声の範囲（FRAMES_DROPPED）。 */
  private readonly zeroFilledFrames: { from: number; to: number }[] = [];

  constructor(
    private readonly deps: {
      maai: MaaiWorkerClient | null;
      unavailableReason: string | null;
      emitter: EventEmitter;
      workerClock: WorkerClockRecorder;
      session_id: string;
      /** ゼロ埋めの判定の差し替え口（Session は自分のメソッドを通す。既存の試験が Session.prototype を差し替えるため）。 */
      overlapsZeroFill?: (message: { audio_frame: number; raw: unknown }) => boolean;
    },
  ) {}

  /** MaAI が無効なら購読せず、degraded の理由を返す。 */
  attach(onVap: (state: Vap2chState, at: number, raw: VapStateMessage) => void): { unsubscribe: Unsubscribe[]; fixedReason: string | null } {
    const maai = this.deps.maai;
    if (maai === null) return { unsubscribe: [], fixedReason: `vap_unavailable:${this.deps.unavailableReason ?? 'maai_disabled'}` };
    const unsubscribe: Unsubscribe[] = [];
    unsubscribe.push(attachMaaiEventBridge(maai, { emitter: this.deps.emitter, clock: this.deps.workerClock, systemChannelSource: 'written' }));
    unsubscribe.push(
      maai.subscribe({
        onReady: (_ready, at) => {
          this.readyAt = at;
        },
        onError: (error, at) => {
          // 文脈を捨てて続行した（READY は来ない）。VAP の助走を数え直す。準備前のワーカーを「準備済み」にはしない。
          if (error.code === 'process_failed_reset' && this.readyAt !== null) this.readyAt = at;
        },
        onVapState: (message, at) => {
          // 設定し直す前の結果（前のセッションの番号）は使わない。
          if (this.readyAt === null || message.channel_layout !== '2ch') return;
          // ゼロ埋めの音声で計算した値は VAP として使わない（docs/known_gaps.md §12）。入力を更新しなければ、続いたときだけ stale になる。
          if ((this.deps.overlapsZeroFill ?? ((m) => this.overlapsZeroFill(m)))(message)) return;
          this.state = stripType(message) as Vap2chState;
          this.receivedAt = at;
          onVap(this.state, at, message as unknown as VapStateMessage);
        },
        onFramesDropped: (message) => {
          if (!message.zero_filled) return;
          this.zeroFilledFrames.push({ from: message.from_audio_frame, to: message.from_audio_frame + message.sample_count });
          if (this.zeroFilledFrames.length > 64) this.zeroFilledFrames.shift();
        },
        onAvailability: (availability) => {
          if (!availability.vap_available) {
            this.readyAt = null;
            this.state = null;
            this.receivedAt = null;
          }
        },
      }),
    );
    // 前のセッションの番号と結果を混ぜないよう、ワーカーにも新しい CONFIGURE を送る。
    // ブラウザの audio_frame は同じページの中では 0 に戻らない（猶予切れの後に同じタブから来た場合など）。
    void maai.reconfigure(this.deps.session_id);
    return { unsubscribe, fixedReason: null };
  }

  /** vap.state の入力の窓（worker_input の from〜audio_frame）がゼロ埋めの範囲にかかっているか。 */
  overlapsZeroFill(message: { audio_frame: number; raw: unknown }): boolean {
    if (this.zeroFilledFrames.length === 0) return false;
    const input = (message.raw as { worker_input?: { from_audio_frame?: unknown } } | null)?.worker_input;
    const from = typeof input?.from_audio_frame === 'number' ? input.from_audio_frame : message.audio_frame - ZERO_FILL_VAP_WINDOW_FRAMES;
    return this.zeroFilledFrames.some((z) => from < z.to && message.audio_frame > z.from);
  }

  get vap(): Vap2chState | null {
    return this.state;
  }

  get vapReceivedAt(): number | null {
    return this.receivedAt;
  }

  get workerReadyAt(): number | null {
    return this.readyAt;
  }

  get enabled(): boolean {
    return this.deps.maai !== null;
  }

  /** 準備ができていれば MaAI へ送る（session.ts:759 と同じ条件）。 */
  sendEncodedAudio(data: Uint8Array, sample_count: number): void {
    if (this.readyAt !== null) this.deps.maai?.sendEncodedAudio(data, sample_count);
  }
}
