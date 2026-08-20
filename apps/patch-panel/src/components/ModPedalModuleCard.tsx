import { Knob } from "./Knob";
import { Jack } from "../PatchBay";
import { ModuleHeader } from "./ModuleHeader";
import { jackAddress, LFO_SHAPES, MOD_PEDAL_TARGETS, type ModuleInstance } from "../modules";

type ModPedalInstance = Extract<ModuleInstance, { kind: "modpedal" }>;

interface ModPedalModuleCardProps {
  module: ModPedalInstance;
  onChange: (params: ModPedalInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

/** A generic modulator, not wired to one fixed destination the way Filter env/Filter
 * LFO/Pitch env/Vibrato are — cable its out to *any* envelope-shaped module's env-mod-in
 * (VCA envelope, Filter env, Pitch env) and pick which one of that envelope's four ADSR
 * stages to sweep with the Target buttons below. Generates Strudel's own real
 * `.lfo({control, rate, depth, shape})` modulator (see strudel.cc/learn/lfo) chained
 * right after that stage's own flat value — not an approximation built out of continuous
 * signal patterns — so Depth is relative to whatever that stage's own knob is currently
 * set to, same convention superdough's `.lfo({depth})` itself uses. Rate/Depth at 0 (or
 * nothing cabled at all) leaves that stage untouched, same "knob still remembers its
 * position but does nothing until it's actually connected" rule the rest of this rack
 * follows.
 *
 * You can drop more than one Mod pedal onto the same envelope's env-mod-in (it's a
 * passive summing input, same as cutoff/pitch-mod-in) — each one only ever touches
 * whichever single stage its own Target picks, so cable a few in to sweep Attack, Decay,
 * and Release independently at once. */
export function ModPedalModuleCard({ module, onChange, onNameChange, onRemove }: ModPedalModuleCardProps) {
  const p = module.params;
  const set = (patch: Partial<ModPedalInstance["params"]>) => onChange({ ...p, ...patch });
  return (
    <section className="panel module-card">
      <ModuleHeader kindLabel="Mod pedal" name={module.name} onNameChange={onNameChange} colorId={module.id} onRemove={onRemove} />
      <div className="knob-row">
        <div className="waveform-select">
          <span className="knob-label">Target</span>
          <div className="waveform-buttons">
            {MOD_PEDAL_TARGETS.map((target) => (
              <button
                key={target}
                type="button"
                className={target === p.control ? "toggle-active" : "secondary"}
                onClick={() => set({ control: target })}
                title={target}
              >
                {target[0].toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <Knob label="Rate" value={p.rate} min={0} max={20} step={0.05} unit="Hz" onChange={(rate) => set({ rate })} />
        <Knob label="Depth" value={p.depth} min={0} max={1} step={0.01} onChange={(depth) => set({ depth })} />
        <div className="waveform-select">
          <span className="knob-label">Shape</span>
          <div className="waveform-buttons">
            {LFO_SHAPES.map((shape) => (
              <button
                key={shape}
                type="button"
                className={shape === p.shape ? "toggle-active" : "secondary"}
                onClick={() => set({ shape })}
                title={shape}
              >
                {shapeGlyph(shape)}
              </button>
            ))}
          </div>
        </div>
        <div className="jack-slot">
          <Jack address={jackAddress(module.id, "env-mod-out")} role="env-mod-out" capacity={Infinity} label="out -> an envelope module's mod in" />
          <span className="jack-label">out</span>
        </div>
      </div>
    </section>
  );
}

function shapeGlyph(shape: string): string {
  switch (shape) {
    case "sine":
      return "∿";
    case "triangle":
      return "△";
    case "ramp":
      return "⩗";
    case "saw":
      return "⩘";
    case "square":
      return "⊓";
    default:
      return shape;
  }
}
