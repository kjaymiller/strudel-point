import { Knob } from "./Knob";
import { Jack } from "../PatchBay";
import { ModuleHeader } from "./ModuleHeader";
import { jackAddress, jackCapacity, type ModuleInstance } from "../modules";

type DelayInstance = Extract<ModuleInstance, { kind: "delay" }>;

interface DelayModuleCardProps {
  module: DelayInstance;
  onChange: (params: DelayInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

/** A repeat/echo send, inline in the audio path — at Send=0 no delay node gets created at
 * all (see patch.ts), so Time/Feedback do nothing until Send is above zero, the "send knob
 * is the on/off switch" rule this app's effects use. Short Time (<0.1s) reads as a
 * doubling/slapback; longer Time reads as a distinct rhythmic echo. Where you cable this
 * relative to a Reverb module matters now — patched before it, the repeats get caught in
 * that reverb's tail; patched after, they stay dry (see patch.ts's appendModuleChain). */
export function DelayModuleCard({ module, onChange, onNameChange, onRemove }: DelayModuleCardProps) {
  const p = module.params;
  const set = (patch: Partial<DelayInstance["params"]>) => onChange({ ...p, ...patch });
  return (
    <section className="panel module-card">
      <ModuleHeader kindLabel="Delay" name={module.name} onNameChange={onNameChange} colorId={module.id} onRemove={onRemove} />
      <div className="knob-row">
        <div className="jack-slot">
          <Jack address={jackAddress(module.id, "audio-in")} role="audio-in" capacity={jackCapacity("delay", "audio-in")} label="audio in" />
          <span className="jack-label">in</span>
        </div>
        <Knob label="Send" value={p.send} min={0} max={1} step={0.01} onChange={(send) => set({ send })} />
        <Knob label="Time" value={p.time} min={0.02} max={2} step={0.01} unit="s" onChange={(time) => set({ time })} />
        <Knob label="Feedback" value={p.feedback} min={0} max={0.98} step={0.01} onChange={(feedback) => set({ feedback })} />
        <div className="jack-slot">
          <Jack address={jackAddress(module.id, "audio-out")} role="audio-out" capacity={jackCapacity("delay", "audio-out")} label="audio out" />
          <span className="jack-label">out</span>
        </div>
      </div>
    </section>
  );
}
