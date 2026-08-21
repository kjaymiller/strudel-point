import { jackAddress, jackCapacity, type ModuleInstance } from "../modules";
import { Jack } from "../PatchBay";
import { PanelColorSwatch } from "./PanelColorSwatch";

type OutputInstance = Extract<ModuleInstance, { kind: "output" }>;

/** The master mix bus — a singleton, always present, never removable. Every VCO's audio
 * chain has to actually reach this jack to be heard at all (see patch.ts's expressionAt);
 * unlike every other audio-in in this rack, this one accepts any number of cables at
 * once, since summing everything cabled into it is the whole point of a master output. */
export function OutputModuleCard({ module }: { module: OutputInstance }) {
  return (
    <section className="panel module-card output-module-card">
      <div className="module-header">
        <span className="module-name-input module-name-static">{module.name}</span>
        <span className="module-kind-label">Output</span>
        <PanelColorSwatch panelId={module.id} />
      </div>
      <div className="knob-row">
        <div className="jack-slot">
          <Jack
            address={jackAddress(module.id, "audio-in")}
            role="audio-in"
            capacity={jackCapacity("output", "audio-in")}
            label="audio in — the mix bus"
          />
          <span className="jack-label">in</span>
        </div>
      </div>
    </section>
  );
}
