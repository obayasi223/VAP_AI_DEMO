/** 偽の音声。決定的なトーンで、音量に依存する処理（口形など）の確認に使える。 */
export function toneSamples(count: number, sampleRateHz: number, frequencyHz = 220, amplitude = 8000): Int16Array {
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRateHz));
  }
  return out;
}
