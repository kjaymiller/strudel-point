// Turns the module+cable graph (see modules.ts/cables.ts) into real Strudel source. Every
// control name below is a real superdough control param, chosen to match exactly (see
// node_modules/.../superdough/superdough.mjs's lpMap/hpMap/bpMap and helpers.mjs's
// pitch-envelope/vibrato params).
import { sourcesTo } from "./cables";
import { eosPattern, gatesToPattern, gatesToSequenceText } from "./sequencer";
import { jackAddress, moduleIdOfAddress, type FilterType, type FmOperatorParams, type ModPedalTarget, type ModuleInstance } from "./modules";

/** superdough's per-filter-type param prefix, see the lpMap/hpMap/bpMap this mirrors. */
const FILTER_PREFIX: Record<FilterType, string> = { lpf: "lp", hpf: "hp", bpf: "bp" };
/** The filter's own cutoff/resonance control names differ per type; everything else
 * (env/lfo) is just `${prefix}${suffix}`. */
const FILTER_Q_PARAM: Record<FilterType, string> = { lpf: "resonance", hpf: "hresonance", bpf: "bandq" };

function round(n: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function moduleOf(modules: ModuleInstance[], id: string): ModuleInstance | undefined {
  return modules.find((m) => m.id === id);
}

/** The first module of `kind` feeding `destination`, if any. A CV input (cutoff/pitch-
 * mod-in) can carry more than one incoming cable (see modules.ts's jackCapacity), but
 * superdough only has one filter-envelope/filter-LFO/pitch-envelope/vibrato *parameter*
 * slot per voice — there's no way to actually sum two envelope generators into one
 * `lpenv`, unlike a passive analog CV mixer. So if more than one modulator of the same
 * kind ends up cabled to the same input, only the first (by cable order) actually takes
 * effect; the rest are visibly patched but silently redundant. Two *different* kinds
 * (e.g. one filter env + one filter LFO) both apply at once, same as the fixed pairing
 * this app used before modules existed. */
function firstModulator<K extends ModuleInstance["kind"]>(
  modules: ModuleInstance[],
  cables: string[],
  destination: string,
  kind: K,
): Extract<ModuleInstance, { kind: K }> | undefined {
  for (const source of sourcesTo(cables, destination)) {
    const mod = moduleOf(modules, moduleIdOfAddress(source));
    if (mod && mod.kind === kind) return mod as Extract<ModuleInstance, { kind: K }>;
  }
  return undefined;
}

/** The two module kinds that actually generate sound instead of just processing/routing
 * it — a VCO's oscillator and a Sampler's named sample are otherwise identical from the
 * graph's point of view (see voiceExpression below): both take an optional Sequencer, an
 * optional direct Signal gen/EOS, and an optional Pitch env/Vibrato, any combination of
 * which can cable into their one unified "in" jack (see modules.ts's "vco-in" role), and
 * both bottom out the recursion in expressionAt since neither has an audio-in of its
 * own. */
type VoiceSourceInstance = Extract<ModuleInstance, { kind: "vco" | "sampler" }>;
function isVoiceSource(mod: ModuleInstance): mod is VoiceSourceInstance {
  return mod.kind === "vco" || mod.kind === "sampler";
}

/** Every module kind with a jack a Signal gen/EOS can feed a gate through — a
 * Sequencer's own dedicated "gate-in" (see effectiveSequenceFor), or, directly, a voice
 * source's single unified "in" jack (see directGatePatternFor), skipping the Sequencer
 * entirely for a plain gated rhythm with nothing to type. */
function gateInAddress(mod: ModuleInstance): string | undefined {
  if (mod.kind === "sequencer") return jackAddress(mod.id, "gate-in");
  if (isVoiceSource(mod)) return jackAddress(mod.id, "in");
  return undefined;
}

/** The Signal gen module currently feeding `mod`'s gate input, if any — `mod` is a
 * Sequencer or, for a direct un-typed rhythm, a voice source itself (see
 * gateInAddress). */
export function siggenFeeding(mod: ModuleInstance, modules: ModuleInstance[], cables: string[]) {
  const address = gateInAddress(mod);
  if (!address) return undefined;
  return firstModulator(modules, cables, address, "siggen");
}

/** The EOS (end-of-sequence/cycle) module currently feeding `mod`'s gate input, if any —
 * mutually exclusive with siggenFeeding above on a Sequencer's own gate-in, whose
 * capacity is 1 (see modules.ts's jackCapacity): that jack is fed by at most one clock
 * source at a time, whichever kind is actually cabled in. A voice source's unified "in"
 * jack can carry both at once, but only one of siggenFeeding/eosFeeding would ever
 * actually find something, since a real cable is still just one or the other. */
export function eosFeeding(mod: ModuleInstance, modules: ModuleInstance[], cables: string[]) {
  const address = gateInAddress(mod);
  if (!address) return undefined;
  return firstModulator(modules, cables, address, "eos");
}

/** superdough's `sine` control-pattern floor for a Signal gen's rate sweep — keeps the
 * modulated clock from crossing zero/negative, same "clamp away from nonsense" spirit as
 * every other depth-based sweep in this app (see e.g. FilterPanel's lpf/hpf bounds). */
const MIN_SIGGEN_RATE = 0.0625;

/** A Filter LFO feeding `siggen`'s rate-mod-in, if any — reuses the generic Filter LFO
 * generator to modulate a Signal gen's clock speed instead of a filter's cutoff, same
 * "cable it wherever the role matches" reuse compatibleDestinationRoles already allows. */
function rateLfoFeeding(siggen: Extract<ModuleInstance, { kind: "siggen" }>, modules: ModuleInstance[], cables: string[]) {
  return firstModulator(modules, cables, jackAddress(siggen.id, "rate-mod-in"), "filterlfo");
}

/** The live `.fast(...)` argument for a Signal gen's clock — a sine sweeping between
 * `rate*(1-depth)` and `rate*(1+depth)` at the LFO's own rate, real continuous modulation
 * (not a static multiplier) exactly like a filter LFO sweeping a VCF's cutoff. Undefined
 * (no modulation) when nothing's cabled to rate-mod-in, or the LFO itself is inert (rate
 * or depth at 0) — same "0 = no effect" convention every other modulator here follows. */
function rateModExprFor(siggen: Extract<ModuleInstance, { kind: "siggen" }>, modules: ModuleInstance[], cables: string[]): string | undefined {
  const lfo = rateLfoFeeding(siggen, modules, cables);
  if (!lfo || lfo.params.rate <= 0 || lfo.params.depth <= 0) return undefined;
  const base = siggen.params.rate;
  const lo = Math.max(MIN_SIGGEN_RATE, base * (1 - lfo.params.depth));
  const hi = Math.max(lo, base * (1 + lfo.params.depth));
  return `sine.range(${round(lo)}, ${round(hi)}).fast(${round(lfo.params.rate)})`;
}

type ModPedalInstance = Extract<ModuleInstance, { kind: "modpedal" }>;

/** Every Mod pedal cabled into an envelope-shaped module's one generic "env-mod-in" —
 * its capacity is Infinity (a passive summing CV input, same convention as cutoff/
 * pitch-mod-in), so several pedals can modulate different stages of the same envelope at
 * once; each pedal picks *which* stage via its own Target control (see
 * ModPedalModuleCard), not by which physical jack it happened to land on — there's only
 * the one jack. */
function modPedalsFeeding(modId: string, modules: ModuleInstance[], cables: string[]): ModPedalInstance[] {
  return sourcesTo(cables, jackAddress(modId, "env-mod-in"))
    .map((source) => moduleOf(modules, moduleIdOfAddress(source)))
    .filter((m): m is ModPedalInstance => m?.kind === "modpedal");
}

/** The real `.lfo({control, rate, depth, shape})` suffix — Strudel's own generic
 * modulator (see strudel.cc/learn/lfo), not an approximation built out of continuous
 * signal patterns — chained immediately after this stage's flat `.method(value)` call
 * whenever some Mod pedal cabled into `modId`'s env-mod-in has its own Target set to
 * `stage`. Empty string otherwise (nothing cabled in, or the pedal's own rate/depth is
 * still at 0), so callers can always append this unconditionally.
 *
 * `controlName` is the actual resolved superdough control name for this stage *on this
 * specific caller* — plain "attack" for the VCA envelope, "lpattack"/"hpattack"/
 * "bpattack" for a Filter env (depending on which filter type it's feeding), "pattack"
 * for a Pitch env. The pedal itself only ever needs to know the stage in the abstract
 * (attack/decay/sustain/release, same four options regardless of which envelope it's
 * plugged into) — resolving that to the real prefixed control name is each call site's
 * own job, since it's the one that already knows which kind of envelope this is. */
function lfoSuffixFor(
  modId: string,
  stage: ModPedalTarget,
  controlName: string,
  modules: ModuleInstance[],
  cables: string[],
): string {
  const pedal = modPedalsFeeding(modId, modules, cables).find((p) => p.params.control === stage);
  if (!pedal || pedal.params.rate <= 0 || pedal.params.depth <= 0) return "";
  return `.lfo({ control: "${controlName}", rate: ${round(pedal.params.rate)}, depth: ${round(pedal.params.depth)}, shape: "${pedal.params.shape}" })`;
}

/** The note pattern text a Sequencer is actually playing right now — its own free-typed
 * `sequence` field, unless its gate-in is cabled to a Signal gen or EOS module, in which
 * case that module's own pattern takes over (same "signal gen out -> trigger in"
 * relationship this app has always had, just now a real cable to a real module instead of
 * a fixed jack). When that Signal gen's own rate-mod-in is itself LFO'd, the static
 * `*rate` multiplier is dropped from this text entirely — there's no fixed number left to
 * show — in favor of the live `.fast(...)` suffix noteHeadFor/directGateFastSuffix append
 * after this gets wrapped in `note(...)`; this string alone is display-safe either way
 * (see SequencerModuleCard's read-only text field). */
export function effectiveSequenceFor(sequencer: ModuleInstance, modules: ModuleInstance[], cables: string[]): string {
  if (sequencer.kind !== "sequencer") return "";
  const siggen = siggenFeeding(sequencer, modules, cables);
  if (siggen) {
    return rateModExprFor(siggen, modules, cables) !== undefined
      ? gatesToPattern(siggen.params.gates)
      : gatesToSequenceText(siggen.params.gates, siggen.params.rate);
  }
  if (eosFeeding(sequencer, modules, cables)) return eosPattern();
  return sequencer.params.sequence;
}

/** The `.fast(...)` suffix to chain after a Sequencer-driven `note(...)` head when its
 * gate-in's Signal gen is itself rate-LFO'd (see rateModExprFor) — empty string
 * otherwise, so callers can always append this unconditionally. */
function sequencerFastSuffix(sequencer: Extract<ModuleInstance, { kind: "sequencer" }>, modules: ModuleInstance[], cables: string[]): string {
  const siggen = siggenFeeding(sequencer, modules, cables);
  if (!siggen) return "";
  const rateMod = rateModExprFor(siggen, modules, cables);
  return rateMod ? `.fast(${rateMod})` : "";
}

/** Whether this Sequencer's typed `sequence` field is currently overridden by an external
 * clock (Signal gen or EOS) — drives the "text field disabled, showing what's actually
 * playing instead" state in SequencerModuleCard. */
export function sequenceIsGatedFor(sequencer: ModuleInstance, modules: ModuleInstance[], cables: string[]): boolean {
  return siggenFeeding(sequencer, modules, cables) !== undefined || eosFeeding(sequencer, modules, cables) !== undefined;
}

/** A voice source's own gate input, read directly off its unified "in" jack (no
 * Sequencer involved) — lets a Signal gen or EOS drive a plain, un-typed rhythm on a
 * VCO/Sampler on its own. Only ever consulted by voiceExpression once sequencerFeeding
 * has come up empty — a Sequencer's own pattern always takes priority when one's
 * actually cabled in, same as a real modular rig where the more specific/downstream
 * connection wins. */
export function directGatePatternFor(source: ModuleInstance, modules: ModuleInstance[], cables: string[]): string | undefined {
  if (!isVoiceSource(source)) return undefined;
  const siggen = siggenFeeding(source, modules, cables);
  if (siggen) {
    return rateModExprFor(siggen, modules, cables) !== undefined
      ? gatesToPattern(siggen.params.gates)
      : gatesToSequenceText(siggen.params.gates, siggen.params.rate);
  }
  if (eosFeeding(source, modules, cables)) return eosPattern();
  return undefined;
}

/** The `.fast(...)` suffix to chain after a directly-gated voice source's `note(...)`
 * head when its own Signal gen is itself rate-LFO'd (see rateModExprFor) — empty string
 * otherwise. Mirrors sequencerFastSuffix for the "skip the Sequencer" direct-gate path. */
function directGateFastSuffix(source: VoiceSourceInstance, modules: ModuleInstance[], cables: string[]): string {
  const siggen = siggenFeeding(source, modules, cables);
  if (!siggen) return "";
  const rateMod = rateModExprFor(siggen, modules, cables);
  return rateMod ? `.fast(${rateMod})` : "";
}

/** The Sequencer module currently feeding this voice source's (VCO or Sampler) unified
 * "in" jack, if any. */
export function sequencerFeeding(source: ModuleInstance, modules: ModuleInstance[], cables: string[]) {
  if (!isVoiceSource(source)) return undefined;
  return firstModulator(modules, cables, jackAddress(source.id, "in"), "sequencer");
}

/** The `note("...")`/`.slow(...)` head for a voice source fed by `sequencer` (see
 * effectiveSequenceFor above, playMode deciding sequence-vs-hold). Only ever called once
 * sequencerFeeding has confirmed a Sequencer is actually cabled in — see voiceExpression,
 * which is what decides whether a voice source gets a note pattern at all. */
function noteHeadFor(sequencer: Extract<ModuleInstance, { kind: "sequencer" }>, modules: ModuleInstance[], cables: string[]): string {
  const sp = sequencer.params;
  if (sp.playMode === "hold") {
    const cycles = Number.isFinite(sp.holdCycles) && sp.holdCycles > 0 ? sp.holdCycles : 16;
    return `note("${sp.holdNote.trim() || "c3"}").slow(${cycles})`;
  }
  const sequence = effectiveSequenceFor(sequencer, modules, cables);
  return `note("${sequence.trim() || "c e g c5"}")${sequencerFastSuffix(sequencer, modules, cables)}`;
}

/** The literal sound-source name (a VCO's waveform, or a Sampler's sample name) — no
 * leading dot, since this doubles as a bare, standalone `s(...)` head (see
 * voiceExpression) when nothing's cabled into the "in" jack. */
function sourceName(source: VoiceSourceInstance): string {
  return source.kind === "vco" ? source.params.waveform : source.params.sampleName.trim() || "bd";
}

/** The kind-specific half of a voice source's `.method()` chain — a VCO's `.s(...)`
 * plus octave, or a Sampler's plain `.s(...)` — everything else (note source, pitch
 * mod, gain, crackle density) is shared (see voiceExpression). Only meaningful once
 * chained after a `note(...)` head; the bare (no-Sequencer) fallback uses sourceName
 * directly instead, since octave acts on a *note* — it shifts whatever pitch is
 * playing — and there's no note to shift on a bare, unpitched one-hit trigger. */
function sourceHeadParts(source: VoiceSourceInstance): string[] {
  const parts = [`.s("${sourceName(source)}")`];
  if (source.kind === "vco" && source.params.octave !== 0) parts.push(`.octave(${source.params.octave})`);
  return parts;
}

/** A voice source's (VCO or Sampler) own contribution — its note pattern, from whichever
 * of two sources is actually cabled into its unified "in" jack (a Sequencer, checked
 * first, or a Signal gen/EOS directly — see sequencerFeeding/directGatePatternFor) — or,
 * absent both, just the bare sound source itself (`s("bd")`, one hit per cycle,
 * same as you'd write by hand for a patch that doesn't need a melody), plus its own
 * always-local pitch-mod/gain — the complete expression before any downstream module
 * (VCF, Envelope, Delay, Reverb, Channel...) adds anything of its own. Neither kind has
 * an audio-in, so this is always where a signal graph walk bottoms out — see
 * expressionAt below. */
function voiceExpression(source: VoiceSourceInstance, modules: ModuleInstance[], cables: string[]): string {
  const p = source.params;
  const sequencer = sequencerFeeding(source, modules, cables);
  const directGate = sequencer ? undefined : directGatePatternFor(source, modules, cables);
  const headParts = sourceHeadParts(source);

  // Either a Sequencer or a direct gate feeding this voice means the sound source is
  // `.s(...)`-chained onto a `note(...)` head below; with neither cabled in, the
  // `.s(...)` call *is* the head — `s("bd")` on its own, no note() wrapper at all, same
  // as writing that sound source directly.
  const parts: string[] = sequencer || directGate ? headParts : [];

  // Crackle's pop-rate `density` control is read straight off the trigger's flat params
  // object by superdough's noise generator (see noise.mjs's getNoiseBuffer) — it has
  // nothing to do with pitch/notes, unlike octave above, so unlike octave it has to
  // apply whether or not a note() head is in play, same tier as .gain() below.
  if (source.kind === "vco" && source.params.waveform === "crackle") {
    parts.push(`.density(${round(source.params.density)})`);
  }

  const pitchEnv = firstModulator(modules, cables, jackAddress(source.id, "in"), "pitchenv");
  if (pitchEnv && pitchEnv.params.amount !== 0) {
    parts.push(
      `.penv(${round(pitchEnv.params.amount)})`,
      `.pattack(${round(pitchEnv.params.attack)})${lfoSuffixFor(pitchEnv.id, "attack", "pattack", modules, cables)}`,
      `.pdecay(${round(pitchEnv.params.decay)})${lfoSuffixFor(pitchEnv.id, "decay", "pdecay", modules, cables)}`,
      `.psustain(${round(pitchEnv.params.sustain)})${lfoSuffixFor(pitchEnv.id, "sustain", "psustain", modules, cables)}`,
      `.prelease(${round(pitchEnv.params.release)})${lfoSuffixFor(pitchEnv.id, "release", "prelease", modules, cables)}`,
    );
  }
  const vibrato = firstModulator(modules, cables, jackAddress(source.id, "in"), "vibrato");
  if (vibrato && vibrato.params.rate > 0) {
    parts.push(`.vib(${round(vibrato.params.rate)})`, `.vibmod(${round(vibrato.params.depth)})`);
  }
  parts.push(`.gain(${round(p.gain)})`);

  // Bare fallback is `s("bd")` — a real, dot-less function call standing on its own as
  // the head — not `headParts.join("")`: headParts are `.method()` calls meant to be
  // chained after something, and joining them without a receiver in front (e.g.
  // `.s("saw")` on its own) is a syntax error, not a valid expression.
  const head = sequencer
    ? noteHeadFor(sequencer, modules, cables)
    : directGate
      ? `note("${directGate.trim() || "c3"}")${directGateFastSuffix(source, modules, cables)}`
      : `s("${sourceName(source)}")`;
  return `${head}\n  ${parts.join("\n  ")}`;
}

// superdough's own suffix convention for its multi-operator FM controls (fm/fm2/fm3/...,
// fmh/fmh2/fmh3/..., up to 8) — empty for the first of a family, the 1-based index for
// the rest.
const FM_SUFFIXES = ["", "2", "3", "4", "5", "6", "7", "8"];

/** One FM operator module's own `.method()`s, at whichever numbered `slot` expressionAt
 * assigned it (1 = closest to the voice source, modulating it directly — superdough's
 * plain `fm`/`fmh`/...; 2 modulates slot 1; 3 modulates slot 2; and so on, superdough's
 * own fixed `fm3 -> fm2 -> fm1 -> carrier`-style chain). Falls back to the literal number
 * past superdough's real 8-operator ceiling rather than silently dropping an operator —
 * `.fm9(...)` would be a real error in Strudel, but that's an honest failure for a chain
 * this deep, not something worth quietly working around here. */
function fmOperatorParts(op: FmOperatorParams, slot: number): string[] {
  const suf = FM_SUFFIXES[slot - 1] ?? String(slot);
  return [
    `.fm${suf}(${round(op.index)})`,
    `.fmh${suf}(${round(op.ratio)})`,
    `.fmwave${suf}("${op.wave}")`,
    `.fmattack${suf}(${round(op.attack)})`,
    `.fmdecay${suf}(${round(op.decay)})`,
    `.fmsustain${suf}(${round(op.sustain)})`,
    `.fmrelease${suf}(${round(op.release)})`,
  ];
}

/** Appends one processing module's own `.method()`s onto `expr` (already the complete
 * expression for whatever feeds this module's audio-in — one upstream voice, or several
 * already merged into a `stack(...)` if this module is a Channel/Output — see
 * expressionAt). Sequencer/siggen/filterenv/filterlfo/pitchenv/vibrato/modpedal are
 * off-chain modulator sources read directly by whichever module they feed (see
 * firstModulator/modPedalsFeeding calls elsewhere), not in-line audio stages, so they
 * contribute nothing here; Channel and Output are pure buses with no controls of their
 * own — same deal. "fmop" is handled directly by expressionAt instead of here, since its
 * own contribution depends on its position in the chain (see fmOperatorParts) in a way
 * none of these other kinds need to. */
function appendModuleChain(expr: string, mod: ModuleInstance, modules: ModuleInstance[], cables: string[]): string {
  const parts: string[] = [];
  if (mod.kind === "envelope") {
    const e = mod.params;
    parts.push(
      `.attack(${round(e.attack)})${lfoSuffixFor(mod.id, "attack", "attack", modules, cables)}`,
      `.decay(${round(e.decay)})${lfoSuffixFor(mod.id, "decay", "decay", modules, cables)}`,
      `.sustain(${round(e.sustain)})${lfoSuffixFor(mod.id, "sustain", "sustain", modules, cables)}`,
      `.release(${round(e.release)})${lfoSuffixFor(mod.id, "release", "release", modules, cables)}`,
    );
  } else if (mod.kind === "vcf") {
    const f = mod.params;
    const prefix = FILTER_PREFIX[f.type];
    parts.push(`.${f.type}(${round(f.cutoff, 1)})`, `.${FILTER_Q_PARAM[f.type]}(${round(f.resonance)})`);
    if (f.drive > 0) parts.push(`.drive(${round(f.drive)})`);
    const env = firstModulator(modules, cables, jackAddress(mod.id, "cutoff-mod-in"), "filterenv");
    if (env && env.params.amount !== 0) {
      parts.push(
        `.${prefix}env(${round(env.params.amount)})`,
        `.${prefix}attack(${round(env.params.attack)})${lfoSuffixFor(env.id, "attack", `${prefix}attack`, modules, cables)}`,
        `.${prefix}decay(${round(env.params.decay)})${lfoSuffixFor(env.id, "decay", `${prefix}decay`, modules, cables)}`,
        `.${prefix}sustain(${round(env.params.sustain)})${lfoSuffixFor(env.id, "sustain", `${prefix}sustain`, modules, cables)}`,
        `.${prefix}release(${round(env.params.release)})${lfoSuffixFor(env.id, "release", `${prefix}release`, modules, cables)}`,
      );
    }
    const lfo = firstModulator(modules, cables, jackAddress(mod.id, "cutoff-mod-in"), "filterlfo");
    if (lfo && lfo.params.rate > 0 && lfo.params.depth > 0) {
      parts.push(`.${prefix}rate(${round(lfo.params.rate)})`, `.${prefix}depth(${round(lfo.params.depth)})`);
      if (lfo.params.shape > 0) parts.push(`.${prefix}shape(${round(lfo.params.shape)})`);
    }
  } else if (mod.kind === "delay") {
    const d = mod.params;
    if (d.send > 0) {
      parts.push(`.delay(${round(d.send)})`, `.delaytime(${round(d.time)})`, `.delayfeedback(${round(d.feedback)})`);
    }
  } else if (mod.kind === "reverb") {
    const r = mod.params;
    if (r.room > 0) {
      parts.push(
        `.room(${round(r.room)})`,
        `.roomsize(${round(r.size)})`,
        `.roomlp(${round(r.lp, 0)})`,
        `.roomfade(${round(r.fade)})`,
      );
    }
  }
  // "channel"/"output" contribute nothing — see this function's doc comment.
  if (parts.length === 0) return expr;
  return `${expr}\n  ${parts.join("\n  ")}`;
}

/** Wraps several already-complete expressions in one `stack(...)` so they play
 * simultaneously — this is the only point any of them are combined at all, whether that
 * merge happens at a Channel's audio-in or at the master Output's. A single expression
 * just passes through unwrapped. */
function stackExprs(exprs: string[]): string {
  if (exprs.length === 1) return exprs[0];
  const indented = exprs.map((e) =>
    e
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );
  return `stack(\n${indented.join(",\n")}\n)`;
}

/** One node's result from expressionAt's graph walk: its complete Strudel expression so
 * far, plus how many FM operator modules have contributed to it along this specific path
 * (0 at a bare voice source) — see fmOperatorParts. Threaded alongside `expr` rather than
 * re-derived from it (e.g. by scanning the string for `.fm` calls) because once a Channel
 * merges several branches, those branches can each have used a different number of FM
 * slots internally without conflict — they're independent sub-expressions, not a shared
 * flat namespace — so only the count *along the branch actually being extended* is ever
 * meaningful. */
interface ExprResult {
  expr: string;
  fmSlot: number;
}

/** The Strudel expression this module actually outputs, walking the cable graph
 * *backward* from it (via sourcesTo on its audio-in) all the way to whichever voice
 * source(s) — VCO or Sampler — ultimately feed it: a voice source bottoms the recursion
 * out (voiceExpression, no audio-in to follow further, fmSlot starts at 0); a Channel or
 * Output sums every upstream expression that reaches it into one `stack(...)`
 * (stackExprs) before any of its own `.method()`s (none, for these two) are appended,
 * taking the *highest* fmSlot among its branches forward so a later FM operator module
 * downstream of the merge still picks an unused slot number relative to all of them; an
 * FM operator module (see fmOperatorParts) takes the next slot up from whatever's
 * upstream of it and — unless its own Index is 0, same "0 = off" rule every modulator
 * here follows — bumps the count for whatever comes after it; every other processing
 * module (VCF/Envelope/Delay/Reverb) has exactly one incoming cable, so it's just that
 * one upstream expression with its own chain appended (appendModuleChain), fmSlot passed
 * through unchanged. Returns null for a dead branch — an unconnected audio-in, or a cable
 * loop back onto a module already being expanded on this same path (`visiting`), same
 * "no sound" outcome as an unpatched module has always had here. */
function expressionAt(
  moduleId: string,
  modules: ModuleInstance[],
  cables: string[],
  visiting: Set<string>,
  reachedSourceIds: Set<string>,
): ExprResult | null {
  if (visiting.has(moduleId)) return null;
  const mod = moduleOf(modules, moduleId);
  if (!mod) return null;
  if (isVoiceSource(mod)) {
    reachedSourceIds.add(mod.id);
    return { expr: voiceExpression(mod, modules, cables), fmSlot: 0 };
  }
  const nextVisiting = new Set(visiting);
  nextVisiting.add(moduleId);
  const upstream = sourcesTo(cables, jackAddress(moduleId, "audio-in"))
    .map((source) => expressionAt(moduleIdOfAddress(source), modules, cables, nextVisiting, reachedSourceIds))
    .filter((r): r is ExprResult => r !== null);
  if (upstream.length === 0) return null;
  const combined = stackExprs(upstream.map((r) => r.expr));
  const priorFmSlot = Math.max(0, ...upstream.map((r) => r.fmSlot));
  if (mod.kind === "fmop") {
    if (mod.params.index <= 0) return { expr: combined, fmSlot: priorFmSlot };
    const slot = priorFmSlot + 1;
    return { expr: `${combined}\n  ${fmOperatorParts(mod.params, slot).join("\n  ")}`, fmSlot: slot };
  }
  return { expr: appendModuleChain(combined, mod, modules, cables), fmSlot: priorFmSlot };
}

export interface MixResult {
  code: string;
  /** Voice sources (VCO or Sampler) whose audio-out chain never reaches the master
   * Output — patched partway, dead-ended at an unconnected audio-in, or looped back on
   * themselves through one or more Channels — so they're silently excluded from `code`,
   * same as an unpatched VCO on a real modular rig. Surfaced so the UI can flag them
   * instead of leaving "why is this silent?" a mystery. */
  unterminatedSourceIds: string[];
}

/** The whole rack's output: starts at the master Output and walks the cable graph
 * backward (see expressionAt) — every voice source that actually has a path to Output,
 * through however many Channels and processing modules, ends up folded into the result;
 * any that don't are reported via unterminatedSourceIds. */
export function buildMixCode(modules: ModuleInstance[], cables: string[]): MixResult {
  const output = modules.find((m) => m.kind === "output");
  const reachedSourceIds = new Set<string>();
  const result = output ? expressionAt(output.id, modules, cables, new Set(), reachedSourceIds) : null;
  const unterminatedSourceIds = modules.filter((m) => isVoiceSource(m) && !reachedSourceIds.has(m.id)).map((m) => m.id);
  return { code: result?.expr ?? "silence", unterminatedSourceIds };
}
