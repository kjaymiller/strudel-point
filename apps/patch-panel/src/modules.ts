// The free-patch rack: every generation/processing/modulation stage is its own module
// instance (see ModuleKind) with its own labeled jacks (see JackRole) — you build the
// signal chain yourself by cabling module to module, same as a real modular synth,
// instead of the app assuming a fixed VCO->VCF->VCA order. A module only actually
// contributes sound once its audio-out cable chain reaches the master Output module (see
// patch.ts's expressionAt) — an unpatched module is inert, same "the knob still remembers
// its position but does nothing until there's a cable in the jack" rule this app has
// always used for modulation, now extended to the audio path itself.
import { defaultGates } from "./sequencer";

export type TonalWaveform = "sine" | "triangle" | "sawtooth" | "square";
/** superdough's four dedicated noise sources — each its own `s()` oscillator type, same
 * mechanism as the tonal waveforms above, just unpitched. */
export type NoiseWaveform = "white" | "pink" | "brown" | "crackle";
export type Waveform = TonalWaveform | NoiseWaveform;
export const TONAL_WAVEFORMS: TonalWaveform[] = ["sine", "triangle", "sawtooth", "square"];
export const NOISE_WAVEFORMS: NoiseWaveform[] = ["white", "pink", "brown", "crackle"];
export const WAVEFORMS: Waveform[] = [...TONAL_WAVEFORMS, ...NOISE_WAVEFORMS];
export function isNoiseWaveform(w: Waveform): w is NoiseWaveform {
  return (NOISE_WAVEFORMS as readonly string[]).includes(w);
}

export type FilterType = "lpf" | "hpf" | "bpf";
export const FILTER_TYPES: FilterType[] = ["lpf", "hpf", "bpf"];

/** Default crackle density (superdough's own default). */
export const DEFAULT_DENSITY = 0.02;

