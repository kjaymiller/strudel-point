// Auto beat-slicing for the pads app's drop-to-add-a-bank flow. A trimmed-down,
// non-interactive copy of apps/web/src/audio/{analyze,wav}.ts's onset/tempo detection +
// WAV slicing (same copy apps/dj/src/audio/beatcut.ts already carries) — that app lets a
// human drag cut markers before uploading, this one just takes the best guess and uploads
// every slice straight away, so only the pieces needed for "guess cycle count + cut
// points, then cut" are duplicated here. See apps/dj/src/audio.ts for why these apps each
// keep their own copy rather than importing across app boundaries.

const BEATS_PER_CYCLE = 4;
const ONSET_HOP = 512;
const MIN_BPM = 60;
const MAX_BPM = 200;
const PEAK_BUCKETS = 600;

export interface WaveformPeaks {
  min: Float32Array;
  max: Float32Array;
}

export interface BeatCut {
  duration: number;
  bpm: number;
  cycles: number;
  /** Interior cut points (seconds), one less than `cycles`. */
  cuts: number[];
  /** Whole-loop waveform, for drawing the editor's overview canvas. */
  peaks: WaveformPeaks;
}

export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
  const ctx = new Ctor();
  try {
    return await ctx.decodeAudioData(await file.arrayBuffer());
  } finally {
    ctx.close();
  }
}

function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

/** Half-wave-rectified derivative of frame RMS — a cheap stand-in for spectral flux, plenty
 * good at finding transients (drum hits) in a percussive loop. */
function onsetEnvelope(data: Float32Array, sampleRate: number, hop = ONSET_HOP) {
  const frames = Math.floor(data.length / hop);
  const energy = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    const start = i * hop;
    const end = Math.min(data.length, start + hop);
    for (let j = start; j < end; j++) sum += data[j] * data[j];
    energy[i] = Math.sqrt(sum / hop);
  }
  const onset = new Float32Array(frames);
  for (let i = 1; i < frames; i++) onset[i] = Math.max(0, energy[i] - energy[i - 1]);
  const frameRate = sampleRate / hop;
  return { onset, frameRate };
}

function computePeaks(data: Float32Array, buckets = PEAK_BUCKETS): WaveformPeaks {
  const bucketSize = Math.max(1, Math.floor(data.length / buckets));
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  for (let i = 0; i < buckets; i++) {
    let lo = 0;
    let hi = 0;
    const start = i * bucketSize;
    const end = Math.min(data.length, start + bucketSize);
    for (let j = start; j < end; j++) {
      const v = data[j];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[i] = lo;
    max[i] = hi;
  }
  return { min, max };
}

/** Autocorrelation of the onset envelope over the 60-200bpm lag range — simple, no FFT needed. */
function detectBpm(onset: Float32Array, frameRate: number): number {
  const minLag = Math.max(1, Math.round((60 / MAX_BPM) * frameRate));
  const maxLag = Math.round((60 / MIN_BPM) * frameRate);
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < onset.length; lag++) {
    let score = 0;
    for (let i = lag; i < onset.length; i++) score += onset[i] * onset[i - lag];
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return (60 * frameRate) / bestLag;
}

/** For `cycles` even divisions of the loop, snap each expected boundary to the strongest
 * nearby onset instead of a blind grid — a real transient beats a guessed one. */
function suggestCuts(onset: Float32Array, frameRate: number, duration: number, cycles: number): number[] {
  if (cycles <= 1) return [];
  const step = duration / cycles;
  const windowFrames = Math.max(1, Math.round(step * 0.25 * frameRate));
  const cuts: number[] = [];
  for (let i = 1; i < cycles; i++) {
    const centerFrame = Math.round(i * step * frameRate);
    let bestFrame = centerFrame;
    let bestVal = -Infinity;
    const lo = Math.max(0, centerFrame - windowFrames);
    const hi = Math.min(onset.length - 1, centerFrame + windowFrames);
    for (let f = lo; f <= hi; f++) {
      if (onset[f] > bestVal) {
        bestVal = onset[f];
        bestFrame = f;
      }
    }
    cuts.push(bestFrame / frameRate);
  }
  return cuts;
}

/** Best guess at tempo + cycle count + interior cut points for a dropped loop — same
 * heuristic apps/web/src/audio/analyze.ts's BeatAnalyzer starts from, just taken as-is
 * instead of being offered up for a human to drag. */
export function analyzeBeatCuts(buffer: AudioBuffer): BeatCut {
  const data = toMono(buffer);
  const duration = buffer.duration;
  const peaks = computePeaks(data);
  const { onset, frameRate } = onsetEnvelope(data, buffer.sampleRate);
  const bpm = detectBpm(onset, frameRate);
  const cyclesFloat = (duration * bpm) / 60 / BEATS_PER_CYCLE;
  const cycles = Math.max(1, Math.round(cyclesFloat));
  const cuts = suggestCuts(onset, frameRate, duration, cycles);
  return { duration, bpm, cycles, cuts, peaks };
}

/** Re-run just the cut suggestion for a user-edited cycle count, keeping the same tempo
 * guess — used when someone corrects a wrong auto-detected cycle count. */
export function recomputeCuts(buffer: AudioBuffer, cycles: number): number[] {
  const data = toMono(buffer);
  const { onset, frameRate } = onsetEnvelope(data, buffer.sampleRate);
  return suggestCuts(onset, frameRate, buffer.duration, Math.max(1, cycles));
}

/** Boundaries (including 0 and duration) implied by a set of interior cuts. */
export function boundsFromCuts(cuts: number[], duration: number): number[] {
  return [0, ...cuts, duration];
}

/** Copies out the [startSec, endSec) region of `buffer` as a standalone AudioBuffer. */
function sliceAudioBuffer(buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const startFrame = Math.max(0, Math.floor(startSec * buffer.sampleRate));
  const endFrame = Math.min(buffer.length, Math.ceil(endSec * buffer.sampleRate));
  const length = Math.max(1, endFrame - startFrame);
  const out = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length,
    sampleRate: buffer.sampleRate,
  });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.copyToChannel(buffer.getChannelData(c).subarray(startFrame, startFrame + length), c);
  }
  return out;
}

/** Minimal PCM16 WAV encoder — one function, no dependency, good enough for short samples. */
function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const blockAlign = numChannels * 2; // 16-bit
  const dataSize = numFrames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([out], { type: "audio/wav" });
}

/** `sliceAudioBuffer` + `encodeWav`, wrapped as a `File` ready to hand to FormData. */
export function sliceToFile(buffer: AudioBuffer, startSec: number, endSec: number, fileName: string): File {
  const blob = encodeWav(sliceAudioBuffer(buffer, startSec, endSec));
  return new File([blob], fileName, { type: "audio/wav" });
}
