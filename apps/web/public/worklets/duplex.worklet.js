// 生成物。編集しない。元は apps/web/src/audio/（npm run build:audio）。

// src/audio/dsp/resampler.ts
var DEFAULT_STOPBAND_DB = 80;
function gcd(a, b) {
  let x = a;
  let y = b;
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}
function besselI0(x) {
  let sum = 1;
  let term = 1;
  const q = x * x / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}
function kaiserBeta(stopbandDb) {
  if (stopbandDb > 50) return 0.1102 * (stopbandDb - 8.7);
  if (stopbandDb >= 21) return 0.5842 * (stopbandDb - 21) ** 0.4 + 0.07886 * (stopbandDb - 21);
  return 0;
}
function designResampler(inRate, outRate, options = {}) {
  if (!Number.isInteger(inRate) || !Number.isInteger(outRate) || inRate <= 0 || outRate <= 0) {
    throw new Error(`rates must be positive integers: ${inRate} -> ${outRate}`);
  }
  const stopbandDb = options.stopbandDb ?? DEFAULT_STOPBAND_DB;
  const nyquist = Math.min(inRate, outRate) / 2;
  if (inRate === outRate) {
    return {
      inRate,
      outRate,
      L: 1,
      M: 1,
      K: 1,
      N: 1,
      table: Float64Array.of(1),
      skipOutputs: 0,
      delayMs: 0,
      stopbandDb,
      passbandEdgeHz: nyquist,
      stopbandEdgeHz: nyquist
    };
  }
  const g = gcd(inRate, outRate);
  const L = outRate / g;
  const M = inRate / g;
  const base = inRate * L;
  const transition = options.transitionHz ?? nyquist / 8;
  const stopEdge = nyquist;
  const passEdge = nyquist - transition;
  const cutoff = (passEdge + stopEdge) / 2;
  const dw = 2 * Math.PI * transition / base;
  const minTaps = Math.ceil((stopbandDb - 7.95) / (2.285 * dw)) + 1;
  const r = Math.ceil((minTaps - 1) / (2 * M));
  const N = 2 * r * M + 1;
  const D = r * M;
  const beta = kaiserBeta(stopbandDb);
  const i0beta = besselI0(beta);
  const fc = 2 * cutoff / base;
  const h = new Float64Array(N);
  let sum = 0;
  for (let n = 0; n < N; n++) {
    const x = n - D;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * fc * x) / (Math.PI * fc * x);
    const ratio = x / D;
    const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / i0beta;
    const value = fc * sinc * window;
    h[n] = value;
    sum += value;
  }
  const scale = L / sum;
  const K = Math.ceil(N / L);
  const table = new Float64Array(L * K);
  for (let phase = 0; phase < L; phase++) {
    for (let j = 0; j < K; j++) {
      const index = phase + j * L;
      table[phase * K + j] = index < N ? h[index] * scale : 0;
    }
  }
  return {
    inRate,
    outRate,
    L,
    M,
    K,
    N,
    table,
    skipOutputs: r,
    delayMs: r * 1e3 / outRate,
    stopbandDb,
    passbandEdgeHz: passEdge,
    stopbandEdgeHz: stopEdge
  };
}
var PolyphaseResampler = class {
  constructor(design) {
    this.design = design;
    this.history = new Float64Array(design.K * 2);
    this.toSkip = design.skipOutputs;
  }
  design;
  history;
  pos = 0;
  /** 次の出力の基準レート上の時刻を、現在の入力サンプルからの差で持つ。 */
  rel = 0;
  toSkip;
  inputCount = 0;
  emitted = 0;
  /** input の長さ n に対する出力の上限。 */
  maxOutput(n) {
    return Math.ceil(n * this.design.L / this.design.M) + 1;
  }
  /** 入力を消費し、output の outOffset から書く。書いた個数を返す。実行中に確保しない。 */
  process(input, inputOffset, inputLength, output, outputOffset) {
    const { K, L, M, table } = this.design;
    const history = this.history;
    let written = 0;
    let pos = this.pos;
    let rel = this.rel;
    for (let i = 0; i < inputLength; i++) {
      pos = pos === 0 ? K - 1 : pos - 1;
      const x = input[inputOffset + i];
      history[pos] = x;
      history[pos + K] = x;
      while (rel < L) {
        if (this.toSkip > 0) {
          this.toSkip--;
        } else {
          const start = rel * K;
          let acc = 0;
          for (let j = 0; j < K; j++) {
            acc += table[start + j] * history[pos + j];
          }
          output[outputOffset + written] = acc;
          written++;
        }
        rel += M;
      }
      rel -= L;
    }
    this.pos = pos;
    this.rel = rel;
    this.inputCount += inputLength;
    this.emitted += written;
    return written;
  }
  /**
   * ストリームの終端。先読みで残った分をゼロ入力で押し出す。
   * 全出力の個数は ceil(入力数*L/M) になる。
   */
  flush() {
    const { L, M, K, skipOutputs } = this.design;
    const expected = Math.ceil(this.inputCount * L / M);
    const missing = expected - this.emitted;
    if (missing <= 0) return new Float32Array(0);
    const zerosNeeded = Math.ceil((skipOutputs + 1) * M / L) + K;
    const zeros = new Float32Array(zerosNeeded);
    const out = new Float32Array(this.maxOutput(zerosNeeded));
    const count = this.process(zeros, 0, zerosNeeded, out, 0);
    return out.subarray(0, Math.min(count, missing));
  }
};

