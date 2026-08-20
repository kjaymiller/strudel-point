import { Knob } from "./Knob";
import { Jack } from "../PatchBay";
import { ModuleHeader } from "./ModuleHeader";
import { jackAddress, jackCapacity, type ModuleInstance } from "../modules";

type VibratoInstance = Extract<ModuleInstance, { kind: "vibrato" }>;

interface VibratoModuleCardProps {
  module: VibratoInstance;
  onChange: (params: VibratoInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

/** A CV LFO for pitch — cable its out to any VCO/Sampler's unified input jack for vibrato (superdough's
 * `vib`/`vibmod`). Rate has to be above zero to have any effect. */
export function VibratoModuleCard({ module, onChange, onNameChange, onRemove }: VibratoModuleCardProps) {
  const p = module.params;
  const set = (patch: Partial<VibratoInstance["params"]>) => onChange({ ...p, ...patch });
  return (
    <section className="panel module-card">
      <ModuleHeader kindLabel="Vibrato" name={module.name} onNameChange={onNameChange} colorId={module.id} onRemove={onRemove} />
      <div className="knob-row">
        <Knob label="Rate" value={p.rate} min={0} max={20} step={0.05} unit="Hz" onChange={(rate) => set({ rate })} />
        <Knob label="Depth" value={p.depth} min={0} max={2} step={0.01} onChange={(depth) => set({ depth })} />
        <div className="jack-slot">
          <Jack
            address={jackAddress(module.id, "pitch-mod-out")}
            role="pitch-mod-out"
            capacity={jackCapacity("vibrato", "pitch-mod-out")}
            label="out -> a VCO's pitch mod in"
          />
          <span className="jack-label">out</span>
        </div>
      </div>
    </section>
  );
}
