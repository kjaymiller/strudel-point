import { Knob } from "./Knob";
import { EnvelopePanel } from "./EnvelopePanel";
import { ModuleHeader } from "./ModuleHeader";
import { jackAddress, jackCapacity, type ModuleInstance } from "../modules";

type PitchEnvInstance = Extract<ModuleInstance, { kind: "pitchenv" }>;

interface PitchEnvModuleCardProps {
  module: PitchEnvInstance;
  onChange: (params: PitchEnvInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

/** A CV envelope generator for pitch — cable its out to any VCO/Sampler's unified input jack for a
 * classic "blip" pitch drop on drums/plucks (superdough's `penv`, in semitones; 0 =
 * patched but inert). */
export function PitchEnvModuleCard({ module, onChange, onNameChange, onRemove }: PitchEnvModuleCardProps) {
  const p = module.params;
  return (
    <section className="panel module-card">
      <ModuleHeader kindLabel="Pitch env" name={module.name} onNameChange={onNameChange} colorId={module.id} onRemove={onRemove} />
      <EnvelopePanel
        moduleId={module.id}
        envelope={p}
        onChange={(env) => onChange({ ...env, amount: p.amount })}
        extra={
          <Knob label="Amount" value={p.amount} min={-48} max={48} step={1} unit="st" onChange={(amount) => onChange({ ...p, amount })} />
        }
        cvOutJack={{
          address: jackAddress(module.id, "pitch-mod-out"),
          role: "pitch-mod-out",
          capacity: jackCapacity("pitchenv", "pitch-mod-out"),
          label: "out -> a VCO's pitch mod in",
        }}
      />
    </section>
  );
}
