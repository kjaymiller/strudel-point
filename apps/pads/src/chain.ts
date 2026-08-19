// Turns pad state into real Strudel source — never a custom format of our own — so it can
// be saved as a Track exactly like the main editor's buffer or the dj app's mixed scenes
// are (see apps/dj/src/chain.ts for that side of the same idea).

function fmt(n: number): string {
  return Number(n.toFixed(4)).toString();
}

// Every track this app saves (buildRackCode/buildRecordingCode below) starts with a
// leading `setcps(...)` declaring its tempo — same convention apps/dj/src/chain.ts's
// splitTrackCode reads off a saved Track's code, just read-only here (this app never
// rewrites a loaded track's code, only its own bpm input — see App.tsx's loadedTrack
// effect).
const SETCPS_PATTERN = /^\s*setcps\(\s*([^)]+?)\s*\)/;

/**
 * The bpm a saved Track's own code declares, read straight off its leading `setcps(...)`
 * line (cps = bpm / 4 / 60, the same "4 beats/cycle" convention this file's own
 * buildRackCode/buildRecordingCode use — inverted here: bpm = cps * 4 * 60). Returns null
 * for code that doesn't start with one (nothing to reasonably adjust to, in that case) or
 * declares a non-positive/non-numeric tempo.
 */
export function parseTrackBpm(code: string): number | null {
  const match = code.match(SETCPS_PATTERN);
  if (!match) return null;
  const cps = Number(match[1]);
  if (!Number.isFinite(cps) || cps <= 0) return null;
  return cps * 4 * 60;
}

/** Splits a slice ref like "kicks:2" into the bank name + index Strudel's own `s()`
 * mini-notation parses "name:n" into. Used wherever something triggers a slice directly
 * through superdough (pad grid, sample shelf preview) rather than by going through the
 * pattern scheduler. Same convention as apps/dj/src/chain.ts's version. */
export function parseSliceRef(ref: string): { s: string; n: number } {
  const idx = ref.lastIndexOf(":");
  if (idx === -1) return { s: ref, n: 0 };
  const n = Number(ref.slice(idx + 1));
  return Number.isFinite(n) ? { s: ref.slice(0, idx), n } : { s: ref, n: 0 };
}

/**
 * The current pad rack as one Strudel pattern: each pad's ref in order, one per cycle,
 * empty pads as rests. This is what gets autosaved as this room's pads Track (see
 * App.tsx) and what "▶ play rack" actually evaluates/broadcasts — the pads themselves
 * still fire as direct one-shots (bypassing this pattern entirely) so hitting one never
 * waits on or restarts this loop.
 */
export function buildRackCode(names: (string | null)[]): string {
  if (names.every((n) => !n)) return "silence";
  return `s("<${names.map((n) => n ?? "~").join(" ")}>")`;
}

/** One recorded pad hit — `t` is milliseconds elapsed since recording started (see
 * App.tsx's startRecording/handlePadTrigger), not yet quantized to anything. */
export interface RecordedHit {
  ref: string;
  t: number;
}

// Quantization grid for turning a free-timed recording into mini-notation: 16 steps per
// cycle, i.e. 16th notes at the same 4-beats/cycle convention apps/dj/src/chain.ts uses.
// Coarser than that and fast rolls collapse into one step; finer and the generated string
// gets unwieldy for what's meant to stay a quick, honest transcription of what you played.
const RECORDING_STEPS_PER_CYCLE = 16;

/**
 * A recorded performance as one real Strudel pattern: every hit snapped to the nearest
 * 16th-note step at `bpm` (same "4 beats/cycle" assumption the rest of this app's tempo
 * math makes), stacked into simultaneous-hit slots (`[a,b]`) wherever two pads landed on
 * the same step, empty steps as rests. Written as N space-separated steps `.slow(cycles)`
 * rather than one `<...>`-per-cycle block per cycle — mini-notation divides a single cycle
 * evenly among space-separated tokens, and `.slow(cycles)` is what stretches that one
 * cycle's worth of steps out to fill the recording's real length while keeping every
 * step's relative spacing intact.
 */
