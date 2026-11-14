/**
 * stt、tts、llm、completion の provider.status と、manifest の providers（stt、tts、llm、completion、vap）
 * （session.ts の recordProviders から切り出し。docs/design/two_ai/06 §11、01 §1.3。WP1a）。発話希望の部分は Session に残す。
 */
import { absent, present } from '@llm-vap/contracts';
import type { EventEmitter } from '@llm-vap/contracts';
import type { BaseProviders } from '../../app/providers';
import type { SessionManifestDetails } from '../../logging';
import type { MaaiWorkerClient } from '../../maai';

export type ProvidersManifest = NonNullable<SessionManifestDetails['providers']>;
type ProviderEntry = ProvidersManifest[string];

/**
 * provider.status を stt、tts、llm、completion の順に出す。返す manifest は stt、tts、llm、completion の順の項目と、
 * 別に vap（Session は発話希望の項目を completion と vap の間に入れる。キーの順を今のまま保つため）。
 */
export function recordBaseProviders(
  emitter: EventEmitter,
  providers: BaseProviders,
  fixedReasons: readonly string[],
  maai: { client: MaaiWorkerClient | null; unavailableReason: string | null },
): { providers: ProvidersManifest; vap: ProviderEntry } {
  const manifest: ProvidersManifest = {};
  for (const kind of ['stt', 'tts', 'llm'] as const) {
    const cls = providers.classes[kind];
    const reason = fixedReasons.find((r) => r.startsWith(`${kind}_unavailable:`)) ?? null;
    const provider = providers.names[kind] === 'unavailable' ? `${kind}_unavailable` : providers.names[kind];
    manifest[kind] = { provider, provider_class: reason === null ? cls : 'unavailable', reason };
    emitter.emit({
      event: 'provider.status',
      provider,
      provider_class: cls === 'unavailable' ? providers.requested[kind] : cls,
      status: reason === null ? 'ok' : 'down',
      reason: reason === null ? absent('opened_at_session_start') : present(reason.slice(0, 300)),
      retry_attempt: 0,
      next_retry_ms: absent(reason === null ? 'not_retrying' : 'not_retried_in_this_session'),
    });
  }
  const completion = providers.completion_name;
  manifest.completion = {
    provider: completion,
    provider_class: providers.completion_error === null ? 'production' : 'unavailable',
    reason: providers.completion_error,
  };
  emitter.emit({
    event: 'provider.status',
    provider: `completion:${completion}`,
    provider_class: providers.classes.llm === 'test_double' && completion === 'llm_completion_v1' ? 'test_double' : 'production',
    status: providers.completion_error === null ? 'ok' : 'down',
    reason: providers.completion_error === null ? absent('created_at_session_start') : present(providers.completion_error.slice(0, 300)),
    retry_attempt: 0,
    next_retry_ms: absent('not_retrying'),
  });
  const vap: ProviderEntry = {
    provider: 'maai_worker',
    provider_class: maai.client === null ? 'unavailable' : maai.client.providerClass,
    reason: maai.client === null ? (maai.unavailableReason ?? 'maai_disabled') : null,
  };
  return { providers: manifest, vap };
}
