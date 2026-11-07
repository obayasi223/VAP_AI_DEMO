// Google STT v2 streaming helpers.
//
// Do not use client.streamingRecognize() from @google-cloud/speech for v2. The helper in
// build/src/helpers.js (checked on 8.2.1) writes {streamingConfig} without `recognizer` and wraps
// audio as {audioContent}, which are v1 names. The v2 proto needs `recognizer` plus
// `streaming_config` first and then `audio`, so this file calls _streamingRecognize() directly.
import { distribution } from './common.mjs';

export const BYTES_PER_MS = 32; // LINEAR16, 16 kHz, mono

export async function makeClient(location) {
  const { v2 } = await import('@google-cloud/speech');
  const options = { apiEndpoint: location === 'global' ? 'speech.googleapis.com' : `${location}-speech.googleapis.com` };
  if (process.env.STT_PROBE_TEST_ENDPOINT) {
    // Used only by test/fake_stt_server.mjs.
    const grpc = (await import('google-gax')).grpc;
    const [host, port] = process.env.STT_PROBE_TEST_ENDPOINT.split(':');
    Object.assign(options, {
      apiEndpoint: host,
      port: Number(port),
      sslCreds: grpc.credentials.createInsecure(),
      // Inline dummy so the auth library does not go looking for real credentials on this machine.
      projectId: 'test',
      credentials: { client_email: 'test@example.invalid', private_key: 'unused' },
    });
  }
  return new v2.SpeechClient(options);
}

export function recognitionConfig({ model, language, wordOffsets }) {
  return {
    explicitDecodingConfig: { encoding: 'LINEAR16', sampleRateHertz: 16000, audioChannelCount: 1 },
    languageCodes: [language],
    model,
    features: { enableWordTimeOffsets: Boolean(wordOffsets), enableAutomaticPunctuation: true },
  };
}

export function openStream(client, cfg) {
  const stream = client._streamingRecognize();
  stream.write({
    recognizer: `projects/${cfg.project}/locations/${cfg.location}/recognizers/_`,
    streamingConfig: {
      config: recognitionConfig(cfg),
      streamingFeatures: {
        interimResults: cfg.interim !== false,
        enableVoiceActivityEvents: true,
        ...(cfg.endpointing ? { endpointingSensitivity: cfg.endpointing } : {}),
      },
    },
  });
  return stream;
}

export function durationMs(d) {
  if (!d) return null;
  const ms = Number(d.seconds ?? 0) * 1000 + Number(d.nanos ?? 0) / 1e6;
  return Math.round(ms * 10) / 10;
}

/** Flattens a response. Keeps stability: 0 as is, because 0 is the proto's "not set" sentinel. */
export function normalizeResponse(res, receivedAtMs, audioSentMs) {
  return {
    received_ms: receivedAtMs,
    audio_sent_ms: audioSentMs,
    speech_event: res.speechEventType && res.speechEventType !== 'SPEECH_EVENT_TYPE_UNSPECIFIED' ? res.speechEventType : null,
    speech_event_offset_ms: durationMs(res.speechEventOffset),
    metadata_total_billed_ms: durationMs(res.metadata?.totalBilledDuration),
    results: (res.results ?? []).map((r) => ({
      text: r.alternatives?.[0]?.transcript ?? '',
      is_final: Boolean(r.isFinal),
      stability: r.stability ?? null,
      end_ms: durationMs(r.resultEndOffset),
      confidence: r.alternatives?.[0]?.confidence ?? null,
      words: (r.alternatives?.[0]?.words ?? []).map((w) => ({
        word: w.word,
        start_ms: durationMs(w.startOffset),
        end_ms: durationMs(w.endOffset),
      })),
    })),
  };
}

export const normalizeText = (s) => s.replace(/[\s、。，．,.!?！？「」]/g, '');

