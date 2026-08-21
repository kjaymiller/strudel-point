import { jackAddress, jackCapacity, type ModuleInstance } from "../modules";
import { EnvelopePanel } from "./EnvelopePanel";
import { ModuleHeader } from "./ModuleHeader";

type EnvelopeInstance = Extract<ModuleInstance, { kind: "envelope" }>;

interface EnvelopeModuleCardProps {
  module: EnvelopeInstance;
  onChange: (params: EnvelopeInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

/** The VCA — inline in the audio path (audio in/out), shaping whatever passes through it
 * with a standard attack/decay/sustain/release envelope. This is the module that makes a
 * VCO's raw tone actually start and stop instead of playing as one endless drone. */
export function EnvelopeModuleCard({ module, onChange, onNameChange, onRemove }: EnvelopeModuleCardProps) {
  return (
    <section className="panel module-card">
      <ModuleHeader
        kindLabel="Envelope (VCA)"
        name={module.name}
        onNameChange={onNameChange}
        colorId={module.id}
        onRemove={onRemove}
      />
      <EnvelopePanel
        moduleId={module.id}
        envelope={module.params}
        onChange={onChange}
        audioJacks={{
          inAddress: jackAddress(module.id, "audio-in"),
          inCapacity: jackCapacity("envelope", "audio-in"),
          outAddress: jackAddress(module.id, "audio-out"),
          outCapacity: jackCapacity("envelope", "audio-out"),
        }}
      />
    </section>
  );
}
