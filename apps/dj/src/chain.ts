// Compiles the mixer's live state into real Strudel source — never a custom format of our
// own. A "scene" is one snapshot of both decks + the crossfader; a "set" is an ordered
// list of scenes joined with Strudel's own `arrange()` timeline function, so what gets
// saved (see App.tsx's "save set") is just a Track like any other — playable from the
// main strudel-point editor too, not only from this app.
//
// dj's whole job is playing *existing* tracks — cutting audio into sample banks and
// pads lives in apps/pads now, a separate app. So a deck here holds a whole saved
// Track's Strudel source, not a rotation of cut slices: there's no audio to decode, no
// tempo to guess, nothing to scrub — just code, played (and sped up/filtered/ducked) as
// whatever it already is.

/**
 * One deck: a whole saved Track, played as-is and shaped with the same knobs a hardware
 * mixer channel would have. "duck" is a *rhythmic* gain-dip (a sine multiplying gain on a
 * dialed-in cycle, same trick the lfo control uses on the filter), not a true
 * audio-reactive sidechain compressor — a real one would need an envelope follower
 * actually listening to the other deck's live output, which Strudel's pattern language
 * doesn't do. This is the honest, buildable version of that idea.
 */
export interface DeckConfig {
  trackId: string;
  trackTitle: string;
  /** The saved Track's own source, unmodified except for stripping a leading `setcps(...)`
   * (see splitTrackCode) — never rewritten beyond that. */
  code: string;
  /** Playback rate multiplier — 1 = as authored. Strudel's `.speed()` really does
   * resample, so this changes tempo and pitch together, same as a physical deck's pitch
   * fader — not a formant-preserving stretch. */
  speed: number;
  gain: number;
  playing: boolean;
  /** Off entirely unless hpfEnabled — a real bypass (no `.hpf()` in the compiled source
   * at all), not just the knob sitting at a value that happens to sound transparent. */
  hpfEnabled: boolean;
  hpf: number;
  lpfEnabled: boolean;
  /** Also the center frequency the LFO (below) sweeps around when lfoEnabled is on. */
  lpf: number;
  /** Governs the lpf-sweep pair below. No effect while lpfEnabled is off — there's no
   * lpf in the chain at all for this to sweep. */
  lfoEnabled: boolean;
  /** LFO sweep rate, in cycles — Strudel/Tidal's native unit (tied to the pattern's own
   * transport clock via `.fast()`), not Hz. */
  lfoRate: number;
  /** How far the lowpass cutoff sweeps around `lpf`: between `lpf * (1 - lfoDepth)` and
   * `lpf * (1 + lfoDepth)` — the classic filter-wobble effect. */
  lfoDepth: number;
  /** Governs the duck pair below. See the interface doc above for what "duck" actually is. */
  duckEnabled: boolean;
  duckRate: number;
  duckDepth: number;
}

export interface Scene {
  /** How many cycles this scene lasts in a saved multi-scene set. Ignored for the single
   * live-mix case (buildLiveCode always plays scene 0 indefinitely). */
  bars: number;
  masterBpm: number;
  /** 0 = full deck A, 1 = full deck B, constant-power in between. */
  crossfade: number;
  deckA: DeckConfig | null;
  deckB: DeckConfig | null;
}

function fmt(n: number): string {
  return Number(n.toFixed(4)).toString();
}

/** Equal-power crossfade curve — the two gains' squares always sum to 1, so the perceived
 * loudness stays roughly constant across the sweep instead of dipping in the middle. */
export function crossfadeGains(x: number): [number, number] {
  const t = Math.min(1, Math.max(0, x));
  const angle = (t * Math.PI) / 2;
  return [Math.cos(angle), Math.sin(angle)];
}

/** Strips a leading `setcps(...)` line off a saved track's code (every track this app has
 * ever saved starts with one — see buildLiveCode/buildSetCode below — and most tracks
 * saved by the main editor do too), returning that declared tempo as bpm alongside the
 * rest of the code unchanged. Returns null for the tempo if there wasn't a leading
 * setcps() to parse — callers fall back to a default rather than guessing. */
