// Best-effort reverse transform: turns Strudel source text back into a module+cable rack —
// the inverse of patch.ts's buildMixCode/expressionAt/appendModuleChain, for loading a
// previously-saved (or hand-written, or another app's) Track into this app's visual rack.
//
// This is necessarily lossy in both directions patch.ts's own doc comments already flag:
// a module patched but left at its "off" value (delay send=0, filterenv amount=0, a
// single-input Channel, ...) emits zero code, so it can never come back from text alone;
// and a direct siggen/EOS gate feeding a voice source's "in" jack is textually
// indistinguishable from a typed Sequencer pattern (see patch.ts's directGatePatternFor vs
// noteHeadFor) — this parser always resolves that ambiguity in favor of a Sequencer, which
// is the far more common case and never produces *wrong* sound, just a different rack
// shape than whoever originally patched a siggen directly would have built. A nested
// `stack(...)` appearing as a branch's own head (a Channel summing >1 input before being
// chained further) isn't reconstructed either — that whole branch is left unmatched.
//
// Anything not recognized at all — an unknown function, a stray method call, a branch that
// doesn't parse as a plain call chain — is never turned into a module; its exact source
// range is reported in `unmatchedRanges` instead, so the caller can show it (still there,
// still real code) rather than silently dropping it.

import { cableKey } from "./cables";
import {
  createModule,
  type FilterType,
  jackAddress,
  LFO_SHAPES,
  type LfoShape,
  MODULE_LABELS,
  type ModPedalTarget,
  type ModuleInstance,
  type ModuleKind,
  type TonalWaveform,
  WAVEFORMS,
} from "./modules";

export interface CodeRange {
  start: number;
  end: number;
}

export interface ParsedPatch {
  modules: ModuleInstance[];
  cables: string[];
  unmatchedRanges: CodeRange[];
}

// --- balanced-bracket / string scanning -------------------------------------------------

function skipString(s: string, i: number): number {
  const quote = s[i];
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === "\\") {
      j += 2;
      continue;
    }
    if (s[j] === quote) return j;
    j++;
  }
  return j;
}

/** Index of the close bracket matching the open bracket at `openIndex` (one of `([{`),
 * skipping over any string literals in between. Tracks every bracket type on a shared
 * stack (not just the one at `openIndex`) so mismatched nesting inside — an object literal
 * inside a call's parens, say — doesn't throw the count off. */
