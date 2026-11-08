import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewConflict, ReviewInvalid, ReviewStore, type ReviewDocument } from '../lib/reviews';
import { ReviewServer } from '../lib/server';
import { tempRoot, writeSession } from './synthetic';

const snapshot = { kind: 'candidate', t_ms: 3000, headline: 'NEW', prompt_versions: ['v1'], conversation_type: '共同思考' };
const body = (extra: Record<string, unknown> = {}) => ({
  items: {
    'c:c_0001': { content: 'valid', timing: 'early', wait_withdraw: 'should_have_withdrawn', notes: '合成のメモ', updated_at: '2026-01-01T00:00:00.000Z', snapshot },
  },
  missed: [],
  ...extra,
});

describe('評価の保存', () => {
  let root: string;
  let store: ReviewStore;
  beforeEach(() => {
    root = tempRoot();
    writeSession(root, 's_a');
    store = new ReviewStore(root);
  });

  it('保存して読み戻す（3列は別々の項目のまま）', () => {
    const saved = store.save('s_a', '評価者一', body(), 0);
    expect(saved.revision).toBe(1);
    const loaded = store.load('s_a', '評価者一') as ReviewDocument;
    expect(loaded.items['c:c_0001']).toMatchObject({ content: 'valid', timing: 'early', wait_withdraw: 'should_have_withdrawn', notes: '合成のメモ' });
    expect(loaded.format).toBe('initiative_review/1');
    expect(loaded.reviewer).toBe('評価者一');
    expect(existsSync(path.join(root, 's_a', 'initiative_review', `${encodeURIComponent('評価者一')}.json`))).toBe(true);
  });

  it('評価者ごとに別のファイルに分かれ、混ざらない', () => {
    store.save('s_a', '評価者一', body(), 0);
    const other = body();
    other.items['c:c_0001'] = { ...other.items['c:c_0001'], content: 'invalid', timing: 'good' };
    store.save('s_a', '評価者二', other, 0);
    expect(store.reviewers('s_a')).toEqual(['評価者一', '評価者二'].sort());
    expect(store.load('s_a', '評価者一')?.items['c:c_0001']?.content).toBe('valid');
    expect(store.load('s_a', '評価者二')?.items['c:c_0001']?.content).toBe('invalid');
  });

  it('見逃しの印を内容つきで保存し、時刻の順で読み戻す', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const marks = [
      { id: 'm2', t_ms: 9000, anchor_item_key: 'n:ini_0004', anchor_line_id: null, content: '予算の根拠を聞くべきだった', timing_note: '言い切った直後', created_at: now, updated_at: now },
      { id: 'm1', t_ms: 2000, anchor_item_key: null, anchor_line_id: 'u1', content: '大きさを確かめたかった', timing_note: '', created_at: now, updated_at: now },
    ];
    store.save('s_a', '評価者一', body({ missed: marks }), 0);
    const loaded = store.load('s_a', '評価者一') as ReviewDocument;
    expect(loaded.missed.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(loaded.missed[1]).toMatchObject({ anchor_item_key: 'n:ini_0004', content: '予算の根拠を聞くべきだった', timing_note: '言い切った直後' });
  });

  it('内容のない見逃しの印は受け付けない', () => {
    const now = '2026-01-01T00:00:00.000Z';
    expect(() => store.save('s_a', '評価者一', body({ missed: [{ id: 'm', t_ms: 1, content: '  ', created_at: now, updated_at: now }] }), 0)).toThrow(ReviewInvalid);
  });

  it('知らない評価値は受け付けず、ファイルは作らない', () => {
    const bad = body();
    (bad.items['c:c_0001'] as Record<string, unknown>).timing = 'NEW';
    expect(() => store.save('s_a', '評価者一', bad, 0)).toThrow(ReviewInvalid);
    expect(store.load('s_a', '評価者一')).toBeNull();
  });

  it('revision が合わない保存は ReviewConflict で弾き、上書きしない', () => {
    store.save('s_a', '評価者一', body(), 0);
    expect(() => store.save('s_a', '評価者一', body({ items: {} }), 0)).toThrow(ReviewConflict);
    expect(store.load('s_a', '評価者一')?.revision).toBe(1);
    expect(Object.keys(store.load('s_a', '評価者一')?.items ?? {})).toHaveLength(1);
  });

  it('評価者の名前の区切り文字はファイルの外へ出ない', () => {
    store.save('s_a', '../evil', body(), 0);
    expect(store.reviewers('s_a')).toEqual(['../evil']);
    expect(existsSync(path.join(root, 'evil.json'))).toBe(false);
    expect(existsSync(path.join(root, 's_a', 'evil.json'))).toBe(false);
  });

  it('空の名前と未知のセッションは受け付けない', () => {
    expect(() => store.save('s_a', '   ', body(), 0)).toThrow(ReviewInvalid);
    expect(() => store.save('s_none', '評価者一', body(), 0)).toThrow(ReviewInvalid);
    expect(() => store.save('../s_a', '評価者一', body(), 0)).toThrow(ReviewInvalid);
  });
});

