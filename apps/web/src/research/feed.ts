/**
 * 研究者画面のデータ源の口。ここを差し替えるだけで偽データ、WS、JSONL を切り替える。
 * 1 件の形は JSONL の 1 行と同じ（ResearchEvent の JSON）。検証は受け手の ResearchViewStore がする。
 *
 * J の配線: orchestrator からこの画面向けの WS へ、イベントの JSON を 1 テキスト枠に 1 件（改行区切りも可）で流す。
 */
import { createFakeEventScript } from './fake_events';

export type FeedConnection = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface FeedSink {
  /** パース済みの値。スキーマ検証はまだしていない。 */
  event(value: unknown): void;
  /** JSON として読めなかった入力。 */
  malformed(detail: string): void;
  connection(state: FeedConnection, detail: string | null): void;
}

export interface ResearchFeed {
  kind: 'none' | 'fake' | 'ws' | 'jsonl';
  label: string;
  /** true の間、画面は偽データであることを常に表示する。 */
  synthetic: boolean;
  /** 開始して、停止用の関数を返す。 */
  start(sink: FeedSink): () => void;
}

/** 改行区切りの本文を流す。空行は飛ばす。 */
export function deliverLines(text: string, sink: FeedSink): void {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      sink.malformed(error instanceof Error ? error.message : String(error));
      continue;
    }
    sink.event(value);
  }
}

export function createNoFeed(): ResearchFeed {
  return {
    kind: 'none',
    label: 'データ源なし',
    synthetic: false,
    start(sink) {
      sink.connection('idle', null);
      return () => undefined;
    },
  };
}

/** 偽のイベント列。実データと混ざらないよう synthetic=true に固定し、session_id にも FAKE を含める。 */
export function createFakeFeed(options: { stepMs?: number } = {}): ResearchFeed {
  return {
    kind: 'fake',
    label: '偽のイベント列（test double）',
    synthetic: true,
    start(sink) {
      const script = createFakeEventScript();
      let index = 0;
      sink.connection('open', '偽のイベント列を再生中');
      const timer = setInterval(() => {
        const next = script[index];
        index += 1;
        if (next === undefined) {
          clearInterval(timer);
          sink.connection('closed', '偽のイベント列の再生が終了');
          return;
        }
        sink.event(next);
      }, options.stepMs ?? 150);
      return () => clearInterval(timer);
    },
  };
}

export function createJsonlFeed(text: string, name: string): ResearchFeed {
  return {
    kind: 'jsonl',
    label: `JSONL: ${name}`,
    synthetic: false,
    start(sink) {
      sink.connection('open', `${name} を読み込み`);
      deliverLines(text, sink);
      sink.connection('closed', `${name} の読み込みが終了`);
      return () => undefined;
    },
  };
}

type WebSocketLike = Pick<WebSocket, 'close' | 'addEventListener'>;

export function createWsFeed(
  url: string,
  options: { connect?: (url: string) => WebSocketLike; retryMs?: number } = {},
): ResearchFeed {
  const connect = options.connect ?? ((u: string) => new WebSocket(u));
  const retryMs = options.retryMs ?? 2000;
  return {
    kind: 'ws',
    label: `WS: ${url}`,
    synthetic: false,
    start(sink) {
      let stopped = false;
      let socket: WebSocketLike | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const open = () => {
        if (stopped) return;
        sink.connection('connecting', url);
        socket = connect(url);
        socket.addEventListener('open', () => sink.connection('open', url));
        socket.addEventListener('message', (message) => {
          if (typeof message.data === 'string') deliverLines(message.data, sink);
          else sink.malformed('binary frame on research feed');
        });
        socket.addEventListener('error', () => sink.connection('error', `接続に失敗: ${url}`));
        socket.addEventListener('close', () => {
          if (stopped) return;
          sink.connection('closed', `切断。${retryMs}ms 後に再接続`);
          timer = setTimeout(open, retryMs);
        });
      };
      open();
      return () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
        socket?.close();
      };
    },
  };
}

/** クエリから選ぶ: ?source=fake、?source=ws&url=ws://…。指定がなければデータ源なし（偽データを既定にしない）。 */
export function feedFromQuery(search: string): ResearchFeed {
  const params = new URLSearchParams(search);
  const source = params.get('source');
  if (source === 'fake') return createFakeFeed();
  if (source === 'ws') {
    const url = params.get('url');
    if (url !== null && url !== '') return createWsFeed(url);
  }
  return createNoFeed();
}
