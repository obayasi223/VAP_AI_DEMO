import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer, analyzeWithGemini } from '../server.mjs';

test('local server serves main UI, status and operator commands', async (t) => {
  const server = createAppServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const status = await fetch(`${base}/api/status`);
  assert.equal(status.status, 200);
  assert.ok((await status.json()).model);
  const homepage = await fetch(base);
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /breath-wisps/);
  const control = await fetch(`${base}/api/command`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'cue',utterance:'テスト'}) });
  assert.equal(control.status, 200);
  const badControl = await fetch(`${base}/api/command`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'unsafe'}) });
  assert.equal(badControl.status, 400);
  const forbidden = await fetch(`${base}/..%2fserver.mjs`);
  assert.notEqual(forbidden.status, 200);
});

test('Gemini response is parsed and normalized using injectable fetch', async () => {
  const fakeFetch = async (_, options) => {
    const sent = JSON.parse(options.body);
    assert.match(sent.contents[0].parts[0].text, /研究/);
    assert.equal(options.headers['x-goog-api-key'], 'test-key');
    return { ok: true, json: async () => ({ candidates:[{content:{parts:[{text:JSON.stringify({want_to_speak:true,intent_type:'質問',reason:'前提が不明',utterance:'その前提について聞いてもいいですか？',intensity:0.8})}]}}]}) };
  };
  const result = await analyzeWithGemini({ transcript:'研究アイデアの発話を途中まで説明しています。',scenario:'研究相談' },{ apiKey:'test-key',fetchFn:fakeFetch });
  assert.equal(result.want_to_speak, true);
  assert.equal(result.intent_type, '質問');
  assert.match(result.utterance, /前提/);
});
