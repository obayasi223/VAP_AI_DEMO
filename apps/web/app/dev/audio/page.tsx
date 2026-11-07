'use client';

/**
 * 全二重音声の試験ページ（レーン A）。参加者には見せない。
 * クエリ: ?ws=ws://127.0.0.1:9101（既定は dev:fakes のエコー）
 * 実ブラウザ試験（test/audio_browser）は window.__audioDev を使う。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { startBrowserAudio, type BrowserAudioOptions, type BrowserAudioSession } from '../../../src/audio';

type InputMode =
  | { kind: 'microphone' }
  | { kind: 'loopback'; delayFrames: number }
  | { kind: 'oscillator'; amplitude: number };

interface DevLog {
  received: unknown[];
  sent: unknown[];
  link: { state: string; detail: string }[];
  errors: string[];
}

interface AudioDevHandle {
  start(mode: InputMode, overrides?: Partial<BrowserAudioOptions>): Promise<void>;
  stop(): Promise<void>;
  session(): BrowserAudioSession | null;
  oscillator(): OscillatorNode | null;
  log: DevLog;
}

declare global {
  interface Window {
    __audioDev?: AudioDevHandle;
  }
}

export default function DevAudioPage() {
  const sessionRef = useRef<BrowserAudioSession | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const logRef = useRef<DevLog>({ received: [], sent: [], link: [], errors: [] });
  const [wsUrl, setWsUrl] = useState('ws://127.0.0.1:9101');
  const [status, setStatus] = useState('未開始');
  const [view, setView] = useState('');

  const start = useCallback(
    async (mode: InputMode, overrides: Partial<BrowserAudioOptions> = {}) => {
      const log = logRef.current;
      const inputSource: BrowserAudioOptions['inputSource'] =
        mode.kind === 'microphone'
          ? undefined
          : mode.kind === 'loopback'
            ? (context, processor) => {
                const delay = context.createDelay(0.1);
                delay.delayTime.value = mode.delayFrames / context.sampleRate;
                processor.connect(delay);
                return delay;
              }
            : (context) => {
                const oscillator = context.createOscillator();
                const gain = context.createGain();
                gain.gain.value = mode.amplitude;
                oscillator.connect(gain);
                oscillator.start();
                oscillatorRef.current = oscillator;
                return gain;
              };
      const url = new URLSearchParams(window.location.search).get('ws') ?? wsUrl;
      sessionRef.current = await startBrowserAudio({
        wsUrl: url,
        ...(inputSource === undefined ? {} : { inputSource }),
        onMessage: (message) => log.received.push(message),
        onSent: (message) => log.sent.push(message),
        onLink: (state, detail) => {
          log.link.push({ state, detail });
          setStatus(state);
        },
        onError: (detail) => log.errors.push(detail),
        ...overrides,
      });
    },
    [wsUrl],
  );

  const stop = useCallback(async () => {
    await sessionRef.current?.stop();
    sessionRef.current = null;
    setStatus('停止');
  }, []);

  useEffect(() => {
    window.__audioDev = {
      start,
      stop,
      session: () => sessionRef.current,
      oscillator: () => oscillatorRef.current,
      log: logRef.current,
    };
    const timer = setInterval(() => {
      const session = sessionRef.current;
      if (!session) return;
      const latency = session.latencyHistory().at(-1)?.latency ?? null;
      setView(
        JSON.stringify(
          {
            sampleRateHz: session.sampleRateHz,
            contextState: session.context.state,
            trackSettings: session.trackSettings,
            stats: session.stats(),
            clock: session.clockEstimate(),
            latency,
            lifecycle: session.lifecycleHistory().slice(-5),
          },
          null,
          2,
        ),
      );
    }, 500);
    return () => {
      clearInterval(timer);
      delete window.__audioDev;
    };
  }, [start, stop]);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16, maxWidth: 760 }}>
      <h1 style={{ fontSize: 20 }}>全二重音声の試験</h1>
      <p>ヘッドホン＋近接マイクで確認する。Bluetooth は推奨しない。</p>
      <label>
        WS:{' '}
        <input
          value={wsUrl}
          onChange={(event) => setWsUrl(event.target.value)}
          style={{ width: 320 }}
          aria-label="WS の URL"
        />
      </label>{' '}
      <button
        id="start"
        onClick={() => {
          start({ kind: 'microphone' }).catch((error: unknown) => setStatus(`失敗: ${String(error)}`));
        }}
      >
        はじめる
      </button>{' '}
      <button id="stop" onClick={() => void stop()}>
        止める
      </button>
      <p id="status">状態: {status}</p>
      <pre id="view" style={{ background: '#f4f4f4', padding: 12, overflowX: 'auto', fontSize: 12 }}>
        {view}
      </pre>
    </main>
  );
}
