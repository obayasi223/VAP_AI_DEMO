/**
 * STT の入口。J は createGoogleSttProviderFromEnv を呼び、返った SttProvider の open を使う。
 * stt.interim／stt.final／provider.status／cost.usage は emitter を渡せばこの層が発行する（J は再発行しない）。
 * 音声経路を止めないよう、emitter は invalid: 'report' で作る。
 */
import type { EventEmitter, TimeSource } from '@llm-vap/contracts';
import { createGrpcGoogleSttTransport } from './grpc_transport';
import type { GrpcTransportConfig } from './grpc_transport';
import { GoogleSttV2Provider } from './google_v2';
import type { GoogleSttOptions } from './google_v2';

export * from './google_v2';
export * from './assembler';
export * from './frame_map';
export * from './grpc_transport';
export * from './transcript_text';

export interface GoogleSttFromEnv {
  time: TimeSource;
  emitter?: EventEmitter;
  env?: NodeJS.ProcessEnv;
  options?: Partial<GoogleSttOptions>;
  onRaw?: GrpcTransportConfig['onRaw'];
}

/** 足りない環境変数の名前を挙げて失敗する。値は表示しない。 */
export async function createGoogleSttProviderFromEnv(input: GoogleSttFromEnv): Promise<GoogleSttV2Provider> {
  const env = input.env ?? process.env;
  const project = env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT is not set');
  // ADC は明示したときだけ使う（この機械の別の認証を誤って拾わないため）。
  if (!env.GOOGLE_APPLICATION_CREDENTIALS && env.GOOGLE_STT_USE_ADC !== '1') {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set (or set GOOGLE_STT_USE_ADC=1)');
  }
  const location = env.GOOGLE_STT_LOCATION || 'asia-northeast1';
  const model = env.GOOGLE_STT_MODEL || 'long';
  const transport = await createGrpcGoogleSttTransport({
    project,
    location,
    ...(input.onRaw ? { onRaw: input.onRaw } : {}),
  });
  return new GoogleSttV2Provider({
    transport,
    time: input.time,
    model,
    location,
    ...(input.emitter ? { emitter: input.emitter } : {}),
    ...(input.options ? { options: input.options } : {}),
  });
}
