// ElevenLabs WebSocket helpers. The key goes in a header, never in the URL.
import WebSocket from 'ws';

export const TEST_TEXT = '本日の会議は午後3時に東京駅の近くで始まります。新しい企画について、皆さんのご意見を伺いたいと思います。';

export function wsUrl(path, voiceId, query) {
  const base = process.env.ELEVENLABS_TEST_BASE ?? 'wss://api.elevenlabs.io';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) params.set(k, String(v));
  return `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}/${path}?${params}`;
}

export function connect(url) {
  const begin = performance.now();
  const ws = new WebSocket(url, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
  const info = { connect_ms: null, region: null, rejected: null };
  ws.on('upgrade', (res) => {
    info.region = res.headers['x-region'] ?? null;
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', () => {
      info.connect_ms = performance.now() - begin;
      resolve();
    });
    ws.once('unexpected-response', (_req, res) => {
      info.rejected = res.statusCode;
      reject(new Error(`WebSocket の接続が拒否されました: HTTP ${res.statusCode}`));
    });
    ws.once('error', reject);
  });
  return { ws, info, opened };
}

/** Whichever casing the server uses (stream-input is camelCase; Text to Dialogue is snake_case). */
export function readAlignment(a) {
  if (!a) return null;
  return {
    chars: a.chars ?? [],
    starts: a.charStartTimesMs ?? a.char_start_times_ms ?? [],
    durations: a.charDurationsMs ?? a.char_durations_ms ?? [],
  };
}

/** Unit, chunk-relative timing, and text fidelity, for the Japanese questions in plan 4.3. */
export function analyzeAlignment(messages, inputText, pcmBytes, sampleRate) {
  const raw = messages.map((m) => readAlignment(m.alignment)).filter(Boolean);
  const norm = messages.map((m) => readAlignment(m.normalizedAlignment ?? m.normalized_alignment)).filter(Boolean);
  const describe = (list) => {
    if (list.length === 0) return { present: false };
    const chars = list.flatMap((a) => a.chars);
    const lengths = chars.map((c) => [...c].length);
    const firstStarts = list.map((a) => a.starts[0]).filter((x) => x !== undefined);
    return {
      present: true,
      chunks: list.length,
      chars_joined: chars.join(''),
      matches_input: chars.join('').replace(/\s/g, '') === inputText.replace(/\s/g, ''),
      max_codepoints_per_entry: Math.max(0, ...lengths),
      first_start_per_chunk_ms: firstStarts.slice(0, 12),
      looks_chunk_relative: firstStarts.slice(1).some((x, i) => x <= firstStarts[i]),
      sum_durations_ms: list.flatMap((a) => a.durations).reduce((s, x) => s + x, 0),
    };
  };
  const audioMs = sampleRate ? (pcmBytes / 2 / sampleRate) * 1000 : null;
  const report = { raw: describe(raw), normalized: describe(norm), audio_ms_at_requested_rate: audioMs };
  const reference = report.normalized.present ? report.normalized : report.raw;
  if (reference.present && audioMs) report.audio_ms_over_alignment_ms = audioMs / reference.sum_durations_ms;
  return report;
}

export async function subscriptionCharacters() {
  const base = process.env.ELEVENLABS_TEST_HTTP_BASE ?? 'https://api.elevenlabs.io';
  const res = await fetch(`${base}/v1/user/subscription`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const json = await res.json();
  return { character_count: json.character_count, character_limit: json.character_limit, tier: json.tier };
}