// src/audio/dsp/capture.ts
function floatToInt16(x) {
  const v = Math.round(x * 32768);
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v;
}
var DuplexCapture = class {
  constructor(design, frameSamples) {
    this.frameSamples = frameSamples;
    this.micResampler = new PolyphaseResampler(design);
    this.sysResampler = new PolyphaseResampler(design);
    const capacity = this.micResampler.maxOutput(1024);
    this.micOut = new Float32Array(capacity);
    this.sysOut = new Float32Array(capacity);
    this.micFrame = new Int16Array(frameSamples);
    this.sysFrame = new Int16Array(frameSamples);
  }
  frameSamples;
  micResampler;
  sysResampler;
  micOut;
  sysOut;
  micFrame;
  sysFrame;
  fill = 0;
  nextAudioFrame = 0;
  /** 同じレンダー量子の mic と、出力へ書いたサンプル（sys）を渡す。 */
  push(mic, sys, length, onFrame) {
    if (this.micResampler.maxOutput(length) > this.micOut.length) {
      this.micOut = new Float32Array(this.micResampler.maxOutput(length));
      this.sysOut = new Float32Array(this.micResampler.maxOutput(length));
    }
    const count = this.micResampler.process(mic, 0, length, this.micOut, 0);
    const sysCount = this.sysResampler.process(sys, 0, length, this.sysOut, 0);
    if (count !== sysCount) throw new Error(`channel skew in resampler: ${count} != ${sysCount}`);
    for (let i = 0; i < count; i++) {
      this.micFrame[this.fill] = floatToInt16(this.micOut[i]);
      this.sysFrame[this.fill] = floatToInt16(this.sysOut[i]);
      this.fill++;
      if (this.fill === this.frameSamples) {
        onFrame(this.nextAudioFrame, this.micFrame, this.sysFrame);
        this.nextAudioFrame += this.frameSamples;
        this.fill = 0;
        this.micFrame = new Int16Array(this.frameSamples);
        this.sysFrame = new Int16Array(this.frameSamples);
      }
    }
  }
};

