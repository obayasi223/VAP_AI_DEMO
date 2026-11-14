/**
 * manifest の直列の書き込みと、会話の音声の保存の開始（session.ts の describeWithAudio と startAudioRecording から切り出し。
 * docs/design/two_ai/06 §11、01 §1.3。WP1a）。
 */
import { absent, present } from '@llm-vap/contracts';
import type { EventEmitter } from '@llm-vap/contracts';
import { SessionAudioRecorder } from '../../logging';
import type { SessionAudioFileSystem, SessionAudioManifest, SessionAudioOptions, SessionLog, SessionManifestDetails } from '../../logging';
import type { SessionAudioConfig } from '../../app/config';

export type SessionAudioSetting = SessionAudioConfig & { dir?: string; fs?: SessionAudioFileSystem; recorder?: Partial<SessionAudioOptions> };

export class ManifestWriter {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: { log: SessionLog }) {}

  /**
   * 書き込みは同じ一時ファイルを使うので順番に。開始直後の avatar.report と重なると rename が失敗する。
   * details は書く時点の値を関数で受ける（キューの前の書き込みが終わってから読む。session.ts と同じ）。
   */
  describe(details: () => SessionManifestDetails | null, audio: () => SessionAudioManifest, avatar: () => SessionManifestDetails['avatar']): Promise<boolean> {
    if (details() === null) return Promise.resolve(false);
    const write = this.chain.then(() => {
      const current = details();
      if (current === null) return false;
      const full: SessionManifestDetails & { session_audio: SessionAudioManifest } = { ...current, session_audio: audio(), avatar: avatar() };
      return this.deps.log.describe(full);
    });
    this.chain = write.catch(() => false);
    return write;
  }
}

/** 設定があるときだけ音声の保存を始める。起動ログに保存の有無を必ず出す。 */
export function startSessionAudio(setting: SessionAudioSetting, ids: { session_id: string; dir: string; emitter: EventEmitter }): SessionAudioRecorder | null {
  if (!setting.enabled) {
    console.log(`[session ${ids.session_id}] session audio: not saved (SAVE_SESSION_AUDIO is not set)`);
    return null;
  }
  const dir = setting.dir ?? ids.dir;
  console.log(`[session ${ids.session_id}] session audio: SAVING mic and AI audio to ${dir} (SAVE_SESSION_AUDIO=1; others' voices need a consent procedure first)`);
  return new SessionAudioRecorder({
    ...setting.recorder,
    dir,
    session_id: ids.session_id,
    minFreeBytes: setting.min_free_bytes,
    ...(setting.fs ? { fs: setting.fs } : {}),
    onProblem: (problem) => {
      console.error(`[session ${ids.session_id}] session audio: ${problem.kind}: ${problem.message}`);
      ids.emitter.emit({
        event: 'provider.status',
        provider: 'session_audio',
        provider_class: 'production',
        status: 'degraded',
        reason: present(`${problem.kind}: ${problem.message}`.slice(0, 300)),
        retry_attempt: 0,
        next_retry_ms: absent('not_retrying'),
      });
    },
  });
}
