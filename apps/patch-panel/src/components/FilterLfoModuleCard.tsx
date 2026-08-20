import { Knob } from "./Knob";
import { Jack } from "../PatchBay";
import { ModuleHeader } from "./ModuleHeader";
import { jackAddress, jackCapacity, type ModuleInstance } from "../modules";

type FilterLfoInstance = Extract<ModuleInstance, { kind: "filterlfo" }>;

interface FilterLfoModuleCardProps {
  module: FilterLfoInstance;
  onChange: (params: FilterLfoInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

/** A CV LFO for filter cutoff — cable its out to any VCF's cutoff-mod-in for a wobble/
 * wah. Rate and Depth both have to be above zero for it to have any effect (superdough's
 * `*rate`/`*depth`), same "patched but inert at zero" rule Filter env follows. */
export function FilterLfoModuleCard({ module, onChange, onNameChange, onRemove }: FilterLfoModuleCardProps) {
  const p = module.params;
  const set = (patch: Partial<FilterLfoInstance["params"]>) => onChange({ ...p, ...patch });
  return (
    <section className="panel module-card">
      <ModuleHeader kindLabel="Filter LFO" name={module.name} onNameChange={onNameChange} colorId={module.id} onRemove={onRemove} />
      <div className="knob-row">
        <Knob label="Rate" value={p.rate} min={0} max={20} step={0.05} unit="Hz" onChange={(rate) => set({ rate })} />
        <Knob label="Depth" value={p.depth} min={0} max={1} step={0.01} onChange={(depth) => set({ depth })} />
        <Knob label="Shape" value={p.shape} min={0} max={1} step={0.01} onChange={(shape) => set({ shape })} />
        <div className="jack-slot">
          <Jack
            address={jackAddress(module.id, "cutoff-mod-out")}
            role="cutoff-mod-out"
            capacity={jackCapacity("filterlfo", "cutoff-mod-out")}
            label="out -> a VCF's cutoff mod in"
          />
          <span className="jack-label">out</span>
        </div>
      </div>
    </section>
  );
}
