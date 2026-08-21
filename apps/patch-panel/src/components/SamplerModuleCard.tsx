import { getSoundDragData } from "@strudel-point/library";
import { jackAddress, jackCapacity, type ModuleInstance } from "../modules";
import { Jack } from "../PatchBay";
import { Knob } from "./Knob";
import { ModuleHeader } from "./ModuleHeader";

type SamplerInstance = Extract<ModuleInstance, { kind: "sampler" }>;

interface SamplerModuleCardProps {
  module: SamplerInstance;
  onChange: (params: SamplerInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

// A handful of names already loaded by strudel.ts's prebake (dirt-samples/tidal-drum-
// machines) so the field isn't a guessing game on first use — same "ready-made starting
// points" role SequencePanel's mini-notation chips play. `name:n` picks a specific
// variant out of a multi-sample folder (Strudel's own sample-selection syntax, typed
// straight into the one field below — see patch.ts's sourceName).
const SAMPLE_PRESETS = ["bd", "sn", "hh", "cp", "oh", "rim", "casio", "jvbass"];

/** A voice's sound source, sibling to VcoModuleCard — same one unified input jack
 * (accepts any combination of a Sequencer's note pattern, a Signal gen/EOS wired
 * straight in for a plain rhythm — see patch.ts's directGatePatternFor — and a Pitch
 * env/Vibrato, which resample the buffer up/down the same way they'd bend an
 * oscillator's pitch) as a VCO, just playing a named sample instead of an oscillator
 * waveform (see patch.ts's sourceName/voiceExpression, which treat the two kinds
 * identically past this one field). Nothing here plays anything on its own until its
 * audio-out is cabled all the way to the master Output (see patch.ts's expressionAt) —
 * dropping a bare Sampler into the rack is silent, same as an unpatched VCO.
 *
 * The Sample field also accepts a drop from the library tray (see App.tsx's
 * <LibraryTray>/@strudel-point/library's getSoundDragData) — drag any registered sound,
 * built-in pack or this room's own upload, straight onto it instead of typing the name. */
export function SamplerModuleCard({ module, onChange, onNameChange, onRemove }: SamplerModuleCardProps) {
  const p = module.params;
  const set = (patch: Partial<SamplerInstance["params"]>) => onChange({ ...p, ...patch });
  return (
    <section className="panel module-card">
      <ModuleHeader
        kindLabel="Sampler"
        name={module.name}
        onNameChange={onNameChange}
        colorId={module.id}
        onRemove={onRemove}
      />
      <div className="knob-row">
        <div
          className="sampler-name"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const dragged = getSoundDragData(e);
            if (dragged) set({ sampleName: dragged.name });
          }}
        >
          <span className="knob-label">Sample</span>
          <input
            className="sampler-name-input"
            value={p.sampleName}
            onChange={(e) => set({ sampleName: e.target.value })}
            placeholder="bd"
            spellCheck={false}
            title='a loaded sample bank name, optionally "name:n" to pick a variant — or drag one in from the library tray'
          />
        </div>
        <Knob label="Gain" value={p.gain} min={0} max={1.5} step={0.01} onChange={(gain) => set({ gain })} />
        <div className="jack-slot">
          <Jack
            address={jackAddress(module.id, "in")}
            role="vco-in"
            capacity={jackCapacity("sampler", "vco-in")}
            label="in <- sequencer note / signal gen or EOS gate / pitch env or vibrato"
          />
          <span className="jack-label">in</span>
        </div>
        <div className="jack-slot">
          <Jack
            address={jackAddress(module.id, "audio-out")}
            role="audio-out"
            capacity={jackCapacity("sampler", "audio-out")}
            label="audio out"
          />
          <span className="jack-label">out</span>
        </div>
      </div>
      <div className="sequence-presets">
        {SAMPLE_PRESETS.map((name) => (
          <button
            key={name}
            type="button"
            className="secondary"
            onClick={() => set({ sampleName: name })}
            title={name}
          >
            {name}
          </button>
        ))}
      </div>
    </section>
  );
}