export interface Adsr {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

export type ModuleKind =
  | "sequencer"
  | "vco"
  | "sampler"
  | "vcf"
  | "envelope"
  | "filterenv"
  | "filterlfo"
  | "pitchenv"
  | "vibrato"
  | "fmop"
  | "delay"
  | "reverb"
  | "siggen"
  | "eos"
  | "modpedal"
  | "channel"
  | "output";

/** Human labels for the "+ module" toolbar and module card headers. */
export const MODULE_LABELS: Record<ModuleKind, string> = {
  sequencer: "Sequencer",
  vco: "VCO",
  sampler: "Sampler",
  vcf: "VCF",
  envelope: "Envelope (VCA)",
  filterenv: "Filter env",
  filterlfo: "Filter LFO",
  pitchenv: "Pitch env",
  vibrato: "Vibrato",
  fmop: "FM operator",
  delay: "Delay",
  reverb: "Reverb",
  siggen: "Signal gen",
  eos: "EOS trigger",
  modpedal: "Mod pedal",
  channel: "Channel",
  output: "Output",
};

/** Every kind you can add from the toolbar — everything except "output", which is a
 * singleton the rack always has exactly one of (see App.tsx). */
export const ADDABLE_MODULE_KINDS: ModuleKind[] = [
  "sequencer",
  "vco",
  "sampler",
  "vcf",
  "envelope",
  "filterenv",
  "filterlfo",
  "pitchenv",
  "vibrato",
  "fmop",
  "delay",
  "reverb",
  "siggen",
  "eos",
  "modpedal",
  "channel",
];

export type JackRole =
  | "audio-out"
  | "audio-in"
  | "cutoff-mod-out"
  | "cutoff-mod-in"
  | "pitch-mod-out"
  | "gate-out"
  | "gate-in"
  | "rate-mod-in"
  | "note-out"
  // A VCO/Sampler's single unified input — see jacksFor's vco/sampler case. Replaces
  // what used to be three separate destination jacks (note-in, gate-in, pitch-mod-in):
  // one physical jack, cable in whatever combination of a Sequencer (note-out), a
  // Signal gen/EOS (gate-out, for a plain rhythm with nothing typed — see patch.ts's
  // directGatePatternFor), and a Pitch env/Vibrato (pitch-mod-out) you actually want —
  // patch.ts's codegen figures out what's plugged in by module kind, not by which of
  // several jacks it landed on.
  | "vco-in"
  // A Mod pedal's generic output (see jacksFor's "modpedal" case and ModPedalModuleCard)
  // and the one matching input every envelope-shaped module (VCA envelope, Filter env,
  // Pitch env) exposes for it — see patch.ts's lfoSuffixFor, which is what actually turns
  // a cabled pedal into a real `.lfo({control, rate, depth, shape})` call on whichever of
  // its four ADSR stages the pedal's own Target control names. One jack per envelope, not
  // four: the pedal — not the jack it lands on — decides which stage it targets, so
  // several pedals can cable into the same env-mod-in and each modulate a different stage
  // (see modules.ts's jackCapacity: env-mod-in is a passive summing input, same as
  // cutoff-mod-in/pitch-mod-in).
  | "env-mod-out"
  | "env-mod-in";

export function isSourceRole(role: JackRole): boolean {
  return role.endsWith("-out");
}

/** Every destination role a given source role is allowed to cable to. Most pairs are
 * still a simple "-out" <-> "-in" of the same prefix (audio, cutoff-mod, env-mod) — no
 * cross-domain patching, audio can't plug into a CV input — but note-out/gate-out/
 * pitch-mod-out each *also* accept a VCO/Sampler's single unified "vco-in" (see that
 * role's own doc comment), on top of whatever domain-specific "-in" they already had
 * (gate-out can still feed a Sequencer's own gate-in, for instance). cutoff-mod-out also
 * reaches a Signal gen's rate-mod-in — a Filter LFO is just a generic LFO generator
 * wherever it's cabled, filter-cutoff being only its most common target, not the only
 * one it's allowed to modulate (see patch.ts's rateModExprFor). */
export function compatibleDestinationRoles(role: JackRole): JackRole[] {
  switch (role) {
    case "audio-out":
      return ["audio-in"];
    case "cutoff-mod-out":
      return ["cutoff-mod-in", "rate-mod-in"];
    case "note-out":
      return ["vco-in"];
    case "pitch-mod-out":
      return ["vco-in"];
    case "gate-out":
      return ["gate-in", "vco-in"];
    case "env-mod-out":
      return ["env-mod-in"];
    default:
      return [];
  }
}

/** How many cables a jack of this role, on a module of this kind, may carry at once.
 * Every *source* jack fans out freely — same as a passive mult/splitter on a real
 * modular rig, one output normaled out to as many destinations as you cable in, each
 * getting an identical copy of whatever that source produces (the same note pattern out
 * of one Sequencer to several VCOs, the same voice out of one VCO into several Channels,
 * etc — see PatchBay.tsx's beginDrag, which always starts a *new* cable from a source
 * rather than replacing one). Destination jacks stay capped at one incoming cable, with
 * two deliberate exceptions: a CV modulation input (cutoff/pitch-mod-in) is a passive
 * summing jack, same as most real modular CV inputs, so an envelope and an LFO can both
 * modulate the same VCF/VCO at once; and a Channel's or the master Output's audio-in is
 * a true mix bus, accepting every voice cabled into it (a Channel just doesn't terminate
 * the chain the way Output does — see patch.ts's expressionAt). */
export function jackCapacity(kind: ModuleKind, role: JackRole): number {
  if (isSourceRole(role)) return Infinity;
  if (role === "audio-in" && (kind === "output" || kind === "channel")) return Infinity;
  // cutoff-mod-in sums a filter env + LFO; vco-in sums a Sequencer, a Signal gen/EOS, and
  // a Pitch env/Vibrato all at once; env-mod-in sums as many Mod pedals as you cable in,
  // each targeting whichever ADSR stage its own Target control names — see that role's
  // own doc comment above.
  if (role === "cutoff-mod-in" || role === "vco-in" || role === "env-mod-in") return Infinity;
  return 1;
}

export interface JackSpec {
  /** Local jack id within a module, e.g. "audio-out" — combined with the module's own id
   * (see jackAddress) to form the globally-unique address cables are stored by. */
  id: string;
  role: JackRole;
  label: string;
}

/** The one mod-in jack shared by every ADSR-shaped module (VCA envelope, Filter env,
 * Pitch env) — see JackRole's own doc comment and patch.ts's lfoSuffixFor for how a
 * cabled Mod pedal turns into a real modulation on whichever stage its own Target
 * control names. Factored out once since all three modules get the identical jack. */
function envModInJack(): JackSpec {
  return {
    id: "env-mod-in",
    role: "env-mod-in",
    label: "mod in <- Mod pedal out (targets whichever stage its own Target picks)",
  };
}

/** Every jack this module kind exposes, always in the same order for a given kind. */
export function jacksFor(kind: ModuleKind): JackSpec[] {
  switch (kind) {
    case "sequencer":
      return [
        { id: "gate-in", role: "gate-in", label: "trig in <- signal gen out" },
        { id: "note-out", role: "note-out", label: "out -> a VCO's note in" },
      ];
    // Sampler shares the exact jack shape a VCO has — a sibling sound source, not a
    // different kind of thing, just `.s("bd")` instead of `.s("sawtooth")` underneath
    // (see patch.ts's sourceName). One unified input jack (see "vco-in"'s own doc
    // comment) takes the place of three separate ones: cable in a Sequencer for a
    // typed note pattern, a Signal gen/EOS directly for a plain untyped rhythm (see
    // patch.ts's directGatePatternFor — only read once a Sequencer's pattern comes up
    // empty), and/or a Pitch env/Vibrato for pitch modulation, in any combination.
    case "vco":
    case "sampler":
      return [
        {
          id: "in",
          role: "vco-in",
          label: "in <- sequencer note / signal gen or EOS gate / pitch env or vibrato",
        },
        { id: "audio-out", role: "audio-out", label: "audio out" },
      ];
    case "vcf":
      return [
        { id: "audio-in", role: "audio-in", label: "audio in" },
        { id: "cutoff-mod-in", role: "cutoff-mod-in", label: "cutoff mod in <- filter env / LFO out" },
        { id: "audio-out", role: "audio-out", label: "audio out" },
      ];
    // Same audio in/out as delay/reverb below, plus the one generic mod-in every
    // envelope-shaped module gets — see envModInJack.
    case "envelope":
      return [
        { id: "audio-in", role: "audio-in", label: "audio in" },
        envModInJack(),
        { id: "audio-out", role: "audio-out", label: "audio out" },
      ];
    // A single FM operator, inline in the audio path like any other processing module
    // (see https://strudel.cc/learn/synths/#fm-synthesis — `.fm()`/`.fmh()`/etc are just
    // chainable controls, not fixed to living on the oscillator itself in the source).
    // Its slot number (which of superdough's fm/fm2/fm3/... it becomes) is assigned by
    // its own position in the chain, closest-to-the-voice-source first — see patch.ts's
    // expressionAt/fmOperatorParts. Chain several in series to build a multi-operator
    // stack; each one's own Index is its on/off switch, same "0 = no effect" rule every
    // other modulator here follows.
    case "fmop":
    case "delay":
    case "reverb":
      return [
        { id: "audio-in", role: "audio-in", label: "audio in" },
        { id: "audio-out", role: "audio-out", label: "audio out" },
      ];
    // Same cutoff-mod-out as Filter LFO, plus its own generic mod-in (its shape can be
    // modulated by a Mod pedal the same way the VCA envelope's can — see envModInJack).
    case "filterenv":
      return [
        { id: "cutoff-mod-out", role: "cutoff-mod-out", label: "out -> a VCF's cutoff mod in" },
        envModInJack(),
      ];
    case "filterlfo":
      return [{ id: "cutoff-mod-out", role: "cutoff-mod-out", label: "out -> a VCF's cutoff mod in" }];
    // Same pitch-mod-out as Vibrato, plus its own generic mod-in.
    case "pitchenv":
      return [
        { id: "pitch-mod-out", role: "pitch-mod-out", label: "out -> a VCO's pitch mod in" },
        envModInJack(),
      ];
    case "vibrato":
      return [{ id: "pitch-mod-out", role: "pitch-mod-out", label: "out -> a VCO's pitch mod in" }];
    // A generic modulator, not tied to one fixed destination — cable its out to any
    // envelope-shaped module's env-mod-in and pick which of that envelope's four stages
    // to sweep via this pedal's own Target control (see ModPedalModuleCard/patch.ts's
    // lfoSuffixFor). Uses Strudel's own real `.lfo({control, rate, depth, shape})`
    // modulator, not an approximation.
    case "modpedal":
      return [{ id: "env-mod-out", role: "env-mod-out", label: "out -> an envelope module's mod in" }];
    // rate-mod-in takes a Filter LFO (reused as a generic LFO here — see
    // compatibleDestinationRoles) sweeping this clock's own Rate knob live instead of it
    // sitting at one fixed speed — see patch.ts's rateModExprFor.
    case "siggen":
      return [
        { id: "gate-out", role: "gate-out", label: "out -> a Sequencer's trig in" },
        { id: "rate-mod-in", role: "rate-mod-in", label: "rate mod in <- filter LFO out" },
      ];
    // Same gate-out role as Signal gen (see effectiveSequenceFor/eosFeeding in patch.ts),
    // so it cables into any Sequencer's trig-in the same way, but with nothing to
    // configure — one fixed pulse per cycle instead of an editable 16-step row.
    case "eos":
      return [
        { id: "gate-out", role: "gate-out", label: "out -> a Sequencer's trig in (one pulse per cycle)" },
      ];
    // A submix bus — sums whatever's cabled into its audio-in (same as Output's mix bus),
    // but unlike Output it has an audio-out of its own, so several generators can share
    // one downstream ADSR/filter/FX chain before that combined signal continues on to
    // another Channel or to Output (see patch.ts's expressionAt).
    case "channel":
      return [
        { id: "audio-in", role: "audio-in", label: "audio in — sums any number of cables" },
        { id: "audio-out", role: "audio-out", label: "audio out" },
      ];
    case "output":
      return [
        { id: "audio-in", role: "audio-in", label: "audio in — the mix bus, accepts any number of cables" },
      ];
  }
}

export function jackAddress(moduleId: string, jackId: string): string {
  return `${moduleId}:${jackId}`;
}

export function moduleIdOfAddress(address: string): string {
  return address.slice(0, address.indexOf(":"));
}

/** One FM operator — superdough's `fm`/`fm2`/`fm3`/... family, an oscillator (this
 * operator's own) modulating the frequency of whatever it's chained onto. `index` at 0
 * means this operator has no effect at all, same "0 = off" convention every other
 * modulator in this rack uses — the whole operator (ratio/wave/envelope included) is
 * omitted from the generated code. Which numbered slot a given FM operator module
 * becomes is decided by its position in the audio chain, not stored here — see
 * patch.ts's expressionAt/fmOperatorParts. */
export interface FmOperatorParams extends Adsr {
  /** Modulation index — how much this operator brightens the thing it's modulating.
   * Unbounded in superdough; musically useful range is roughly 0..20. */
  index: number;
  /** The modulator's frequency as a multiple of its target's. Whole numbers give
   * harmonic (bell-like, in-tune) partials; fractional ratios give inharmonic (metallic,
   * bell/gong-like) ones. */
  ratio: number;
  /** The modulator's own waveform. Tonal only (a noise modulator wouldn't have a
   * meaningful "ratio" to what it's modulating). */
  wave: TonalWaveform;
}

/** Index at 0 (inert until turned up), a classic FM-bell decay shape ready to go the
 * moment it isn't (fast attack, a real decay down to silence, quick release) — same
 * "knob still remembers a sensible position, does nothing until patched/turned up"
 * spirit the rest of this rack uses. */
export function defaultFmOperator(): FmOperatorParams {
  return { index: 0, ratio: 1, wave: "sine", attack: 0, decay: 0.3, sustain: 0, release: 0.1 };
}

export interface VcoParams {
  waveform: Waveform;
  /** Octave shift applied to whatever note is played, -2..+2. No effect while a noise
   * waveform is selected. */
  octave: number;
  /** 0..1 — superdough's `density`, crackle's pop rate. Only read when waveform is
   * "crackle". */
  density: number;
  gain: number;
}

export interface SamplerParams {
  /** superdough's `s` control — a sample name from a loaded bank (dirt-samples/tidal-
   * drum-machines, see strudel.ts's prebake), optionally with a `:n` suffix to pick a
   * specific variant out of a multi-sample folder (e.g. "bd:3") — that's Strudel's own
   * mini-notation for sample selection, so it's just typed straight into this one field
   * rather than a separate index knob. */
  sampleName: string;
  gain: number;
}

export interface SequencerParams {
  playMode: "sequence" | "hold";
  sequence: string;
  /** Only used when playMode is "hold" — see patch.ts's noteHeadFor. */
  holdNote: string;
  holdCycles: number;
}

export interface VcfParams {
  type: FilterType;
  cutoff: number;
  resonance: number;
  drive: number;
}

export type EnvelopeParams = Adsr;

export interface FilterEnvParams extends Adsr {
  /** Envelope depth in octaves — superdough's `*env` param. 0 = no effect even if patched. */
  amount: number;
}

export interface FilterLfoParams {
  rate: number;
  depth: number;
  shape: number;
}

export interface PitchEnvParams extends Adsr {
  /** Depth in semitones — superdough's `penv`. */
  amount: number;
}

export interface VibratoParams {
  rate: number;
  depth: number;
}

export interface DelayParams {
  send: number;
  time: number;
  feedback: number;
}

export interface ReverbParams {
  room: number;
  size: number;
  lp: number;
  fade: number;
}

export interface SiggenParams {
  gates: boolean[];
  rate: number;
}

/** The waveform names Strudel's own `.lfo({shape})` accepts directly as strings (see
 * strudel.cc/learn/lfo and superdough's getModulationShapeInput, which maps each of
 * these — not just a 0..4 index — straight to a real LFO shape). "ramp" is an ascending
 * sawtooth, "saw" a descending one — Strudel's own naming, not this app's. */
export type LfoShape = "sine" | "triangle" | "ramp" | "saw" | "square";
export const LFO_SHAPES: LfoShape[] = ["sine", "triangle", "ramp", "saw", "square"];

/** Which of an envelope's four stages a Mod pedal cabled into its env-mod-in actually
 * targets — see patch.ts's lfoSuffixFor. The pedal only ever needs to know the stage in
 * the abstract; the real prefixed control name (e.g. "lpattack" vs "pattack" vs plain
 * "attack") is resolved by whichever envelope it's plugged into, not by the pedal
 * itself. */
export type ModPedalTarget = "attack" | "decay" | "sustain" | "release";
export const MOD_PEDAL_TARGETS: ModPedalTarget[] = ["attack", "decay", "sustain", "release"];

export interface ModPedalParams {
  control: ModPedalTarget;
  /** Hz — Strudel's own `.lfo({rate})`. */
  rate: number;
  /** Relative depth, same convention superdough's own `.lfo({depth})` uses: ±this
   * fraction of whatever the target stage's own flat value currently is. 0 = patched but
   * inert, same "knob still remembers its position" rule the rest of this rack follows. */
  depth: number;
  shape: LfoShape;
}

export type ModuleInstance =
  | { id: string; kind: "sequencer"; name: string; params: SequencerParams }
  | { id: string; kind: "vco"; name: string; params: VcoParams }
  | { id: string; kind: "sampler"; name: string; params: SamplerParams }
  | { id: string; kind: "vcf"; name: string; params: VcfParams }
  | { id: string; kind: "envelope"; name: string; params: EnvelopeParams }
  | { id: string; kind: "filterenv"; name: string; params: FilterEnvParams }
  | { id: string; kind: "filterlfo"; name: string; params: FilterLfoParams }
  | { id: string; kind: "pitchenv"; name: string; params: PitchEnvParams }
  | { id: string; kind: "vibrato"; name: string; params: VibratoParams }
  | { id: string; kind: "fmop"; name: string; params: FmOperatorParams }
  | { id: string; kind: "delay"; name: string; params: DelayParams }
  | { id: string; kind: "reverb"; name: string; params: ReverbParams }
  | { id: string; kind: "siggen"; name: string; params: SiggenParams }
  | { id: string; kind: "eos"; name: string; params: Record<string, never> }
  | { id: string; kind: "modpedal"; name: string; params: ModPedalParams }
  | { id: string; kind: "channel"; name: string; params: Record<string, never> }
  | { id: string; kind: "output"; name: string; params: Record<string, never> };

// Overloads so `createModule("vco", ...)` narrows to the vco branch instead of the whole
// ModuleInstance union — lets callers (presets.ts's factory racks especially) write
// `vco.params.waveform = ...` straight off the return value instead of casting.
export function createModule(
  kind: "sequencer",
  id: string,
  name: string,
): Extract<ModuleInstance, { kind: "sequencer" }>;
export function createModule(kind: "vco", id: string, name: string): Extract<ModuleInstance, { kind: "vco" }>;
export function createModule(
  kind: "sampler",
  id: string,
  name: string,
): Extract<ModuleInstance, { kind: "sampler" }>;
export function createModule(kind: "vcf", id: string, name: string): Extract<ModuleInstance, { kind: "vcf" }>;
export function createModule(
  kind: "envelope",
  id: string,
  name: string,
): Extract<ModuleInstance, { kind: "envelope" }>;
export function createModule(
  kind: "filterenv",
  id: string,
  name: string,
): Extract<ModuleInstance, { kind: "filterenv" }>;
export function createModule(
  kind: "filterlfo",
  id: string,
  name: string,
): Extract<ModuleInstance, { kind: "filterlfo" }>;
export function createModule(
  kind: "pitchenv",
  id: string,
  name: string,
): Extract<ModuleInstance, { kind: "pitchenv" }>;
export function createModule(
  kind: "vibrato",
  id: string,
  name: string,
): Extract<ModuleInstance, { kind: "vibrato" }>;
export function createModule(
  kind: "fmop",
  id: string,
  name: string,
): Extract<ModuleInstance, { kind: "fmop" }>;
export function createModule(
  kind: "delay",
  id: string,
  name: string,
): Extract<ModuleInstance, { kind: "delay" }>;
export function createModule(
  kind: "reverb",
  id: string,
  name: string,
): Extract<ModuleInstance, { kind: "reverb" }>;
export function createModule(
  kind: "siggen",
  id: string,
  name: string,
): Extract<ModuleInstance, { kind: "siggen" }>;
export function createModule(kind: "eos", id: string, name: string): Extract<ModuleInstance, { kind: "eos" }>;
export function createModule(
  kind: "modpedal",
  id: string,
  name: string,
): Extract<ModuleInstance, { kind: "modpedal" }>;
export function createModule(
  kind: "channel",
  id: string,
  name: string,
): Extract<ModuleInstance, { kind: "channel" }>;
export function createModule(
  kind: "output",
  id: string,
  name: string,
): Extract<ModuleInstance, { kind: "output" }>;
// A trailing generic overload for callers (App.tsx's addModule) that only have a plain
// `ModuleKind` at hand, not one of the literal kinds above.
export function createModule(kind: ModuleKind, id: string, name: string): ModuleInstance;
export function createModule(kind: ModuleKind, id: string, name: string): ModuleInstance {
  switch (kind) {
    case "sequencer":
      return {
        id,
        kind,
        name,
        params: { playMode: "sequence", sequence: "c e g c5", holdNote: "c3", holdCycles: 16 },
      };
    case "vco":
      return {
        id,
        kind,
        name,
        params: { waveform: "sawtooth", octave: 0, density: DEFAULT_DENSITY, gain: 0.8 },
      };
    case "sampler":
      return { id, kind, name, params: { sampleName: "bd", gain: 0.8 } };
    case "vcf":
      return { id, kind, name, params: { type: "lpf", cutoff: 1200, resonance: 6, drive: 0 } };
    case "envelope":
      return { id, kind, name, params: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.3 } };
    case "filterenv":
      return { id, kind, name, params: { attack: 0.02, decay: 0.25, sustain: 0.3, release: 0.2, amount: 2 } };
    case "filterlfo":
      return { id, kind, name, params: { rate: 4, depth: 0.5, shape: 0 } };
    case "pitchenv":
      return { id, kind, name, params: { attack: 0, decay: 0.1, sustain: 0, release: 0.05, amount: -12 } };
    case "vibrato":
      return { id, kind, name, params: { rate: 5, depth: 0.5 } };
    case "fmop":
      return { id, kind, name, params: defaultFmOperator() };
    case "delay":
      return { id, kind, name, params: { send: 0.35, time: 0.375, feedback: 0.4 } };
    case "reverb":
      return { id, kind, name, params: { room: 0.3, size: 2, lp: 8000, fade: 1.5 } };
    case "siggen":
      return { id, kind, name, params: { gates: defaultGates(), rate: 1 } };
    case "eos":
      return { id, kind, name, params: {} };
    case "modpedal":
      return { id, kind, name, params: { control: "attack", rate: 2, depth: 0.3, shape: "sine" } };
    case "channel":
      return { id, kind, name, params: {} };
    case "output":
      return { id, kind, name, params: {} };
  }
}
