import { Knob } from "./Knob";
import { Jack } from "../PatchBay";
import { ModuleHeader } from "./ModuleHeader";
import { waveformGlyph } from "./VcoModuleCard";
import { jackAddress, jackCapacity, TONAL_WAVEFORMS, type ModuleInstance } from "../modules";

type FmOpInstance = Extract<ModuleInstance, { kind: "fmop" }>;

interface FmOpModuleCardProps {
  module: FmOpInstance;
  onChange: (params: FmOpInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

/** One FM operator — an oscillator modulating the frequency of whatever this module's
 * audio-out eventually reaches, superdough's `fm`/`fm2`/`fm3`/... family
 * (https://strudel.cc/learn/synths/#fm-synthesis). Inline in the audio path like any
 * other processing module, not fixed to sitting right on the VCO: chain several of these
 * in series (VCO -> FM op -> FM op -> ... -> Output) to build a multi-operator stack, the
 * one closest to the voice source becoming superdough's `fm`/`fmh`/... (modulating the
 * carrier directly), the next one out becoming `fm2`/`fmh2`/... (modulating that first
 * operator), and so on — see patch.ts's expressionAt/fmOperatorParts, which assigns each
 * module's numbered slot by its own position in the chain. Index at 0 is this module's
 * on/off switch: ratio/wave/envelope are all omitted from the generated code, same "0 =
 * no effect, cable it in for free" rule every other modulator in this rack follows — an
 * FM op module dropped into the rack but left at its default changes nothing. */
export function FmOpModuleCard({ module, onChange, onNameChange, onRemove }: FmOpModuleCardProps) {
  const p = module.params;
  const set = (patch: Partial<FmOpInstance["params"]>) => onChange({ ...p, ...patch });
  return (
    <section className="panel module-card">
      <ModuleHeader kindLabel="FM operator" name={module.name} onNameChange={onNameChange} colorId={module.id} onRemove={onRemove} />
      <div className="knob-row">
        <Knob label="Index" value={p.index} min={0} max={20} step={0.1} onChange={(index) => set({ index })} />
        <Knob label="Ratio" value={p.ratio} min={0.25} max={8} step={0.25} onChange={(ratio) => set({ ratio })} />
        <div className="waveform-select">
          <span className="knob-label">Wave</span>
          <div className="waveform-buttons">
            {TONAL_WAVEFORMS.map((w) => (
              <button
                key={w}
                type="button"
                className={w === p.wave ? "toggle-active" : "secondary"}
                onClick={() => set({ wave: w })}
                title={w}
              >
                {waveformGlyph(w)}
              </button>
            ))}
          </div>
        </div>
        <Knob label="Attack" value={p.attack} min={0} max={2} step={0.01} unit="s" onChange={(attack) => set({ attack })} />
        <Knob label="Decay" value={p.decay} min={0} max={2} step={0.01} unit="s" onChange={(decay) => set({ decay })} />
        <Knob label="Sustain" value={p.sustain} min={0} max={1} step={0.01} onChange={(sustain) => set({ sustain })} />
        <Knob label="Release" value={p.release} min={0} max={2} step={0.01} unit="s" onChange={(release) => set({ release })} />
        <div className="jack-slot">
          <Jack address={jackAddress(module.id, "audio-in")} role="audio-in" capacity={jackCapacity("fmop", "audio-in")} label="audio in" />
          <span className="jack-label">in</span>
        </div>
        <div className="jack-slot">
          <Jack address={jackAddress(module.id, "audio-out")} role="audio-out" capacity={jackCapacity("fmop", "audio-out")} label="audio out" />
          <span className="jack-label">out</span>
        </div>
      </div>
    </section>
  );
}