function request(port: number, options: http.RequestOptions, payload?: string): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('評価画面のサーバ', () => {
  let root: string;
  let server: ReviewServer;
  let port: number;
  beforeEach(async () => {
    root = tempRoot();
    writeSession(root, 's_a', { manifest: { conversation_type: 'companion', initiative: { prompt_version: 'v1', persona_id: 'p' } } });
    writeSession(root, 's_b', { manifest: { conversation_type: 'co_thinking', initiative: { prompt_version: 'v2', persona_id: 'p' } } });
    server = new ReviewServer({ sessions_dir: root, port: 0, log: () => {} });
    port = await server.listen();
  });
  afterEach(async () => {
    await server.close();
  });

  it('127.0.0.1 で待ち受け、別の Host と別の Origin を拒む', async () => {
    expect((server.http.address() as { address: string }).address).toBe('127.0.0.1');
    expect((await request(port, { path: '/', headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await request(port, { path: '/api/sessions', headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await request(port, { path: '/' })).status).toBe(200);
  });

  it('一覧と判定を会話の種類とプロンプトの版で絞り込む', async () => {
    const list = JSON.parse((await request(port, { path: '/api/sessions?conversation_type=' + encodeURIComponent('コンパニオン') })).body.toString()) as { sessions: { session_id: string }[]; options: { prompt_versions: string[] } };
    expect(list.sessions.map((s) => s.session_id)).toEqual(['s_a']);
    expect(list.options.prompt_versions).toEqual(['v1', 'v2']);
    const session = JSON.parse((await request(port, { path: '/api/sessions/s_a?prompt_version=v9' })).body.toString()) as { items: unknown[]; lines: unknown[] };
    expect(session.items).toEqual([]);
    // 絞り込みでも会話の行は残す（前後の会話と見逃しの印に要る）。
    expect(session.lines.length).toBeGreaterThan(0);
  });

  it('評価を PUT で保存して GET で読み戻す。revision が古ければ 409', async () => {
    const headers = { 'content-type': 'application/json' };
    const url = `/api/sessions/s_a/reviews/${encodeURIComponent('評価者一')}`;
    const payload = JSON.stringify({ base_revision: 0, ...body() });
    const saved = await request(port, { method: 'PUT', path: url, headers }, payload);
    expect(saved.status).toBe(200);
    const loaded = JSON.parse((await request(port, { path: url })).body.toString()) as ReviewDocument;
    expect(loaded.revision).toBe(1);
    expect(loaded.items['c:c_0001']?.timing).toBe('early');
    expect((await request(port, { method: 'PUT', path: url, headers }, payload)).status).toBe(409);
    expect(JSON.parse((await request(port, { path: '/api/sessions/s_a/reviewers' })).body.toString())).toEqual(['評価者一']);
  });

  it('json 以外の PUT と不正な評価値を拒む', async () => {
    const url = '/api/sessions/s_a/reviews/a';
    expect((await request(port, { method: 'PUT', path: url, headers: { 'content-type': 'text/plain' } }, '{}')).status).toBe(415);
    const bad = body();
    (bad.items['c:c_0001'] as Record<string, unknown>).content = 'nope';
    expect((await request(port, { method: 'PUT', path: url, headers: { 'content-type': 'application/json' } }, JSON.stringify({ base_revision: 0, ...bad }))).status).toBe(400);
  });

  it('音声は Range で途中から返し、一覧にない名前は返さない', async () => {
    const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    writeFileSync(path.join(root, 's_a', 'audio.wav'), data);
    const session = JSON.parse((await request(port, { path: '/api/sessions/s_a' })).body.toString()) as { meta: { audio_files: string[] } };
    expect(session.meta.audio_files).toEqual(['audio.wav']);
    const partial = await request(port, { path: '/api/sessions/s_a/audio/audio.wav', headers: { range: 'bytes=100-199' } });
    expect(partial.status).toBe(206);
    expect(partial.headers['content-range']).toBe('bytes 100-199/1000');
    expect(partial.body).toEqual(data.subarray(100, 200));
    expect((await request(port, { path: '/api/sessions/s_a/audio/audio.wav', headers: { range: 'bytes=2000-' } })).status).toBe(416);
    expect((await request(port, { path: `/api/sessions/s_a/audio/${encodeURIComponent('../manifest.json')}` })).status).toBe(404);
    expect((await request(port, { path: '/api/sessions/s_a/audio/manifest.json' })).status).toBe(404);
    expect(readFileSync(path.join(root, 's_a', 'audio.wav'))).toEqual(data);
  });

  it('未知のセッションと不正な ID は拒む', async () => {
    expect((await request(port, { path: '/api/sessions/s_none' })).status).toBe(404);
    expect((await request(port, { path: '/api/sessions/a..b' })).status).toBe(400);
  });
});
