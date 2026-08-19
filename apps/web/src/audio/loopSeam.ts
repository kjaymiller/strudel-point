// Checks whether a sample will click when looped back-to-back — the same thing any looping
// sampler cares about: if the buffer's last frame and its first frame sit far apart in
// amplitude, wrapping the tail straight back to the head produces an audible discontinuity
// (a "pop") right at the seam. This is deliberately independent of the beat-slicer in
// analyze.ts — that guesses *where* to cut a loop into cycles; this judges whether a buffer
// (any registered sound, not just a freshly-cut slice) is already safe to loop as-is.

export interface LoopSeamAnalysis {
  duration: number;
  /** Amplitude (0-1, channels averaged) at the very first and last sample frame. */
  startLevel: number;
  endLevel: number;
  /** |end - start| — the size of the jump a listener would actually hear at the seam when
   * this buffer's tail wraps straight back to its head. */
  seamJump: number;
  /** True if seamJump falls below the audibility threshold — safe to loop as-is. */
  seamless: boolean;
  /** How far in from the tail (seconds) the nearest zero-crossing sits, if the seam isn't
   * already clean — trimming the buffer to end there removes the click. `null` if the seam
   * is already seamless, or no crossing turned up within the search window. */
  trimToZeroCrossing: number | null;
}

// ~-34dBFS: a discontinuity this small is effectively inaudible against typical sample
// levels, so there's no point chasing a perfect zero jump.
const SEAMLESS_THRESHOLD = 0.02;
// How far in from the tail to look for a clean cut point before giving up.
const ZERO_CROSSING_SEARCH_SECONDS = 0.05;

function frameAt(buffer: AudioBuffer, index: number): number {
  let sum = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) sum += buffer.getChannelData(c)[index];
  return sum / buffer.numberOfChannels;
}

/** Nearest zero-crossing to the tail, searched backwards frame by frame — mirrors how
 * suggestCuts() in analyze.ts snaps to transients, but here we're snapping to silence
 * instead of a hit. */
function findTrailingZeroCrossing(buffer: AudioBuffer): number | null {
  const last = buffer.length - 1;
  const searchFrames = Math.min(last, Math.round(ZERO_CROSSING_SEARCH_SECONDS * buffer.sampleRate));
  for (let i = 0; i < searchFrames; i++) {
    const a = frameAt(buffer, last - i);
    const b = frameAt(buffer, Math.max(0, last - i - 1));
    if ((a >= 0 && b < 0) || (a <= 0 && b > 0)) return i / buffer.sampleRate;
  }
  return null;
}

export function analyzeLoopSeam(buffer: AudioBuffer): LoopSeamAnalysis {
  const last = buffer.length - 1;
  const startFrame = frameAt(buffer, 0);
  const endFrame = frameAt(buffer, last);
  const seamJump = Math.abs(endFrame - startFrame);
  const seamless = seamJump <= SEAMLESS_THRESHOLD;

  return {
    duration: buffer.duration,
    startLevel: Math.abs(startFrame),
    endLevel: Math.abs(endFrame),
    seamJump,
    seamless,
    trimToZeroCrossing: seamless ? null : findTrailingZeroCrossing(buffer),
  };
}
