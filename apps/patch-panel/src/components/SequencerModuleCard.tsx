import { Jack } from "../PatchBay";
import { ModuleHeader } from "./ModuleHeader";
import { SequencePanel } from "./SequencePanel";
import { jackAddress, jackCapacity, type ModuleInstance } from "../modules";

type SequencerInstance = Extract<ModuleInstance, { kind: "sequencer" }>;

interface SequencerModuleCardProps {
  module: SequencerInstance;
  onChange: (params: SequencerInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
  /** See patch.ts's effectiveSequenceFor — computed by App.tsx from the live cable graph,
   * since only it knows whether some Signal gen module is actually feeding this
   * Sequencer right now. */
  sequenceIsGated: boolean;
  effectiveSequence: string;
}

/** A note source, cabled into a VCO's unified "in" jack to actually drive what it plays (see
 * VcoModuleCard/patch.ts's effectiveVoiceBase — an unpatched VCO just plays a plain
 * default pattern instead). Splitting this out from the VCO means one Sequencer can be
 * repatched between VCOs, and a VCO can be swapped for a different note source, without
 * either dragging the other's own knobs along with it — the same "each stage is its own
 * module" rule this whole rack follows elsewhere. */
export function SequencerModuleCard({
  module,
  onChange,
  onNameChange,
  onRemove,
  sequenceIsGated,
  effectiveSequence,
}: SequencerModuleCardProps) {
  const p = module.params;
  const set = (patch: Partial<SequencerInstance["params"]>) => onChange({ ...p, ...patch });
  return (
    <section className="panel module-card">
      <ModuleHeader kindLabel="Sequencer" name={module.name} onNameChange={onNameChange} colorId={module.id} onRemove={onRemove} />
      <SequencePanel
        playMode={p.playMode}
        onPlayModeChange={(playMode) => set({ playMode })}
        sequence={effectiveSequence}
        onSequenceChange={(sequence) => set({ sequence })}
        sequenceIsGated={sequenceIsGated}
        holdNote={p.holdNote}
        onHoldNoteChange={(holdNote) => set({ holdNote })}
        holdCycles={p.holdCycles}
        onHoldCyclesChange={(holdCycles) => set({ holdCycles })}
        gateInAddress={jackAddress(module.id, "gate-in")}
      />
      <div className="jack-slot sequencer-out-jack">
        <Jack
          address={jackAddress(module.id, "note-out")}
          role="note-out"
          capacity={jackCapacity("sequencer", "note-out")}
          label="out -> a VCO's note in"
        />
        <span className="jack-label">out</span>
      </div>
    </section>
  );
}