// src/audio/dsp/playback_scheduler.ts
var PlaybackScheduler = class {
  queue = [];
  generation = 0;
  renderEnd = 0;
  rate;
  prebufferFrames;
  onEvent;
  underrunCount = 0;
  underrunFrames = 0;
  /** 世代が古くて棄てた PCM チャンク数。 */
  staleChunks = 0;
  /** 世代が古くて無視した begin と stop の数。 */
  staleControl = 0;
  /** begin がない、または終わった再生へ届いた PCM チャンク数。 */
  orphanChunks = 0;
  constructor(options) {
    this.rate = options.contextRate;
    this.prebufferFrames = options.prebufferFrames;
    this.onEvent = options.onEvent;
  }
  get currentGeneration() {
    return this.generation;
  }
  begin(id, gen) {
    if (gen < this.generation) {
      this.staleControl++;
      return;
    }
    this.advance(gen);
    this.queue.push({
      id,
      gen,
      state: "buffering",
      chunks: [],
      chunkOffset: 0,
      buffered: 0,
      written: 0,
      eos: false,
      truncated: false,
      stopRequested: false,
      stopAtFrames: null,
      stopDeadlineFrame: null,
      fadeFrames: 0,
      fadeLeft: 0,
      fadeTotal: 0
    });
  }
  pcm(id, gen, frames, eos) {
    if (gen < this.generation) {
      this.staleChunks++;
      return;
    }
    this.advance(gen);
    const p = this.queue.find((q) => q.id === id && q.gen === gen && !q.stopRequested);
    if (!p || p.eos) {
      this.orphanChunks++;
      return;
    }
    if (frames.length > 0) {
      p.chunks.push(frames);
      p.buffered += frames.length;
    }
    if (eos) p.eos = true;
  }
  stop(id, gen, mode) {
    if (gen < this.generation) {
      this.staleControl++;
      return;
    }
    this.generation = gen;
    for (const p of [...this.queue]) {
      const isHead = p === this.queue[0];
      const isTarget = p.id === id;
      if (isTarget && isHead && p.written > 0 && mode.mode !== "immediate") {
        this.applyGentleStop(p, mode);
      } else if (isTarget || p.gen < gen) {
        this.discard(p, "stopped");
      }
    }
  }
  /** WS が切れた。届いている分を流したら error で終わる。 */
  inputLost() {
    for (const p of this.queue) {
      if (!p.eos) {
        p.eos = true;
        p.truncated = true;
      }
    }
  }
  /** セッションが変わった。すべて棄てて世代を初期化する。 */
  reset() {
    for (const p of [...this.queue]) this.discard(p, "error");
    this.generation = 0;
  }
  /** いま声を流している再生の位置。まだ始まっていなければ null。 */
  position() {
    const p = this.queue[0];
    if (!p || p.written === 0) return null;
    return { id: p.id, gen: p.gen, writtenFrames: p.written, bufferedFrames: p.buffered };
  }
  render(out, n, renderFrame) {
    this.renderEnd = renderFrame + n;
    let i = 0;
    while (i < n) {
      const p = this.queue[0];
      if (!p) {
        out.fill(0, i, n);
        return;
      }
      if (p.state !== "playing") {
        if (p.buffered >= this.prebufferFrames || p.eos) {
          p.state = "playing";
        } else {
          if (p.state === "underrun") this.underrunFrames += n - i;
          out.fill(0, i, n);
          return;
        }
      }
      const now = renderFrame + i;
      if (p.fadeLeft === 0 && (p.stopAtFrames !== null && p.written >= p.stopAtFrames || p.stopDeadlineFrame !== null && now >= p.stopDeadlineFrame)) {
        p.stopAtFrames = null;
        p.stopDeadlineFrame = null;
        if (p.fadeFrames === 0) {
          this.finish(p, now);
          continue;
        }
        p.fadeTotal = p.fadeFrames;
        p.fadeLeft = p.fadeFrames;
      }
      if (p.buffered === 0) {
        if (p.eos) {
          this.finish(p, now);
        } else {
          p.state = "underrun";
          this.underrunCount++;
        }
        continue;
      }
      i += this.copy(p, out, i, n, now);
      if (p.fadeTotal > 0 && p.fadeLeft === 0) this.finish(p, renderFrame + i);
    }
  }
  copy(p, out, at, n, now) {
    const chunk = p.chunks[0];
    let count = Math.min(n - at, chunk.length - p.chunkOffset);
    if (p.fadeLeft > 0) count = Math.min(count, p.fadeLeft);
    if (p.stopAtFrames !== null) count = Math.min(count, p.stopAtFrames - p.written);
    if (p.stopDeadlineFrame !== null) count = Math.min(count, p.stopDeadlineFrame - now);
    const offset = p.chunkOffset;
    if (p.fadeLeft > 0) {
      for (let k = 0; k < count; k++) {
        out[at + k] = chunk[offset + k] * ((p.fadeLeft - k) / p.fadeTotal);
      }
      p.fadeLeft -= count;
    } else {
      for (let k = 0; k < count; k++) out[at + k] = chunk[offset + k];
    }
    if (p.written === 0 && count > 0) {
      this.onEvent({ kind: "started", id: p.id, gen: p.gen, renderFrame: now });
    }
    p.written += count;
    p.buffered -= count;
    p.chunkOffset += count;
    if (p.chunkOffset === chunk.length) {
      p.chunks.shift();
      p.chunkOffset = 0;
    }
    return count;
  }
  advance(gen) {
    if (gen <= this.generation) return;
    this.generation = gen;
    for (const p of [...this.queue]) {
      if (p.gen < gen && !p.stopRequested) this.discard(p, "stopped");
    }
  }
  applyGentleStop(p, mode) {
    if (mode.mode === "immediate") return;
    if (p.fadeLeft > 0) return;
    p.stopRequested = true;
    p.eos = true;
    const fade = Math.round(mode.fade_ms * this.rate / 1e3);
    p.fadeFrames = fade;
    if (mode.mode === "fade") {
      p.stopAtFrames = 0;
      p.stopDeadlineFrame = null;
    } else {
      p.stopAtFrames = Math.ceil(mode.stop_at_sample * this.rate / 16e3);
      p.stopDeadlineFrame = this.renderEnd + Math.round(mode.deadline_ms * this.rate / 1e3);
    }
  }
  finish(p, renderFrame) {
    const index = this.queue.indexOf(p);
    if (index >= 0) this.queue.splice(index, 1);
    let reason = "completed";
    if (p.stopRequested) reason = "stopped";
    else if (p.truncated) reason = "error";
    this.onEvent({
      kind: "ended",
      id: p.id,
      gen: p.gen,
      reason,
      writtenFrames: p.written,
      discardedFrames: p.buffered,
      renderFrame
    });
  }
  discard(p, reason) {
    const index = this.queue.indexOf(p);
    if (index >= 0) this.queue.splice(index, 1);
    this.onEvent({
      kind: "ended",
      id: p.id,
      gen: p.gen,
      reason: reason === "stopped" && p.written === 0 ? "discarded_before_start" : reason,
      writtenFrames: p.written,
      discardedFrames: p.buffered,
      renderFrame: this.renderEnd
    });
  }
};

