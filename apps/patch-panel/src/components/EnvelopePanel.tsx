import type { ReactNode } from "react";
import { Knob } from "./Knob";
import { Jack } from "../PatchBay";
import { jackAddress, type Adsr, type JackRole } from "../modules";

interface EnvelopePanelProps {
  /** Every ADSR-shaped module's own id — used to compute this envelope's one generic
   * "env-mod-in" jack address (see modules.ts's envModInJack/JackRole doc comment and
   * patch.ts's lfoSuffixFor). */
  moduleId: string;
  envelope: Adsr;
  onChange: (envelope: Adsr) => void;
  /** Extra knob(s) rendered before the ADSR stage (e.g. a CV envelope's "amount") — this
   * component is reused for the VCA envelope (no amount knob) and the filter/pitch
   * envelope modules (which do have one), so the caller supplies whatever's extra. */
  extra?: ReactNode;
  /** A CV envelope module (filter/pitch env) has one output jack carrying its ADSR
   * shape as modulation. Mutually exclusive with `audioJacks` below — a given envelope
   * module is wired one way or the other depending on which module kind it is. */
  cvOutJack?: { address: string; role: JackRole; capacity: number; label: string };
  /** The VCA envelope module is inline in the audio path instead — it shapes whatever
   * signal passes through it, so it gets an audio in *and* out instead of a single CV
   * output. */
  audioJacks?: { inAddress: string; inCapacity: number; outAddress: string; outCapacity: number };
}

/** A standard four-stage attack/decay/sustain/release envelope editor — reused for the
 * VCA envelope module (audio in/out) and the filter/pitch envelope modules (a single CV
 * output plus an "amount" knob), since superdough gives all three the identical
 * attack/decay/sustain/release shape under different control-name prefixes (see
 * patch.ts). One generic env-mod-in jack (not per-stage — see ModPedalModuleCard/
 * patch.ts's lfoSuffixFor) accepts any number of Mod pedals, each picking which one of
 * these four stages it sweeps via its own Target control. */
export function EnvelopePanel({ moduleId, envelope, onChange, extra, cvOutJack, audioJacks }: EnvelopePanelProps) {
  const set = (patch: Partial<Adsr>) => onChange({ ...envelope, ...patch });
  return (
    <div className="knob-row">
      {audioJacks && (
        <div className="jack-slot">
          <Jack address={audioJacks.inAddress} role="audio-in" capacity={audioJacks.inCapacity} label="audio in" />
          <span className="jack-label">in</span>
        </div>
      )}
      {extra}
      <Knob label="Attack" value={envelope.attack} min={0} max={2} step={0.005} unit="s" onChange={(attack) => set({ attack })} />
      <Knob label="Decay" value={envelope.decay} min={0} max={2} step={0.005} unit="s" onChange={(decay) => set({ decay })} />
      <Knob label="Sustain" value={envelope.sustain} min={0} max={1} step={0.01} onChange={(sustain) => set({ sustain })} />
      <Knob label="Release" value={envelope.release} min={0} max={4} step={0.005} unit="s" onChange={(release) => set({ release })} />
      <div className="jack-slot">
        <Jack
          address={jackAddress(moduleId, "env-mod-in")}
          role={"env-mod-in" as JackRole}
          capacity={Infinity}
          label="mod in <- Mod pedal out (targets whichever stage its own Target picks)"
        />
        <span className="jack-label">mod in</span>
      </div>
      {cvOutJack && (
        <div className="jack-slot">
          <Jack address={cvOutJack.address} role={cvOutJack.role} capacity={cvOutJack.capacity} label={cvOutJack.label} />
          <span className="jack-label">out</span>
        </div>
      )}
      {audioJacks && (
        <div className="jack-slot">
          <Jack address={audioJacks.outAddress} role="audio-out" capacity={audioJacks.outCapacity} label="audio out" />
          <span className="jack-label">out</span>
        </div>
      )}
    </div>
  );
}
