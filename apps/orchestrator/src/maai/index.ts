/**
 * Node 側の MaAI ワーカー。J の入口:
 *
 *   const config = loadMaaiSessionConfig();
 *   const client = new MaaiWorkerClient({
 *     launch: realMaaiLaunch(),
 *     configure: buildMaaiConfigure(config, policy.vap),
 *     time,
 *   });
 *   attachMaaiEventBridge(client, { emitter, clock: new WorkerClockRecorder(emitter), systemChannelSource: 'written' });
 *   client.subscribe({ onVapState: (state) => turnManager.onVap(state), onAvailability: ... });
 *   const availability = await client.start(sessionId); // 失敗でも reject しない
 *   // Browser の AUDIO 枠: client.sendEncodedAudio(bytes, sampleCount)
 *   await client.stop('session_end');
 */
export * from './client';
export * from './config';
export * from './event_bridge';
