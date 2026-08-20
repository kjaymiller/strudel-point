import { Knob } from "./Knob";
import { Jack } from "../PatchBay";
import { ModuleHeader } from "./ModuleHeader";
import { jackAddress, jackCapacity, WAVEFORMS, type ModuleInstance } from "../modules";

type VcoInstance = Extract<ModuleInstance, { kind: "vco" }>;

interface VcoModuleCardProps {
  module: VcoInstance;
  onChange: (params: VcoInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

/** A voice's sound source — waveform (tonal or one of the four noise types), octave,
 * gain, crackle density — plus one unified input jack that accepts any combination of a
 * Sequencer module's note pattern, a Signal gen/EOS module wired straight in for a plain
 * rhythm with nothing to type (skipping the Sequencer entirely — see patch.ts's
 * directGatePatternFor; ignored whenever a Sequencer's own pattern is also cabled in,
 * since that always wins), and a Pitch env/Vibrato module's pitch modulation — one
 * physical jack rather than three, same as a real synth's single CV/gate input strip
 * that just does the right thing based on what's actually plugged in. A VCO with nothing
 * cabled in plays a bare, one-hit-per-cycle default (see patch.ts's voiceExpression).
 * Nothing here plays anything on its own until its audio-out is cabled all the way to
 * the master Output (see patch.ts's expressionAt) — dropping a bare VCO into the rack is
 * silent, same as an unpatched oscillator on a real modular rig.
 *
 * FM is its own module now (see FmOpModuleCard), cabled in-line in the audio path like
 * any other processing module — chain one or more after this VCO's audio-out to build up
 * a multi-operator FM stack, same as Strudel's own `.fm()`/`.fmh()`/etc being ordinary
 * chainable controls rather than something fixed to the oscillator's own definition (see
 * https://strudel.cc/learn/synths/#fm-synthesis). */
export function VcoModuleCard({ module, onChange, onNameChange, onRemove }: VcoModuleCardProps) {
  const p = module.params;
  const set = (patch: Partial<VcoInstance["params"]>) => onChange({ ...p, ...patch });
  return (
    <section className="panel module-card">
      <ModuleHeader kindLabel="VCO" name={module.name} onNameChange={onNameChange} colorId={module.id} onRemove={onRemove} />
      <div className="knob-row">
        <div className="waveform-select">
          <span className="knob-label">Wave</span>
          <div className="waveform-buttons">
            {WAVEFORMS.map((w) => (
              <button
                key={w}
                type="button"
                className={w === p.waveform ? "toggle-active" : "secondary"}
                onClick={() => set({ waveform: w })}
                title={w}
              >
                {waveformGlyph(w)}
              </button>
            ))}
          </div>
        </div>
        <Knob label="Octave" value={p.octave} min={-2} max={2} step={1} onChange={(octave) => set({ octave })} />
        <Knob label="Gain" value={p.gain} min={0} max={1.5} step={0.01} onChange={(gain) => set({ gain })} />
        <Knob label="Density" value={p.density} min={0.001} max={1} step={0.001} onChange={(density) => set({ density })} />
        <div className="jack-slot">
          <Jack
            address={jackAddress(module.id, "in")}
            role="vco-in"
            capacity={jackCapacity("vco", "vco-in")}
            label="in <- sequencer note / signal gen or EOS gate / pitch env or vibrato"
          />
          <span className="jack-label">in</span>
        </div>
        <div className="jack-slot">
          <Jack address={jackAddress(module.id, "audio-out")} role="audio-out" capacity={jackCapacity("vco", "audio-out")} label="audio out" />
          <span className="jack-label">out</span>
        </div>
      </div>
    </section>
  );
}

export function waveformGlyph(w: string): string {
  switch (w) {
    case "sine":
      return "∿";
    case "triangle":
      return "△";
    case "sawtooth":
      return "⩘";
    case "square":
      return "⊓";
    case "white":
      return "W";
    case "pink":
      return "P";
    case "brown":
      return "B";
    case "crackle":
      return "⁘";
    default:
      return w;
  }
}