/** Answers the plan's open questions from a list of normalizeResponse() outputs. */
export function summarize(responses, { boundaryMs = null } = {}) {
  const withResults = responses.filter((r) => r.results.length > 0);
  const interim = withResults.filter((r) => r.results.some((x) => !x.is_final));
  const flatInterim = interim.flatMap((r) => r.results.filter((x) => !x.is_final));
  const flatFinal = withResults.flatMap((r) => r.results.filter((x) => x.is_final));

  const gaps = interim.slice(1).map((r, i) => r.received_ms - interim[i].received_ms);
  const lag = flatInterim.length === 0 ? [] : interim
    .map((r) => {
      const ends = r.results.filter((x) => !x.is_final).map((x) => x.end_ms).filter((x) => x !== null);
      return ends.length ? r.audio_sent_ms - Math.max(...ends) : null;
    })
    .filter((x) => x !== null);
  const finalLag = withResults
    .filter((r) => r.results.some((x) => x.is_final && x.end_ms !== null))
    .map((r) => r.audio_sent_ms - r.results.find((x) => x.is_final).end_ms);

  // Text of one response = final part + every interim part, per the v2 proto.
  let extended = 0;
  let rewritten = 0;
  let previous = null;
  let resetsAfterFinal = 0;
  let finalsSeen = 0;
  for (const r of withResults) {
    const interimText = normalizeText(r.results.filter((x) => !x.is_final).map((x) => x.text).join(''));
    if (r.results.some((x) => x.is_final)) {
      finalsSeen += 1;
      previous = { text: interimText, afterFinal: true };
      continue;
    }
    if (previous?.afterFinal && interimText && previous.text === '') resetsAfterFinal += 1;
    if (previous && !previous.afterFinal) {
      if (interimText.startsWith(previous.text)) extended += 1;
      else rewritten += 1;
    }
    previous = { text: interimText, afterFinal: false };
  }

  const stabilities = flatInterim.map((x) => x.stability);
  const set = stabilities.filter((x) => x !== null && x > 0);
  const summary = {
    responses: responses.length,
    interim_responses: interim.length,
    interim_results: flatInterim.length,
    final_results: flatFinal.length,
    interim_available: flatInterim.length > 0,
    stability: {
      returned: set.length > 0,
      share_set: flatInterim.length ? set.length / flatInterim.length : null,
      distinct_values: [...new Set(set.map((x) => Math.round(x * 100) / 100))].slice(0, 20),
    },
    multi_result_responses: interim.filter((r) => r.results.filter((x) => !x.is_final).length > 1).length,
    result_end_offset: {
      on_interim_share: flatInterim.length ? flatInterim.filter((x) => x.end_ms !== null && x.end_ms > 0).length / flatInterim.length : null,
      on_final_share: flatFinal.length ? flatFinal.filter((x) => x.end_ms !== null && x.end_ms > 0).length / flatFinal.length : null,
    },
    words: {
      interim_with_words: flatInterim.filter((x) => x.words.length > 0).length,
      final_with_words: flatFinal.filter((x) => x.words.length > 0).length,
      sample_final_words: flatFinal.find((x) => x.words.length > 0)?.words.slice(0, 10) ?? [],
    },
    interim_gap_ms: distribution(gaps),
    interim_lag_behind_audio_ms: distribution(lag),
    final_lag_behind_audio_ms: distribution(finalLag),
    revision_behaviour: { extended_prefix: extended, rewritten, empty_interim_after_final: resetsAfterFinal, finals_seen: finalsSeen },
    final_lengths_chars: flatFinal.map((x) => normalizeText(x.text).length),
    speech_events: responses.filter((r) => r.speech_event).map((r) => ({
      type: r.speech_event,
      offset_ms: r.speech_event_offset_ms,
      received_ms: r.received_ms,
    })),
    billed_ms_reported: responses.map((r) => r.metadata_total_billed_ms).filter((x) => x !== null).at(-1) ?? null,
  };
  if (boundaryMs !== null) summary.segment_boundary = boundaryAnalysis(withResults, boundaryMs);
  return summary;
}

/** What each candidate rule from plan 4.1 would do at a boundary (the moment the AI starts speaking). */
export function boundaryAnalysis(withResults, boundaryMs) {
  let snapshot = '';
  let snapshotEnd = null;
  for (const r of withResults) {
    const interims = r.results.filter((x) => !x.is_final);
    if (interims.length === 0) continue;
    const end = Math.max(...interims.map((x) => x.end_ms ?? -1));
    if (end >= 0 && end <= boundaryMs) {
      snapshot = normalizeText(interims.map((x) => x.text).join(''));
      snapshotEnd = end;
    }
  }
  const straddling = withResults
    .flatMap((r) => r.results.filter((x) => x.is_final))
    .find((x) => x.end_ms !== null && x.end_ms > boundaryMs);
  const finalText = straddling ? normalizeText(straddling.text) : null;
  return {
    boundary_ms: boundaryMs,
    snapshot_text: snapshot,
    snapshot_end_ms: snapshotEnd,
    precision_ms: snapshotEnd === null ? null : boundaryMs - snapshotEnd,
    straddling_final: finalText,
    final_starts_with_snapshot: finalText === null ? null : finalText.startsWith(snapshot),
  };
}

/** Longest suffix of `previous` that is a prefix of `next`, on normalized text. For stitching streams. */
export function suffixPrefixOverlap(previous, next) {
  const a = normalizeText(previous);
  const b = normalizeText(next);
  for (let n = Math.min(a.length, b.length); n > 0; n--) {
    if (a.endsWith(b.slice(0, n))) return n;
  }
  return 0;
}

/** Sends PCM at real time, correcting for timer drift. Stops early if shouldStop() returns true. */
export async function pacedSend(pcm, chunkMs, send, { speed = 1, shouldStop = () => false, startAt = 0 } = {}) {
  const chunkBytes = chunkMs * BYTES_PER_MS;
  const begin = performance.now();
  let sentBytes = 0;
  for (let pos = startAt; pos < pcm.length; pos += chunkBytes) {
    if (shouldStop()) break;
    const chunk = pcm.subarray(pos, Math.min(pos + chunkBytes, pcm.length));
    send(chunk);
    sentBytes += chunk.length;
    const due = begin + ((sentBytes / BYTES_PER_MS) / speed);
    const wait = due - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return sentBytes;
}
