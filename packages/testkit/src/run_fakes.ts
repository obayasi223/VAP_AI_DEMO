/**
 * 偽サーバーをまとめて起動する（`npm run dev:fakes`）。Google STT は gRPC の層なので
 * プロセス内の FakeGoogleSttTransport を使い、ここでは起動しない。
 */
import { FakeBrowserEchoServer } from './fakes/browser_audio';
import { FakeElevenLabsServer } from './fakes/elevenlabs';
import { FakeGeminiServer } from './fakes/gemini';
import { FakeMaaiRpcServer } from './fakes/maai_rpc';

const port = (name: string, fallback: number): number => Number(process.env[name] ?? fallback);

const browser = new FakeBrowserEchoServer({ port: port('FAKE_BROWSER_ECHO_PORT', 9101) });
const maai = new FakeMaaiRpcServer({ port: port('FAKE_MAAI_PORT', 9102) });
const eleven = new FakeElevenLabsServer({ port: port('FAKE_ELEVENLABS_PORT', 9103) });
const gemini = new FakeGeminiServer({ port: port('FAKE_GEMINI_PORT', 9104) });

const ports = {
  browser_echo: await browser.start(),
  maai_rpc: await maai.start(),
  elevenlabs: await eleven.start(),
  gemini: await gemini.start(),
};

console.log('FAKE SERVERS. Results obtained here do not count as production verification.');
console.log(JSON.stringify(ports));

const shutdown = async () => {
  await Promise.all([browser.stop(), maai.stop(), eleven.stop(), gemini.stop()]);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
