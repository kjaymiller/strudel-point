import { jackAddress, jackCapacity, type ModuleInstance } from "../modules";
import { EnvelopePanel } from "./EnvelopePanel";
import { Knob } from "./Knob";
import { ModuleHeader } from "./ModuleHeader";

type FilterEnvInstance = Extract<ModuleInstance, { kind: "filterenv" }>;

interface FilterEnvModuleCardProps {
  module: FilterEnvInstance;
  onChange: (params: FilterEnvInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

/** A CV envelope generator, not an audio module — cable its out to any VCF's cutoff-mod-
 * in to make that filter sweep open/closed over the shape below (superdough's `*env`
 * depth, in octaves; 0 = patched but inert, same "knob still remembers its position but
 * does nothing until it's actually doing something" rule the rest of this rack follows). */
export function FilterEnvModuleCard({ module, onChange, onNameChange, onRemove }: FilterEnvModuleCardProps) {
  const p = module.params;
  return (
    <section className="panel module-card">
      <ModuleHeader
        kindLabel="Filter env"
        name={module.name}
        onNameChange={onNameChange}
        colorId={module.id}
        onRemove={onRemove}
      />
      <EnvelopePanel
        moduleId={module.id}
        envelope={p}
        onChange={(env) => onChange({ ...env, amount: p.amount })}
        extra={
          <Knob
            label="Amount"
            value={p.amount}
            min={-8}
            max={8}
            step={0.1}
            unit="oct"
            onChange={(amount) => onChange({ ...p, amount })}
          />
        }
        cvOutJack={{
          address: jackAddress(module.id, "cutoff-mod-out"),
          role: "cutoff-mod-out",
          capacity: jackCapacity("filterenv", "cutoff-mod-out"),
          label: "out -> a VCF's cutoff mod in",
        }}
      />
    </section>
  );
}