export function splitTrackCode(code: string): { bpm: number | null; pattern: string } {
  const trimmed = code.trim();
  const match = trimmed.match(/^setcps\(\s*([^)]+?)\s*\)\s*;?\s*\n?/);
  if (!match) return { bpm: null, pattern: trimmed };
  const cps = Number(match[1]);
  return {
    bpm: Number.isFinite(cps) ? cps * 4 * 60 : null,
    pattern: trimmed.slice(match[0].length).trim(),
  };
}

/**
 * Pulls out Strudel's own top-level `$: <pattern>` syntax — a real JS labeled statement
 * (the label is literally the identifier `$`) that the main editor's transpiler picks up
 * to schedule each such line as its own simultaneous pattern, the same thing multiple
 * `$:` lines or a manual `stack(...)` would give you. That's exactly why every track this
 * room's editor saves tends to have one (see the sample tracks in `tracks` table): it's
 * the normal way to write "more than one thing playing at once" in Strudel.
 *
 * A deck here needs one expression to chain `.speed()`/`.gain()`/etc onto, not a handful
 * of separately-scheduled top-level statements — and a label can't legally sit inside a
 * `return (...)` expression anyway (that's a hard syntax error, not a silent miss). So
 * this collapses every active (non-comment) `$: expr` line into one `stack(...)` of those
 * exprs before wrapTrackExpression ever sees the pattern, leaving any other statements
 * (a `let` setup line, etc) alone. Multi-line `$: expr`s are supported via a plain
 * paren/bracket depth count across lines — no backtick-awareness, since mini-notation
 * strings realistically don't contain stray `(`/`)`/`[`/`]` themselves; another
 * heuristic, not a parser, same spirit as wrapTrackExpression below.
 */
function extractDollarPatterns(pattern: string): { setup: string; expr: string } | null {
  const lines = pattern.split("\n");
  const setupLines: string[] = [];
  const exprs: string[] = [];
  let current: string | null = null;
  let depth = 0;
  const bracketDelta = (line: string) =>
    (line.match(/[([{]/g)?.length ?? 0) - (line.match(/[)\]}]/g)?.length ?? 0);
  for (const line of lines) {
    if (current === null) {
      const match = line.match(/^\s*\$:\s*(.+)$/);
      if (!match) {
        setupLines.push(line);
        continue;
      }
      current = match[1].replace(/;\s*$/, "");
      depth = bracketDelta(current);
    } else {
      current += `\n${line.replace(/;\s*$/, "")}`;
      depth += bracketDelta(line);
    }
    if (depth <= 0) {
      exprs.push(current);
      current = null;
    }
  }
  if (current !== null) exprs.push(current); // unterminated — best effort, still better than dropping it
  if (exprs.length === 0) return null;
  const expr = exprs.length === 1 ? exprs[0] : `stack(${exprs.join(", ")})`;
  return { setup: setupLines.join("\n").trim(), expr };
}

/**
 * Wraps a track's pattern code so `.speed()`/`.gain()`/etc can be chained onto it as one
 * expression. Most tracks (anything this app itself saves, and plenty written by hand)
 * are already exactly that — one trailing expression, nothing else — and get wrapped in
 * plain parens. For anything with real statements before the final pattern (a `let`
 * binding, a helper function, several semicolon-separated lines), naively wrapping the
 * *whole* blob in parens would be a syntax error, so instead this turns it into an IIFE
 * and prefixes `return` onto just the last non-blank line: `(() => { ...setup...
 * return finalExpr; })()`. It's a heuristic, not a parser — code that doesn't put its
 * final pattern expression alone on the last line will slip through unreturned (the IIFE
 * would then implicitly return undefined, and this deck just wouldn't sound). Good
 * enough for what's realistically saved here without pulling in a real JS parser for it.
 */
