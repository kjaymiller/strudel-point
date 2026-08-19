// Slicing + WAV encoding for the beat analyzer. No deps — encoding a few short slices
// as 16-bit PCM WAV client-side doesn't need a library, and skips a network round trip
// through anything heavier than the browser's own Blob/DataView.

/** Copies out the [startSec, endSec) region of `buffer` as a standalone AudioBuffer. */
export function sliceAudioBuffer(buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
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
export function encodeWav(buffer: AudioBuffer): Blob {
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

/**
 * Concatenates several buffers end-to-end into one, for the "merge" side of the sample
 * editor — pick a couple of existing sounds, get back one loop-length buffer you can
 * scrub/chop like any freshly-dropped beat. Assumes all inputs share a sample rate (true
 * as long as they were decoded through the same AudioContext, which the sample editor
 * always uses); channel count is allowed to differ, mono inputs just get their one channel
 * duplicated across whatever wider channel count the merge settles on.
 */
export function concatAudioBuffers(buffers: AudioBuffer[]): AudioBuffer {
  if (buffers.length === 0) throw new Error("concatAudioBuffers: need at least one buffer");
  const sampleRate = buffers[0].sampleRate;
  const numberOfChannels = Math.max(...buffers.map((b) => b.numberOfChannels));
  const length = buffers.reduce((sum, b) => sum + b.length, 0);
  const out = new AudioBuffer({ numberOfChannels, length, sampleRate });

  let offset = 0;
  for (const buffer of buffers) {
    for (let c = 0; c < numberOfChannels; c++) {
      const source = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
      out.copyToChannel(source, c, offset);
    }
    offset += buffer.length;
  }
  return out;
}