export function buildRecordingCode(hits: RecordedHit[], bpm: number): string {
  if (hits.length === 0) return "silence";
  const cycleSeconds = (4 * 60) / bpm;
  const stepSeconds = cycleSeconds / RECORDING_STEPS_PER_CYCLE;
  const stepIndices = hits.map((h) => Math.max(0, Math.round(h.t / 1000 / stepSeconds)));
  const lastStep = Math.max(...stepIndices);
  const totalSteps = (Math.floor(lastStep / RECORDING_STEPS_PER_CYCLE) + 1) * RECORDING_STEPS_PER_CYCLE;
  const totalCycles = totalSteps / RECORDING_STEPS_PER_CYCLE;
  const steps: string[][] = Array.from({ length: totalSteps }, () => []);
  hits.forEach((h, i) => steps[stepIndices[i]].push(h.ref));
  const tokens = steps.map((refs) => {
    if (refs.length === 0) return "~";
    if (refs.length === 1) return refs[0];
    return `[${refs.join(",")}]`;
  });
  return `setcps(${fmt(bpm / 4 / 60)})\ns("${tokens.join(" ")}").slow(${totalCycles})`;
}

// Hits landing within this many ms of each other count as one rhythmic event (a chord —
// several pads meant to land together), not two separate beats to measure a gap between.
const ONSET_MERGE_MS = 30;
// Histogram bucket width for finding the most common gap between onsets — coarse enough
// to absorb ordinary human timing wobble around a felt pulse, fine enough not to blur
// genuinely different subdivisions into the same bucket.
const GAP_BUCKET_MS = 20;
// Post-hoc octave correction, same idea as apps/dj/src/audio/beatcut.ts's MIN_BPM/MAX_BPM
// (just applied after the estimate instead of bounding the search) — a raw gap-based guess
// can land on a tempo's double or half just as easily as the tempo itself.
const MIN_ESTIMATE_BPM = 40;
const MAX_ESTIMATE_BPM = 300;

/**
 * Best-guess tempo straight from how far apart your presses actually landed, so a
 * recording's cps reflects how you actually played it rather than whatever bpm happened to
 * be dialed in beforehand: merge near-simultaneous hits into single onsets (chords aren't
 * a gap to measure), find the most common gap between what's left (a coarse histogram,
 * not exact clustering — same "best effort, not exact" spirit as beatcut.ts's
 * autocorrelation bpm guess, just off discrete press timestamps instead of an audio onset
 * envelope), and read that gap as one 16th-note step on this app's own 4-beats/cycle grid.
 * Returns null — caller falls back to whatever bpm is already set — when there isn't
 * enough of a performance (fewer than two distinct onsets) to estimate anything from.
 */
export function estimateBpmFromHits(hits: RecordedHit[]): number | null {
  const onsets: number[] = [];
  for (const t of hits.map((h) => h.t).sort((a, b) => a - b)) {
    if (onsets.length === 0 || t - onsets[onsets.length - 1] > ONSET_MERGE_MS) onsets.push(t);
  }
  if (onsets.length < 2) return null;

  const buckets = new Map<number, number>();
  for (let i = 1; i < onsets.length; i++) {
    const bucket = Math.round((onsets[i] - onsets[i - 1]) / GAP_BUCKET_MS);
    if (bucket > 0) buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  if (buckets.size === 0) return null;

  let bestBucket = 0;
  let bestCount = -1;
  for (const [bucket, count] of buckets) {
    if (count > bestCount) {
      bestBucket = bucket;
      bestCount = count;
    }
  }

  const stepSeconds = (bestBucket * GAP_BUCKET_MS) / 1000;
  let bpm = 15 / stepSeconds; // one step = one 16th note = (60/bpm)/4 seconds, solved for bpm
  while (bpm < MIN_ESTIMATE_BPM) bpm *= 2;
  while (bpm > MAX_ESTIMATE_BPM) bpm /= 2;
  return bpm;
}
