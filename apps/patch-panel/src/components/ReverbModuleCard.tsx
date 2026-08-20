import { Knob } from "./Knob";
import { Jack } from "../PatchBay";
import { ModuleHeader } from "./ModuleHeader";
import { jackAddress, jackCapacity, type ModuleInstance } from "../modules";

type ReverbInstance = Extract<ModuleInstance, { kind: "reverb" }>;

interface ReverbModuleCardProps {
  module: ReverbInstance;
  onChange: (params: ReverbInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

/** A reverb send, inline in the audio path — at Room=0 no reverb node gets created at all
 * (see patch.ts), so Size/LP/Fade do nothing until Room is above zero, same "send knob is
 * the on/off switch" rule Delay follows. */
export function ReverbModuleCard({ module, onChange, onNameChange, onRemove }: ReverbModuleCardProps) {
  const p = module.params;
  const set = (patch: Partial<ReverbInstance["params"]>) => onChange({ ...p, ...patch });
  return (
    <section className="panel module-card">
      <ModuleHeader kindLabel="Reverb" name={module.name} onNameChange={onNameChange} colorId={module.id} onRemove={onRemove} />
      <div className="knob-row">
        <div className="jack-slot">
          <Jack address={jackAddress(module.id, "audio-in")} role="audio-in" capacity={jackCapacity("reverb", "audio-in")} label="audio in" />
          <span className="jack-label">in</span>
        </div>
        <Knob label="Room" value={p.room} min={0} max={1} step={0.01} onChange={(room) => set({ room })} />
        <Knob label="Size" value={p.size} min={0.1} max={8} step={0.1} onChange={(size) => set({ size })} />
        <Knob label="LP" value={p.lp} min={200} max={15000} step={100} unit="Hz" precision={0} onChange={(lp) => set({ lp })} />
        <Knob label="Fade" value={p.fade} min={0.1} max={10} step={0.1} unit="s" onChange={(fade) => set({ fade })} />
        <div className="jack-slot">
          <Jack address={jackAddress(module.id, "audio-out")} role="audio-out" capacity={jackCapacity("reverb", "audio-out")} label="audio out" />
          <span className="jack-label">out</span>
        </div>
      </div>
    </section>
  );
}
