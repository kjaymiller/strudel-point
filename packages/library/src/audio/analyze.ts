// Client-side analysis for the beat analyzer: decode the file, build a waveform, and take
// a best guess at tempo + cut points — all before anything gets uploaded. Deliberately
// dependency-free (onset detection via frame-energy deltas, tempo via autocorrelation)
// rather than pulling in a DSP library for what's a "good enough starting point, the user
// drags the rest" feature, not a mastering tool.

export interface WaveformPeaks {
  min: Float32Array;
  max: Float32Array;
}

export interface BeatAnalysis {
  duration: number;
  peaks: WaveformPeaks;
  /** Best-guess tempo, assuming 4 beats/cycle (Strudel's usual bar-as-cycle convention). */
  bpm: number;
  /** How many cycles this loop is, at that tempo. Editable — see recomputeCuts(). */
  cycles: number;
  /** Best-guess interior cut points (seconds), one less than `cycles`. */
  cuts: number[];
}

const PEAK_BUCKETS = 600;
const BEATS_PER_CYCLE = 4;
const ONSET_HOP = 512;
const MIN_BPM = 60;
const MAX_BPM = 200;

export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
  const ctx = new Ctor();
  try {
    return await ctx.decodeAudioData(await file.arrayBuffer());
  } finally {
    ctx.close();
  }
}

/**
 * Fetches and decodes an already-uploaded sample's audio (its `/api/samples/:id/audio`
 * URL) through a caller-supplied context — used to pull an existing "my sounds" entry
 * back into the sample editor for re-scrubbing/chopping/merging. Takes the context as a
 * param (rather than spinning up its own, like decodeAudioFile) so multiple sources for a
 * merge all land at the same sample rate.
 */
export async function decodeAudioUrl(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`couldn't fetch audio (${res.status})`);
  return ctx.decodeAudioData(await res.arrayBuffer());
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
export function suggestCuts(
  onset: Float32Array,
  frameRate: number,
  duration: number,
  cycles: number,
): number[] {
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

/** Peaks for just one time range of the buffer — used to draw a per-slice mini waveform for
 * trimming, at a resolution appropriate to a single slice rather than the whole loop. */
export function computeRangePeaks(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
  buckets = 120,
): WaveformPeaks {
  const data = toMono(buffer);
  const startFrame = Math.max(0, Math.floor(startSec * buffer.sampleRate));
  const endFrame = Math.min(data.length, Math.ceil(endSec * buffer.sampleRate));
  return computePeaks(data.subarray(startFrame, Math.max(startFrame + 1, endFrame)), buckets);
}

export function analyzeBeat(buffer: AudioBuffer): BeatAnalysis {
  const data = toMono(buffer);
  const duration = buffer.duration;
  const peaks = computePeaks(data);
  const { onset, frameRate } = onsetEnvelope(data, buffer.sampleRate);
  const bpm = detectBpm(onset, frameRate);
  const cyclesFloat = (duration * bpm) / 60 / BEATS_PER_CYCLE;
  const cycles = Math.max(1, Math.round(cyclesFloat));
  const cuts = suggestCuts(onset, frameRate, duration, cycles);
  return { duration, peaks, bpm, cycles, cuts };
}

/** Re-run just the cut suggestion for a user-edited cycle count, keeping the same tempo guess. */
export function recomputeCuts(buffer: AudioBuffer, cycles: number): number[] {
  const data = toMono(buffer);
  const { onset, frameRate } = onsetEnvelope(data, buffer.sampleRate);
  return suggestCuts(onset, frameRate, buffer.duration, Math.max(1, cycles));
}
