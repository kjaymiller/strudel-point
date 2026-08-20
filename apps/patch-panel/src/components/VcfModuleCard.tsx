import { Knob } from "./Knob";
import { Jack } from "../PatchBay";
import { ModuleHeader } from "./ModuleHeader";
import { FILTER_TYPES, jackAddress, jackCapacity, type ModuleInstance } from "../modules";

type VcfInstance = Extract<ModuleInstance, { kind: "vcf" }>;

interface VcfModuleCardProps {
  module: VcfInstance;
  onChange: (params: VcfInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

/** superdough gives every filter type (lpf/hpf/bpf) an identical envelope/LFO shape under
 * a per-type control prefix (see patch.ts's FILTER_PREFIX), so switching type here just
 * changes which prefix whatever's cabled into cutoff-mod-in gets written under — a Filter
 * env or Filter LFO module doesn't need to know or care which filter type it's feeding. */
export function VcfModuleCard({ module, onChange, onNameChange, onRemove }: VcfModuleCardProps) {
  const p = module.params;
  const set = (patch: Partial<VcfInstance["params"]>) => onChange({ ...p, ...patch });
  return (
    <section className="panel module-card">
      <ModuleHeader kindLabel="VCF" name={module.name} onNameChange={onNameChange} colorId={module.id} onRemove={onRemove} />
      <div className="knob-row">
        <div className="jack-slot">
          <Jack address={jackAddress(module.id, "audio-in")} role="audio-in" capacity={jackCapacity("vcf", "audio-in")} label="audio in" />
          <span className="jack-label">in</span>
        </div>
        <div className="waveform-select">
          <span className="knob-label">Type</span>
          <div className="waveform-buttons">
            {FILTER_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className={t === p.type ? "toggle-active" : "secondary"}
                onClick={() => set({ type: t })}
              >
                {t.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <Knob label="Cutoff" value={p.cutoff} min={20} max={12000} step={10} unit="Hz" precision={0} onChange={(cutoff) => set({ cutoff })} />
        <Knob label="Resonance" value={p.resonance} min={0} max={30} step={0.1} onChange={(resonance) => set({ resonance })} />
        <Knob label="Drive" value={p.drive} min={0} max={4} step={0.05} onChange={(drive) => set({ drive })} />
        <div className="jack-slot">
          <Jack
            address={jackAddress(module.id, "cutoff-mod-in")}
            role="cutoff-mod-in"
            capacity={jackCapacity("vcf", "cutoff-mod-in")}
            label="cutoff mod in <- filter env / LFO out"
          />
          <span className="jack-label">cutoff mod</span>
        </div>
        <div className="jack-slot">
          <Jack address={jackAddress(module.id, "audio-out")} role="audio-out" capacity={jackCapacity("vcf", "audio-out")} label="audio out" />
          <span className="jack-label">out</span>
        </div>
      </div>
    </section>
  );
}