// src/audio/duplex.worklet.ts
var AUDIO_FRAME_RATE = 16e3;
var DuplexProcessor = class extends AudioWorkletProcessor {
  link = null;
  capture;
  scheduler;
  captureStartFrame = null;
  silence = new Float32Array(128);
  constructor(options) {
    super();
    const { frameSamples, prebufferMs } = options.processorOptions;
    this.capture = new DuplexCapture(designResampler(sampleRate, AUDIO_FRAME_RATE), frameSamples);
    this.scheduler = new PlaybackScheduler({
      contextRate: sampleRate,
      prebufferFrames: Math.round(prebufferMs * sampleRate / 1e3),
      onEvent: (event) => this.forward(event)
    });
    this.port.onmessage = (event) => {
      const port = event.ports[0];
      if (!port) return;
      this.link = port;
      port.onmessage = (e) => this.onCommand(e.data);
    };
  }
  audioFrameAt(renderFrame) {
    if (this.captureStartFrame === null) return 0;
    const value = (renderFrame - this.captureStartFrame) * AUDIO_FRAME_RATE / sampleRate;
    return Math.max(0, Math.round(value));
  }
  onCommand(message) {
    switch (message.t) {
      case "capture_start":
        if (this.captureStartFrame === null) this.captureStartFrame = currentFrame;
        break;
      case "begin":
        this.scheduler.begin(message.id, message.gen);
        break;
      case "pcm":
        this.scheduler.pcm(message.id, message.gen, message.frames, message.eos);
        break;
      case "stop":
        this.scheduler.stop(message.id, message.gen, message.stop);
        break;
      case "input_lost":
        this.scheduler.inputLost();
        break;
      case "reset":
        this.scheduler.reset();
        break;
    }
  }
  post(message, transfer = []) {
    this.link?.postMessage(message, transfer);
  }
  forward(event) {
    if (event.kind === "started") {
      this.post({
        t: "started",
        id: event.id,
        gen: event.gen,
        render_frame: event.renderFrame,
        audio_frame: this.audioFrameAt(event.renderFrame)
      });
    } else {
      this.post({
        t: "ended",
        id: event.id,
        gen: event.gen,
        reason: event.reason,
        written: event.writtenFrames,
        discarded: event.discardedFrames,
        render_frame: event.renderFrame,
        audio_frame: this.audioFrameAt(event.renderFrame)
      });
    }
  }
  process(inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length;
    const frameNow = currentFrame;
    this.scheduler.render(out, n, frameNow);
    if (this.captureStartFrame !== null) {
      let mic = inputs[0]?.[0];
      if (!mic) {
        if (this.silence.length < n) this.silence = new Float32Array(n);
        mic = this.silence;
      }
      this.capture.push(mic, out, n, (audioFrame, micFrame, sysFrame) => {
        const position = this.scheduler.position();
        const renderEnd = frameNow + n;
        this.post(
          {
            t: "frame",
            audio_frame: audioFrame,
            mic: micFrame,
            sys: sysFrame,
            render_frame: renderEnd,
            head_audio_frame: this.audioFrameAt(renderEnd),
            pos_id: position === null ? 0 : position.id,
            pos_gen: position === null ? 0 : position.gen,
            pos_written: position === null ? 0 : position.writtenFrames,
            pos_buffered: position === null ? 0 : position.bufferedFrames,
            underrun_count: this.scheduler.underrunCount,
            underrun_frames: this.scheduler.underrunFrames,
            stale_chunks: this.scheduler.staleChunks,
            orphan_chunks: this.scheduler.orphanChunks
          },
          [micFrame.buffer, sysFrame.buffer]
        );
      });
    }
    return true;
  }
};
registerProcessor("duplex-audio-processor", DuplexProcessor);
