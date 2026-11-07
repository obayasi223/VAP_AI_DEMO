// Local stand-in for the STT v2 gRPC service. Checks request shapes; says nothing about real behaviour.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { grpc } from 'google-gax';
import protoLoader from '@grpc/proto-loader';

const require = createRequire(import.meta.url);
const speechDir = dirname(require.resolve('@google-cloud/speech/package.json'));
const gaxDir = join(dirname(require.resolve('google-gax')), '..', '..');

const dur = (ms) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6 });
const interim = (text, endMs, stability = 0) => ({
  alternatives: [{ transcript: text }], is_final: false, stability, result_end_offset: dur(endMs),
});
const final = (text, endMs) => ({ alternatives: [{ transcript: text, confidence: 0.9 }], is_final: true, result_end_offset: dur(endMs) });

export async function startFakeStt() {
  const def = protoLoader.loadSync('google/cloud/speech/v2/cloud_speech.proto', {
    includeDirs: [join(speechDir, 'build/protos'), join(gaxDir, 'build/protos')],
    keepCase: true,
    enums: String,
    longs: String,
    defaults: false,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(def).google.cloud.speech.v2;
  const received = { first: null, audioMessages: 0, audioBytes: 0, maxChunk: 0, audioBeforeConfig: false };
  const server = new grpc.Server();
  server.addService(proto.Speech.service, {
    StreamingRecognize(call) {
      let sent = false;
      call.on('data', (msg) => {
        if (!received.first) {
          received.first = msg;
          if (msg.audio) received.audioBeforeConfig = true;
          call.write({ speech_event_type: 'SPEECH_ACTIVITY_BEGIN', speech_event_offset: dur(120) });
          return;
        }
        received.audioMessages += 1;
        received.audioBytes += msg.audio?.length ?? 0;
        received.maxChunk = Math.max(received.maxChunk, msg.audio?.length ?? 0);
        if (!sent && received.audioMessages >= 5) {
          sent = true;
          call.write({ results: [interim('今日は', 200)] });
          call.write({ results: [interim('今日は天気', 400)] });
          call.write({ results: [interim('今日は', 400, 0.9), interim('天気が', 600, 0.1)] });
          call.write({ results: [final('今日は天気がいい。', 800)] });
          call.write({ results: [interim('明日は', 1000)] });
        }
      });
      call.on('end', () => {
        call.write({ results: [final('明日は雨。', 1200)] });
        call.end();
      });
    },
  });
  const port = await new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p)));
  });
  return { port, received, stop: () => server.forceShutdown() };
}