function findMatchingClose(s: string, openIndex: number): number {
  const stack: string[] = [];
  for (let i = openIndex; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      i = skipString(s, i);
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") stack.push(ch);
    else if (ch === ")" || ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Splits `s[start..end)` on top-level occurrences of `sep` (depth 0 — not inside any
 * bracket or string) into contiguous ranges. Used for `stack(...)`'s comma-separated
 * branches. */
function splitTopLevel(s: string, start: number, end: number, sep: string): CodeRange[] {
  const parts: CodeRange[] = [];
  const stack: string[] = [];
  let partStart = start;
  for (let i = start; i < end; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      i = skipString(s, i);
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") stack.push(ch);
    else if (ch === ")" || ch === "}" || ch === "]") stack.pop();
    else if (ch === sep && stack.length === 0) {
      parts.push({ start: partStart, end: i });
      partStart = i + 1;
    }
  }
  parts.push({ start: partStart, end });
  return parts;
}

function trimRange(s: string, start: number, end: number): CodeRange {
  while (start < end && /\s/.test(s[start])) start++;
  while (end > start && /\s/.test(s[end - 1])) end--;
  return { start, end };
}

// --- call-chain tokenizing ---------------------------------------------------------------

interface CallToken {
  name: string;
  argsText: string;
  /** Start of the whole call (including a leading `.` when present), end just past its
   * closing paren — what gets reported in `unmatchedRanges` for a token nothing recognizes. */
  start: number;
  end: number;
}

/** Tokenizes one call chain — a bare identifier call (`s(...)`/`note(...)`/`stack(...)`)
 * followed by zero or more `.method(...)` calls — over `s[start..end)`. Returns null if
 * anything in that range isn't a plain call chain (a stray operator, unbalanced syntax, a
 * second bare expression, ...), which the caller treats as "this whole branch is
 * unmatched" rather than guessing at a partial read. */
function tokenizeChain(s: string, start: number, end: number): CallToken[] | null {
  const tokens: CallToken[] = [];
  let i = start;
  const skipWs = () => {
    while (i < end && /\s/.test(s[i])) i++;
  };
  skipWs();
  let first = true;
  while (i < end) {
    const tokenStart = i;
    if (!first) {
      if (s[i] !== ".") return null;
      i++;
    }
    const identStart = i;
    while (i < end && /[a-zA-Z0-9_$]/.test(s[i])) i++;
    if (i === identStart) return null;
    const name = s.slice(identStart, i);
    skipWs();
    if (s[i] !== "(") return null;
    const argsStart = i + 1;
    const closeIdx = findMatchingClose(s, i);
    if (closeIdx === -1 || closeIdx >= end) return null;
    tokens.push({ name, argsText: s.slice(argsStart, closeIdx), start: tokenStart, end: closeIdx + 1 });
    i = closeIdx + 1;
    skipWs();
    first = false;
  }
  return tokens;
}

// --- arg parsing --------------------------------------------------------------------------

function parseStringArg(argsText: string): string | null {
  const m = /^\s*(['"])([\s\S]*?)\1\s*$/.exec(argsText);
  return m ? m[2] : null;
}

function parseNumberArg(argsText: string): number | null {
  const n = Number(argsText.trim());
  return Number.isFinite(n) ? n : null;
}

/** The exact `.lfo({ control, rate, depth, shape })` object shape lfoSuffixFor emits (see
 * patch.ts) — a regex match, not a real object-literal parse, since that's the only shape
 * this app's own codegen ever produces. */
function parseLfoArgs(argsText: string): { rate: number; depth: number; shape: LfoShape } | null {
  const m = /rate:\s*([-\d.]+)\s*,\s*depth:\s*([-\d.]+)\s*,\s*shape:\s*"([^"]+)"/.exec(argsText);
  if (!m) return null;
  const shape = m[3];
  if (!(LFO_SHAPES as readonly string[]).includes(shape)) return null;
  return { rate: Number(m[1]), depth: Number(m[2]), shape: shape as LfoShape };
}

const FILTER_STAGE = /^(lp|hp|bp)(env|attack|decay|sustain|release|rate|depth|shape)$/;
const FM_FAMILY = /^fm(h|wave|attack|decay|sustain|release)?(\d*)$/;

function fmSlotFromSuffix(suffix: string): number {
  return suffix === "" ? 1 : Number(suffix);
}

// --- per-branch interpretation -------------------------------------------------------------

interface BranchResult {
  /** The module whose audio-out should feed the next thing downstream (another branch's
   * merge point, or the master Output) — the voice source itself if no processing module
   * matched at all. */
  terminal: ModuleInstance;
}

/** Shared, mutable build state threaded through one whole parse — a counter for fresh
 * module ids/names (continuing App.tsx's own `mod-N` convention) and the output arrays the
 * caller gets back. */
interface Builder {
  modules: ModuleInstance[];
  cables: string[];
  unmatchedRanges: CodeRange[];
  counts: Partial<Record<ModuleKind, number>>;
  nextId: () => string;
}

function addModule<K extends ModuleKind>(b: Builder, kind: K): Extract<ModuleInstance, { kind: K }> {
  const count = (b.counts[kind] ?? 0) + 1;
  b.counts[kind] = count;
  const mod = createModule(kind as ModuleKind, b.nextId(), `${MODULE_LABELS[kind]} ${count}`) as Extract<
    ModuleInstance,
    { kind: K }
  >;
  b.modules.push(mod);
  return mod;
}

function connect(b: Builder, fromAddr: string, toAddr: string) {
  b.cables.push(cableKey(fromAddr, toAddr));
}

/** Interprets one already-tokenized call chain into modules/cables, per the shapes
 * patch.ts's voiceExpression/appendModuleChain/fmOperatorParts emit (see this file's own
 * doc comment for the two known, deliberately-unresolved ambiguities). Returns null (whole
 * chain reported unmatched by the caller) when the head itself isn't `s(...)`/`note(...)`,
 * or a `note(...)` head never finds a paired `.s(...)` anywhere in the chain — with neither,
 * there's no way to know what's actually making sound. */
function interpretChain(b: Builder, tokens: CallToken[]): BranchResult | null {
  const head = tokens[0];
  if (!head || (head.name !== "s" && head.name !== "note")) return null;

  let sourceName: string | null = null;
  let rest = tokens.slice(1);
  let sequencer: Extract<ModuleInstance, { kind: "sequencer" }> | null = null;

  if (head.name === "s") {
    sourceName = parseStringArg(head.argsText);
  } else {
    const noteText = parseStringArg(head.argsText) ?? "";
    const sIdx = rest.findIndex((t) => t.name === "s");
    if (sIdx === -1) return null; // note(...) with nothing to say *what* plays it
    sourceName = parseStringArg(rest[sIdx].argsText);
    const slowIdx = rest.findIndex((t) => t.name === "slow");
    sequencer = addModule(b, "sequencer");
    if (slowIdx !== -1) {
      const cycles = parseNumberArg(rest[slowIdx].argsText);
      sequencer.params.playMode = "hold";
      sequencer.params.holdNote = noteText;
      if (cycles !== null) sequencer.params.holdCycles = cycles;
    } else {
      sequencer.params.playMode = "sequence";
      sequencer.params.sequence = noteText;
    }
    rest = rest.filter((_, i) => i !== sIdx && i !== slowIdx);
  }

  if (sourceName === null) return null;
  const isVco = (WAVEFORMS as readonly string[]).includes(sourceName);
  // A vco/sampler two-member union, not the full ModuleInstance union — narrow enough that
  // `.params.gain` (the one field both share) still type-checks below without a cast;
  // waveform/sampleName/octave/density (not shared) get their own explicit casts instead.
  type SourceModule = Extract<ModuleInstance, { kind: "vco" }> | Extract<ModuleInstance, { kind: "sampler" }>;
  let source: SourceModule;
  if (isVco) {
    const vco = addModule(b, "vco");
    vco.params.waveform = sourceName as (typeof WAVEFORMS)[number];
    source = vco;
  } else {
    const sampler = addModule(b, "sampler");
    sampler.params.sampleName = sourceName;
    source = sampler;
  }

  if (sequencer) connect(b, jackAddress(sequencer.id, "note-out"), jackAddress(source.id, "in"));

  let vcf: Extract<ModuleInstance, { kind: "vcf" }> | null = null;
  let filterenv: Extract<ModuleInstance, { kind: "filterenv" }> | null = null;
  let filterlfo: Extract<ModuleInstance, { kind: "filterlfo" }> | null = null;
  let envelope: Extract<ModuleInstance, { kind: "envelope" }> | null = null;
  let pitchenv: Extract<ModuleInstance, { kind: "pitchenv" }> | null = null;
  let vibrato: Extract<ModuleInstance, { kind: "vibrato" }> | null = null;
  let delay: Extract<ModuleInstance, { kind: "delay" }> | null = null;
  let reverb: Extract<ModuleInstance, { kind: "reverb" }> | null = null;
  const fmops = new Map<number, Extract<ModuleInstance, { kind: "fmop" }>>();
  // Inline audio chain, in encounter order — the same order the source text lists them,
  // which (since expressionAt/appendModuleChain build text bottom-up from the voice source
  // outward) is exactly the real signal-flow order.
  const chain: ModuleInstance[] = [];
  let lastStage: { moduleId: string; stage: ModPedalTarget } | null = null;

  for (const tok of rest) {
    if (tok.name === "lfo") {
      if (lastStage) {
        const parsed = parseLfoArgs(tok.argsText);
        if (parsed) {
          const pedal = addModule(b, "modpedal");
          pedal.params = {
            control: lastStage.stage,
            rate: parsed.rate,
            depth: parsed.depth,
            shape: parsed.shape,
          };
          connect(b, jackAddress(pedal.id, "env-mod-out"), jackAddress(lastStage.moduleId, "env-mod-in"));
        } else {
          b.unmatchedRanges.push({ start: tok.start, end: tok.end });
        }
      } else {
        b.unmatchedRanges.push({ start: tok.start, end: tok.end });
      }
      lastStage = null;
      continue;
    }
    lastStage = null;

    const num = () => parseNumberArg(tok.argsText);
    const str = () => parseStringArg(tok.argsText);

    if (tok.name === "octave" && isVco) {
      const n = num();
      if (n !== null) (source as Extract<ModuleInstance, { kind: "vco" }>).params.octave = n;
    } else if (tok.name === "density" && isVco) {
      const n = num();
      if (n !== null) (source as Extract<ModuleInstance, { kind: "vco" }>).params.density = n;
    } else if (tok.name === "gain") {
      const n = num();
      if (n !== null) source.params.gain = n;
    } else if (
      tok.name === "penv" ||
      tok.name === "pattack" ||
      tok.name === "pdecay" ||
      tok.name === "psustain" ||
      tok.name === "prelease"
    ) {
      pitchenv ??= addModule(b, "pitchenv");
      const n = num();
      if (n === null) continue;
      if (tok.name === "penv") pitchenv.params.amount = n;
      else {
        const stage = tok.name.slice(1) as ModPedalTarget; // "pattack" -> "attack", etc.
        pitchenv.params[stage] = n;
        lastStage = { moduleId: pitchenv.id, stage };
      }
    } else if (tok.name === "vib" || tok.name === "vibmod") {
      vibrato ??= addModule(b, "vibrato");
      const n = num();
      if (n === null) continue;
      if (tok.name === "vib") vibrato.params.rate = n;
      else vibrato.params.depth = n;
    } else if (tok.name === "lpf" || tok.name === "hpf" || tok.name === "bpf") {
      vcf ??= addModule(b, "vcf");
      if (!chain.includes(vcf)) chain.push(vcf);
      vcf.params.type = tok.name as FilterType;
      const n = num();
      if (n !== null) vcf.params.cutoff = n;
    } else if (tok.name === "resonance" || tok.name === "hresonance" || tok.name === "bandq") {
      vcf ??= addModule(b, "vcf");
      if (!chain.includes(vcf)) chain.push(vcf);
      const n = num();
      if (n !== null) vcf.params.resonance = n;
    } else if (tok.name === "drive") {
      vcf ??= addModule(b, "vcf");
      if (!chain.includes(vcf)) chain.push(vcf);
      const n = num();
      if (n !== null) vcf.params.drive = n;
    } else if (FILTER_STAGE.test(tok.name)) {
      const m = FILTER_STAGE.exec(tok.name)!;
      const field = m[2];
      const n = num();
      if (n === null) continue;
      if (field === "env") {
        filterenv ??= addModule(b, "filterenv");
        filterenv.params.amount = n;
      } else if (field === "attack" || field === "decay" || field === "sustain" || field === "release") {
        filterenv ??= addModule(b, "filterenv");
        filterenv.params[field] = n;
        lastStage = { moduleId: filterenv.id, stage: field };
      } else {
        filterlfo ??= addModule(b, "filterlfo");
        if (field === "rate") filterlfo.params.rate = n;
        else if (field === "depth") filterlfo.params.depth = n;
        else filterlfo.params.shape = n;
      }
    } else if (
      tok.name === "attack" ||
      tok.name === "decay" ||
      tok.name === "sustain" ||
      tok.name === "release"
    ) {
      envelope ??= addModule(b, "envelope");
      if (!chain.includes(envelope)) chain.push(envelope);
      const n = num();
      if (n === null) continue;
      envelope.params[tok.name] = n;
      lastStage = { moduleId: envelope.id, stage: tok.name };
    } else if (tok.name === "delay" || tok.name === "delaytime" || tok.name === "delayfeedback") {
      delay ??= addModule(b, "delay");
      if (!chain.includes(delay)) chain.push(delay);
      const n = num();
      if (n === null) continue;
      if (tok.name === "delay") delay.params.send = n;
      else if (tok.name === "delaytime") delay.params.time = n;
      else delay.params.feedback = n;
    } else if (
      tok.name === "room" ||
      tok.name === "roomsize" ||
      tok.name === "roomlp" ||
      tok.name === "roomfade"
    ) {
      reverb ??= addModule(b, "reverb");
      if (!chain.includes(reverb)) chain.push(reverb);
      const n = num();
      if (n === null) continue;
      if (tok.name === "room") reverb.params.room = n;
      else if (tok.name === "roomsize") reverb.params.size = n;
      else if (tok.name === "roomlp") reverb.params.lp = n;
      else reverb.params.fade = n;
    } else if (FM_FAMILY.test(tok.name)) {
      const m = FM_FAMILY.exec(tok.name)!;
      const slot = fmSlotFromSuffix(m[2]);
      let fmop = fmops.get(slot);
      if (!fmop) {
        fmop = addModule(b, "fmop");
        fmops.set(slot, fmop);
        chain.push(fmop);
      }
      const field = m[1];
      if (field === undefined) {
        const n = num();
        if (n !== null) fmop.params.index = n;
      } else if (field === "h") {
        const n = num();
        if (n !== null) fmop.params.ratio = n;
      } else if (field === "wave") {
        const s = str();
        if (s !== null) fmop.params.wave = s as TonalWaveform;
      } else {
        // Only "attack"/"decay"/"sustain"/"release" reach here (the other FM_FAMILY
        // capture-group values were handled above) — the regex itself can't tell TS that.
        const n = num();
        if (n !== null) fmop.params[field as "attack" | "decay" | "sustain" | "release"] = n;
      }
    } else {
      b.unmatchedRanges.push({ start: tok.start, end: tok.end });
    }
  }

  if (pitchenv) connect(b, jackAddress(pitchenv.id, "pitch-mod-out"), jackAddress(source.id, "in"));
  if (vibrato) connect(b, jackAddress(vibrato.id, "pitch-mod-out"), jackAddress(source.id, "in"));
  if (filterenv && vcf)
    connect(b, jackAddress(filterenv.id, "cutoff-mod-out"), jackAddress(vcf.id, "cutoff-mod-in"));
  if (filterlfo && vcf)
    connect(b, jackAddress(filterlfo.id, "cutoff-mod-out"), jackAddress(vcf.id, "cutoff-mod-in"));

  let upstream: ModuleInstance = source;
  for (const mod of chain) {
    connect(b, jackAddress(upstream.id, "audio-out"), jackAddress(mod.id, "audio-in"));
    upstream = mod;
  }
  return { terminal: upstream };
}

/** One branch of a (possibly implicit, single-branch) top-level `stack(...)` — parses a
 * plain call chain over `[start, end)`; a branch that isn't one (a nested `stack(...)` used
 * as a Channel with more than one input, or anything else that doesn't tokenize as a call
 * chain at all — see this file's doc comment) is reported as fully unmatched instead of
 * guessed at. */
function parseBranch(b: Builder, code: string, start: number, end: number): BranchResult | null {
  const trimmed = trimRange(code, start, end);
  if (trimmed.start >= trimmed.end) return null;
  if (code.slice(trimmed.start, trimmed.end) === "silence") return null;
  const tokens = tokenizeChain(code, trimmed.start, trimmed.end);
  if (!tokens) {
    b.unmatchedRanges.push(trimmed);
    return null;
  }
  const result = interpretChain(b, tokens);
  if (!result) {
    b.unmatchedRanges.push(trimmed);
    return null;
  }
  return result;
}

export function parsePatchCode(code: string): ParsedPatch {
  const b: Builder = {
    modules: [],
    cables: [],
    unmatchedRanges: [],
    counts: {},
    nextId: (() => {
      let n = 0;
      return () => `imp-${++n}`;
    })(),
  };

  const trimmed = trimRange(code, 0, code.length);
  const wholeText = code.slice(trimmed.start, trimmed.end);
  const branchRanges: CodeRange[] = /^stack\(/.test(wholeText)
    ? (() => {
        const openIdx = trimmed.start + "stack(".length - 1;
        const closeIdx = findMatchingClose(code, openIdx);
        if (closeIdx === -1) return [trimmed];
        return splitTopLevel(code, openIdx + 1, closeIdx, ",");
      })()
    : [trimmed];

  const output = addModule(b, "output");
  for (const range of branchRanges) {
    const result = parseBranch(b, code, range.start, range.end);
    if (result) connect(b, jackAddress(result.terminal.id, "audio-out"), jackAddress(output.id, "audio-in"));
  }

  return { modules: b.modules, cables: b.cables, unmatchedRanges: b.unmatchedRanges };
}
