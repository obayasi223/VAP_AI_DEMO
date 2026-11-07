import { CONTRACTS_VERSION, SAMPLE_RATE_HZ } from '@llm-vap/contracts';

/** レーン F の雛形。参加者画面の本体はレーン J がこのファイルを置き換える。 */
export default function ParticipantPlaceholder() {
  return (
    <main>
      <h1>雛形（未配線）</h1>
      <p>
        contracts v{CONTRACTS_VERSION} / {SAMPLE_RATE_HZ} Hz
      </p>
    </main>
  );
}
