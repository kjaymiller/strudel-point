// Minimal client-side analysis for the pads app: just a peaks array for each pad's small
// waveform readout. Trimmed copy of apps/dj/src/audio.ts's peaksOf — this app has no decks
// to analyze tempo for, so the rest of that file (analyzeDeck et al) doesn't apply here.

/** Bucketed-max waveform peaks for one decoded buffer — feeds PadGrid's mini thumbnails. */
export function peaksOf(buffer: AudioBuffer, buckets: number): Float32Array {
  const data = buffer.getChannelData(0);
  const bucketSize = Math.max(1, Math.floor(data.length / buckets));
  const out = new Float32Array(buckets);
  for (let i = 0; i < buckets; i++) {
    let hi = 0;
    const start = i * bucketSize;
    const end = Math.min(data.length, start + bucketSize);
    for (let j = start; j < end; j++) hi = Math.max(hi, Math.abs(data[j]));
    out[i] = hi;
  }
  return out;
}
