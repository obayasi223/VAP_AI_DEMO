import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeFeed,
  createJsonlFeed,
  createWsFeed,
  feedFromQuery,
  type FeedConnection,
  type FeedSink,
} from '../../src/research/feed';

function recorder() {
  const events: unknown[] = [];
  const malformed: string[] = [];
  const states: FeedConnection[] = [];
  const sink: FeedSink = {
    event: (v) => events.push(v),
    malformed: (d) => malformed.push(d),
    connection: (s) => states.push(s),
  };
  return { sink, events, malformed, states };
}

class FakeSocket extends EventTarget {
  closed = false;
  close() {
    this.closed = true;
  }
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  fire(type: string) {
    this.dispatchEvent(new Event(type));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('feedFromQuery', () => {
  it('指定がなければ偽データにせずデータ源なし', () => {
    expect(feedFromQuery('').kind).toBe('none');
    expect(feedFromQuery('?source=unknown').kind).toBe('none');
    expect(feedFromQuery('?source=ws').kind).toBe('none');
  });

  it('偽データだけが synthetic', () => {
    expect(feedFromQuery('?source=fake')).toMatchObject({ kind: 'fake', synthetic: true });
    expect(feedFromQuery('?source=ws&url=ws://x')).toMatchObject({ kind: 'ws', synthetic: false });
    expect(createJsonlFeed('', 'a.jsonl')).toMatchObject({ kind: 'jsonl', synthetic: false });
  });
});

describe('createJsonlFeed', () => {
  it('行ごとに流し、読めない行は malformed へ', () => {
    const { sink, events, malformed, states } = recorder();
    createJsonlFeed('{"a":1}\nbroken\n\n{"a":2}\n', 'x').start(sink);
    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
    expect(malformed).toHaveLength(1);
    expect(states).toEqual(['open', 'closed']);
  });
});

describe('createFakeFeed', () => {
  it('全件を順に流して終わる', () => {
    vi.useFakeTimers();
    const { sink, events, states } = recorder();
    const stop = createFakeFeed({ stepMs: 10 }).start(sink);
    vi.advanceTimersByTime(10_000);
    expect(events.length).toBeGreaterThan(10);
    expect(states).toEqual(['open', 'closed']);
    stop();
  });
});

describe('createWsFeed', () => {
  it('テキスト枠を JSONL と同じ形で受け、切断で再接続する', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const feed = createWsFeed('ws://x', {
      retryMs: 100,
      connect: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const { sink, events, malformed, states } = recorder();
    const stop = feed.start(sink);
    sockets[0]?.fire('open');
    sockets[0]?.receive('{"a":1}\n{"a":2}');
    sockets[0]?.receive(new ArrayBuffer(1));
    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
    expect(malformed).toHaveLength(1);
    sockets[0]?.fire('close');
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
    expect(states).toEqual(['connecting', 'open', 'closed', 'connecting']);
    stop();
    expect(sockets[1]?.closed).toBe(true);
    sockets[1]?.fire('close');
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });
});
