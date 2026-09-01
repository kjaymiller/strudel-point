// Turns an arbitrary blob of bytes into a Strudel number sequence.
//
// The output is deliberately *just numbers and rests* — "3 5 ~ 2 4 ~ 1 1" — because the
// point is to hand you material you can point at any instrument you like:
//
//   n("3 5 ~ 2").sound("piano")
//   n("3 5 ~ 2").scale("c3:minor").sound("sawtooth")
//   note("3 5 ~ 2".add(60))
//
// Choosing the key, the mode, the tempo and the drum kit for you would be picking the song;
// this picks the notes and leaves the song alone.
//
// Deliberately a pure function over a Uint8Array, living in shared/ rather than in either
// app: the browser calls it on a dropped file, and the gateway calls it on a channel
// sample's stored audio for the chatbot's `sonify_bytes` tool. Same bytes must produce the
// same sequence in both places, or "make that pattern funkier" would be refining something
// the user never heard.

/** Strudel's rest. Not `-`, which mini-notation does not read as silence. */
const REST = "~";

export interface BytesSequenceOptions {
  /**
   * Fixes the number of steps. Clamped to minSteps..maxSteps. When omitted the length is
   * derived from the bytes too, so different files give differently-shaped phrases.
   */
  steps?: number;
  /** Shortest sequence the bytes may produce. Clamped to 1..64. Default 8. */
  minSteps?: number;
  /** Longest sequence the bytes may produce. Clamped to minSteps..64. Default 32. */
  maxSteps?: number;
  /** Numbers run 0..range-1. Clamped to 2..64. Default 8 — an octave of scale degrees. */
  range?: number;
  /**
   * Share of steps that come out as rests, 0..1. Default 0.25. Quantised to sixteenths of
   * the byte's low nibble, so 0 really is no rests and 1 really is all of them.
   */
  rest?: number;
  /** Shown in the header comment — usually the dropped file's name. */
  label?: string;
}

export interface BytesSequence {
  /** One entry per step, `null` for a rest. The raw material, if you want to build on it. */
  steps: (number | null)[];
  /** Mini-notation for the same thing: `"3 5 ~ 2"`. Drop into n(), note(), whatever. */
  notation: string;
  /** The smallest thing that plays: a comment and `n("…")`. */
  code: string;
  bytesRead: number;
  /** Numbers in `steps` are 0..range-1. */
  range: number;
}

const DEFAULT_MIN_STEPS = 8;
const DEFAULT_MAX_STEPS = 32;
const HARD_MAX_STEPS = 64;
const DEFAULT_RANGE = 8;
const DEFAULT_REST = 0.25;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.floor(value)));
}

/**
 * Folds the whole file down to one byte per step.
 *
 * Sampling every Nth byte would be cheaper but would make the result blind to most of the
 * file — two archives differing only in their payload would sonify identically. Folding
 * every byte of a step's slice with a rolling `acc * 31 + byte` keeps the result sensitive
 * to both content and order, and stays O(n) with no allocation per step.
 */
function bucketize(bytes: Uint8Array, steps: number): Uint8Array {
  const buckets = new Uint8Array(steps);
  if (bytes.length === 0) return buckets;
  for (let i = 0; i < steps; i++) {
    const start = Math.floor((i * bytes.length) / steps);
    const end = Math.floor(((i + 1) * bytes.length) / steps);
    let acc = 0;
    // A step can be empty when the file is shorter than `steps` — it stays 0, which reads
    // as a rest, so a 3-byte file gives three notes and silence after.
    for (let j = start; j < end; j++) {
      acc = (acc * 31 + bytes[j]) & 0xff;
    }
    buckets[i] = acc;
  }
  return buckets;
}

/** Order-sensitive whole-file checksum, used to pick the length. */
function checksum(bytes: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc * 131 + bytes[i]) & 0xffff;
  }
  return acc;
}

/**
 * The comment carries the file name, which is attacker-controlled in the sense that anyone
 * can name a file so that it closes the comment and opens a statement. Strip anything that
 * could terminate the comment or start a new line of code.
 */
function safeLabel(label: string): string {
  return label
    .replace(/[\r\n]+/g, " ")
    .replace(/\*\//g, "*")
    .trim()
    .slice(0, 80);
}

/** Groups steps into fours so a long sequence still reads as a phrase. */
function group(tokens: string[]): string {
  const bars: string[] = [];
  for (let i = 0; i < tokens.length; i += 4) {
    bars.push(tokens.slice(i, i + 4).join(" "));
  }
  return bars.join("  ");
}

export function bytesToSequence(bytes: Uint8Array, opts: BytesSequenceOptions = {}): BytesSequence {
  const minSteps = clamp(opts.minSteps ?? DEFAULT_MIN_STEPS, 1, HARD_MAX_STEPS);
  const maxSteps = clamp(opts.maxSteps ?? DEFAULT_MAX_STEPS, minSteps, HARD_MAX_STEPS);
  const range = clamp(opts.range ?? DEFAULT_RANGE, 2, HARD_MAX_STEPS);

  const sum = checksum(bytes);
  // Length is part of what the file "is": an explicit `steps` wins, otherwise the checksum
  // picks somewhere in the allowed band so two files rarely come out the same shape.
  const length =
    opts.steps === undefined
      ? minSteps + (sum % (maxSteps - minSteps + 1))
      : clamp(opts.steps, minSteps, maxSteps);

  // 0..16. A byte rests when its low nibble falls under this, so 0 yields no rests at all
  // and 16 yields nothing but rests.
  const restCutoff = clamp(Math.round((opts.rest ?? DEFAULT_REST) * 16), 0, 16);

  const buckets = bucketize(bytes, length);
  const steps: (number | null)[] = [];

  for (let i = 0; i < length; i++) {
    const value = buckets[i];
    // Two independent halves of the same byte: the low nibble decides whether anything
    // sounds, the high nibble decides what. Gating both on one property would make the
    // rests land only on certain numbers.
    const lo = value & 0x0f;
    const hi = value >> 4;
    steps.push(lo < restCutoff ? null : hi % range);
  }

  const notation = group(steps.map((step) => (step === null ? REST : String(step))));

  const label = opts.label ? safeLabel(opts.label) : "";
  const source = label ? `"${label}"` : "input";
  const code = `// ${bytes.length} bytes of ${source} -> ${length} steps, values 0..${range - 1}
n("${notation}")`;

  return { steps, notation, code, bytesRead: bytes.length, range };
}

/**
 * Appends a generated sequence to the bottom of an existing buffer, commented out.
 *
 * The buffer is shared and probably playing. Dropping a file used to *replace* it, which
 * means someone else's work vanishes mid-session because a third person dropped a PNG on a
 * chat panel. Commented and appended, the drop changes nothing about what the room hears:
 * it arrives as material, and whoever wants it uncomments it.
 *
 * `bytesToSequence` already emits its own `//` header, and has already stripped anything
 * from the filename that could close a comment (see safeLabel), so lines that are comments
 * already are left alone rather than gaining a second prefix.
 */
export function appendCommented(existing: string, block: string): string {
  const commented = block
    .split("\n")
    .map((line) => (line.startsWith("//") ? line : `// ${line}`))
    .join("\n");
  const trimmed = existing.replace(/\s+$/, "");
  return trimmed.length > 0 ? `${trimmed}\n\n${commented}\n` : `${commented}\n`;
}