function wrapTrackExpression(pattern: string): string {
  const dollarPatterns = extractDollarPatterns(pattern);
  if (dollarPatterns) {
    const { setup, expr } = dollarPatterns;
    return setup ? `(() => {\n${setup}\nreturn (${expr});\n})()` : `(${expr})`;
  }
  const looksLikeSingleExpression = !/;|^\s*(let|const|var|function)\b/m.test(pattern);
  if (looksLikeSingleExpression) return `(${pattern})`;
  const lines = pattern.split("\n");
  let lastNonBlank = lines.length - 1;
  while (lastNonBlank >= 0 && lines[lastNonBlank].trim() === "") lastNonBlank--;
  if (lastNonBlank < 0) return "silence";
  lines[lastNonBlank] = `return (${lines[lastNonBlank].replace(/;\s*$/, "")});`;
  return `(() => {\n${lines.join("\n")}\n})()`;
}

/** The `.gain(...)` argument — a plain number while duckEnabled is off, or a continuous
 * pattern that multiplies gain by a sweeping sine once it's on. `.mul()` is Strudel's
 * numeric-pattern multiply (same pattern-algebra Tidal's Num class exposes), so this
 * composes with whatever `gain` already is (crossfade included) rather than replacing it. */
function duckExprFor(deck: DeckConfig, gain: number): string {
  if (!deck.duckEnabled || deck.duckDepth <= 0.001) return fmt(gain);
  const floor = fmt(Math.max(0, 1 - deck.duckDepth));
  return `sine.range(${floor}, 1).fast(${fmt(deck.duckRate)}).mul(${fmt(gain)})`;
}

/** The `.lpf(...)` argument — a plain cutoff normally, or (once lfoEnabled) a continuous
 * pattern sweeping between `lpf * (1 ± lfoDepth)`, clamped to a sane audio range, for the
 * "lfo" filter-wobble control. */
function lpfExprFor(deck: DeckConfig): string {
  if (!deck.lfoEnabled || deck.lfoDepth <= 0.001) return fmt(deck.lpf);
  const lo = fmt(Math.max(20, deck.lpf * (1 - deck.lfoDepth)));
  const hi = fmt(Math.min(20000, deck.lpf * (1 + deck.lfoDepth)));
  return `sine.range(${lo}, ${hi}).fast(${fmt(deck.lfoRate)})`;
}

function deckPattern(deck: DeckConfig | null, gain: number): string | null {
  if (!deck || !deck.playing || gain <= 0.001) return null;
  const { pattern } = splitTrackCode(deck.code);
  const wrapped = wrapTrackExpression(pattern);
  // hpf/lpf are real bypasses when off — omitted from the chain entirely, not just
  // dialed to a value that happens to sound transparent.
  const hpfExpr = deck.hpfEnabled ? `.hpf(${fmt(deck.hpf)})` : "";
  const lpfExpr = deck.lpfEnabled ? `.lpf(${lpfExprFor(deck)})` : "";
  return `${wrapped}.speed(${fmt(deck.speed)}).gain(${duckExprFor(deck, gain)})${hpfExpr}${lpfExpr}`;
}

export function buildScenePattern(scene: Scene): string {
  const [gA, gB] = crossfadeGains(scene.crossfade);
  const parts = [deckPattern(scene.deckA, gA), deckPattern(scene.deckB, gB)].filter(
    (p): p is string => p !== null,
  );
  if (parts.length === 0) return "silence";
  if (parts.length === 1) return parts[0];
  return `stack(\n  ${parts.join(",\n  ")}\n)`;
}

/** What's actually evaluated live while you're mixing — always just the current scene, on loop. */
export function buildLiveCode(scene: Scene): string {
  return `setcps(${fmt(scene.masterBpm / 4 / 60)})\n${buildScenePattern(scene)}`;
}

/** A whole saved set: one global tempo (taken from the first scene — Strudel's cps is a
 * transport-level setting, not something arrange() can vary per section) and every scene
 * chained in order via arrange([bars, pattern], ...). */
export function buildSetCode(scenes: Scene[]): string {
  if (scenes.length === 0) return "silence";
  const cps = fmt(scenes[0].masterBpm / 4 / 60);
  if (scenes.length === 1) return `setcps(${cps})\n${buildScenePattern(scenes[0])}`;
  const sections = scenes
    .map((s) => `  [${Math.max(1, Math.round(s.bars))}, ${buildScenePattern(s)}]`)
    .join(",\n");
  return `setcps(${cps})\narrange(\n${sections}\n)`;
}
