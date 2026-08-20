import { cableKey } from "./cables";
import { createModule, jackAddress, type ModuleInstance } from "./modules";

// Racks are a per-browser design surface, not room-shared state (unlike sample banks/
// tracks) — saving one here is closer to "my synth presets" than anything the room needs
// to sync. localStorage is enough; nothing here goes through the gateway.
const STORAGE_KEY = "strudel-point:patch-panel:presets";

export interface Rack {
  modules: ModuleInstance[];
  cables: string[];
}

export interface Preset {
  name: string;
  rack: Rack;
}

export function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function savePreset(name: string, rack: Rack): Preset[] {
  const presets = loadPresets().filter((p) => p.name !== name);
  presets.push({ name, rack });
  presets.sort((a, b) => a.name.localeCompare(b.name));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  return presets;
}

export function deletePreset(name: string): Preset[] {
  const presets = loadPresets().filter((p) => p.name !== name);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  return presets;
}

/** The simplest possible complete voice — VCO straight through a VCF and a VCA envelope
 * into Output — used both as the very first rack a fresh browser sees and as the "init"
 * factory preset. No Sequencer here: with nothing cabled into its unified "in" jack, the VCO just
 * plays its own bare sound source (see patch.ts's voiceExpression) — a Sequencer only
 * enters the picture once you actually add one and cable it in. */
export function defaultRack(): Rack {
  const vco = createModule("vco", "m-vco", "VCO 1");
  const vcf = createModule("vcf", "m-vcf", "VCF 1");
  const env = createModule("envelope", "m-env", "Envelope 1");
  const output = createModule("output", "m-output", "Output");
  return {
    modules: [vco, vcf, env, output],
    cables: [
      cableKey(jackAddress(vco.id, "audio-out"), jackAddress(vcf.id, "audio-in")),
      cableKey(jackAddress(vcf.id, "audio-out"), jackAddress(env.id, "audio-in")),
      cableKey(jackAddress(env.id, "audio-out"), jackAddress(output.id, "audio-in")),
    ],
  };
}

/** A couple of starting-point racks so the panel isn't a blank slate on first load — the
 * bare-minimum default chain, one that shows off cabling a filter envelope *and* LFO onto
 * the same VCF plus a pitch envelope onto the VCO (both fed into a single audio chain,
 * same as a real modular wobble-bass patch), and one that shows a Delay feeding into a
 * Reverb in series — patched in that order so the delay's repeats get caught in the
 * reverb's tail, the kind of ordering choice only a free-patch rack (not a fixed effects
 * order) actually lets you make. */
export function factoryPresets(): Preset[] {
  const wobble = (() => {
    const vco = createModule("vco", "m-vco", "VCO 1");
    vco.params.waveform = "sawtooth";
    vco.params.octave = -1;
    const vcf = createModule("vcf", "m-vcf", "VCF 1");
    vcf.params.cutoff = 400;
    vcf.params.resonance = 14;
    vcf.params.drive = 0.6;
    const fenv = createModule("filterenv", "m-fenv", "Filter env 1");
    fenv.params.attack = 0.01;
    fenv.params.decay = 0.4;
    fenv.params.sustain = 0.2;
    fenv.params.amount = 3;
    const flfo = createModule("filterlfo", "m-flfo", "Filter LFO 1");
    flfo.params.rate = 4;
    flfo.params.depth = 0.6;
    flfo.params.shape = 0.3;
    const penv = createModule("pitchenv", "m-penv", "Pitch env 1");
    penv.params.decay = 0.08;
    penv.params.amount = -12;
    const env = createModule("envelope", "m-env", "Envelope 1");
    env.params.attack = 0.005;
    env.params.decay = 0.3;
    env.params.sustain = 0.7;
    env.params.release = 0.2;
    const output = createModule("output", "m-output", "Output");
    return {
      modules: [vco, vcf, fenv, flfo, penv, env, output],
      cables: [
        cableKey(jackAddress(vco.id, "audio-out"), jackAddress(vcf.id, "audio-in")),
        cableKey(jackAddress(vcf.id, "audio-out"), jackAddress(env.id, "audio-in")),
        cableKey(jackAddress(env.id, "audio-out"), jackAddress(output.id, "audio-in")),
        cableKey(jackAddress(fenv.id, "cutoff-mod-out"), jackAddress(vcf.id, "cutoff-mod-in")),
        cableKey(jackAddress(flfo.id, "cutoff-mod-out"), jackAddress(vcf.id, "cutoff-mod-in")),
        cableKey(jackAddress(penv.id, "pitch-mod-out"), jackAddress(vco.id, "in")),
      ],
    };
  })();

  const dub = (() => {
    const vco = createModule("vco", "m-vco", "VCO 1");
    vco.params.waveform = "sine";
    const env = createModule("envelope", "m-env", "Envelope 1");
    env.params.attack = 0.002;
    env.params.decay = 0.15;
    env.params.sustain = 0;
    env.params.release = 0.1;
    const delay = createModule("delay", "m-delay", "Delay 1");
    delay.params.send = 0.55;
    delay.params.time = 0.45;
    delay.params.feedback = 0.6;
    const reverb = createModule("reverb", "m-reverb", "Reverb 1");
    reverb.params.room = 0.15;
    reverb.params.size = 3;
    reverb.params.lp = 6000;
    reverb.params.fade = 2;
    const output = createModule("output", "m-output", "Output");
    return {
      modules: [vco, env, delay, reverb, output],
      cables: [
        cableKey(jackAddress(vco.id, "audio-out"), jackAddress(env.id, "audio-in")),
        cableKey(jackAddress(env.id, "audio-out"), jackAddress(delay.id, "audio-in")),
        cableKey(jackAddress(delay.id, "audio-out"), jackAddress(reverb.id, "audio-in")),
        cableKey(jackAddress(reverb.id, "audio-out"), jackAddress(output.id, "audio-in")),
      ],
    };
  })();

  return [
    { name: "init", rack: defaultRack() },
    { name: "wobble bass", rack: wobble },
    { name: "dub delay", rack: dub },
  ];
}
