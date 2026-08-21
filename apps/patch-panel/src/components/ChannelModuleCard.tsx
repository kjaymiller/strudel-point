import { jackAddress, jackCapacity, type ModuleInstance } from "../modules";
import { Jack } from "../PatchBay";
import { ModuleHeader } from "./ModuleHeader";

type ChannelInstance = Extract<ModuleInstance, { kind: "channel" }>;

interface ChannelModuleCardProps {
  module: ChannelInstance;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

/** A submix bus — no knobs of its own, just a mix bus you can put more processing after.
 * Cable several VCOs' (or other Channels') audio-out into this one audio-in and they sum
 * into a single signal, same as Output's mix bus; unlike Output, this one has its own
 * audio-out, so whatever comes next (an Envelope, a Delay, another Channel...) shapes
 * every generator feeding this bus at once instead of needing its own copy per
 * generator. Channels can feed other Channels — nesting is fine, same as sub-groups
 * feeding a master bus on a real mixing desk (see patch.ts's expressionAt, which walks
 * that graph regardless of how many bus levels deep it goes). */
export function ChannelModuleCard({ module, onNameChange, onRemove }: ChannelModuleCardProps) {
  return (
    <section className="panel module-card">
      <ModuleHeader
        kindLabel="Channel"
        name={module.name}
        onNameChange={onNameChange}
        colorId={module.id}
        onRemove={onRemove}
      />
      <div className="knob-row">
        <div className="jack-slot">
          <Jack
            address={jackAddress(module.id, "audio-in")}
            role="audio-in"
            capacity={jackCapacity("channel", "audio-in")}
            label="audio in — sums any number of cables"
          />
          <span className="jack-label">in</span>
        </div>
        <div className="jack-slot">
          <Jack
            address={jackAddress(module.id, "audio-out")}
            role="audio-out"
            capacity={jackCapacity("channel", "audio-out")}
            label="audio out"
          />
          <span className="jack-label">out</span>
        </div>
      </div>
    </section>
  );
}
