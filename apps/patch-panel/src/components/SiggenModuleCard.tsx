import { useEffect, useRef, useState } from "react";
import { Knob } from "./Knob";
import { Jack } from "../PatchBay";
import { ModuleHeader } from "./ModuleHeader";
import { getStrudelIfReady } from "../strudel";
import { BASE_STEP_MS, STEP_COUNT } from "../sequencer";
import { jackAddress, jackCapacity, type ModuleInstance } from "../modules";

type SiggenInstance = Extract<ModuleInstance, { kind: "siggen" }>;

interface SiggenModuleCardProps {
  module: SiggenInstance;
  onChange: (params: SiggenInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

/** A clock/gate generator: click a step to toggle it on/off, that's the whole interaction
 * — no pitch, no note entry (see sequencer.ts for why). Cable its out to a Sequencer's
 * trig-in to gate that Sequencer's typed pattern (see patch.ts's effectiveSequenceFor),
 * or straight to a VCO/Sampler's own trig-in to skip the Sequencer entirely for a plain
 * rhythm (see patch.ts's directGatePatternFor) — its gate-out fans out freely (see
 * modules.ts's jackCapacity), so one Signal gen can clock as many destinations at once as
 * you cable into it, all locked to the exact same pattern; a rack can also hold as many
 * Signal gens as you want, each free to clock a different voice.
 *
 * rate-mod-in takes a Filter LFO cabled in to sweep the Rate knob live instead of it
 * sitting at one fixed speed (see patch.ts's rateModExprFor) — real continuous
 * modulation in the generated code, same as an LFO sweeping a VCF's cutoff. The step
 * light below is still just a decorative preview of the *unmodulated* base rate (see this
 * app's existing "no way to read the room's actual live cps" caveat) — it doesn't chase
 * the live sweep, only the actual generated pattern does.
 *
 * The step light runs off its own always-on loop, started on mount and never gated by
 * whether "play in room" has been pressed — a signal generator free-runs by definition;
 * it doesn't wait for the rest of the patch to be listening. Once Strudel has actually
 * initialized, the light phase-locks to the real scheduler clock instead of guessing at
 * one off a plain timer, so it stays in sync with whatever's actually playing rather than
 * just matching rate. */
export function SiggenModuleCard({ module, onChange, onNameChange, onRemove }: SiggenModuleCardProps) {
  const { gates, rate } = module.params;
  const [currentStep, setCurrentStep] = useState(0);
  const rateRef = useRef(rate);
  rateRef.current = rate;

  useEffect(() => {
    let raf: number;
    let lastStep = -1;
    const fallbackStart = performance.now();

    const tick = () => {
      let stepPosition: number | null = null;
      const strudel = getStrudelIfReady();
      if (strudel) {
        try {
          stepPosition = strudel.getTime() * STEP_COUNT * rateRef.current;
        } catch {
          stepPosition = null;
        }
      }
      if (stepPosition === null) {
        const elapsedMs = performance.now() - fallbackStart;
        stepPosition = elapsedMs / (BASE_STEP_MS / rateRef.current);
      }
      const step = ((Math.floor(stepPosition) % STEP_COUNT) + STEP_COUNT) % STEP_COUNT;
      if (step !== lastStep) {
        lastStep = step;
        setCurrentStep(step);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const toggle = (i: number) => {
    const next = gates.slice();
    next[i] = !next[i];
    onChange({ gates: next, rate });
  };

  return (
    <section className="panel module-card signalgen-panel">
      <ModuleHeader kindLabel="Signal gen" name={module.name} onNameChange={onNameChange} colorId={module.id} onRemove={onRemove} />
      <div className="signalgen-header">
        <Knob label="Rate" value={rate} min={0.25} max={4} step={0.25} unit="x" onChange={(r) => onChange({ gates, rate: r })} />
        <button
          type="button"
          className="secondary"
          onClick={() => onChange({ gates: Array.from({ length: STEP_COUNT }, () => false), rate })}
        >
          clear
        </button>
        <div className="jack-slot">
          <Jack
            address={jackAddress(module.id, "rate-mod-in")}
            role="rate-mod-in"
            capacity={jackCapacity("siggen", "rate-mod-in")}
            label="rate mod in <- filter LFO out"
          />
          <span className="jack-label">rate in</span>
        </div>
        <div className="jack-slot">
          <Jack
            address={jackAddress(module.id, "gate-out")}
            role="gate-out"
            capacity={jackCapacity("siggen", "gate-out")}
            label="out -> a Sequencer's or a VCO/Sampler's trig in"
          />
          <span className="jack-label">out</span>
        </div>
      </div>
      <div className="gate-row">
        {gates.map((on, i) => (
          <button
            key={i}
            type="button"
            className={`gate${on ? " on" : ""}${currentStep === i ? " current" : ""}`}
            onClick={() => toggle(i)}
            aria-pressed={on}
            title={`step ${i + 1}`}
          />
        ))}
      </div>
    </section>
  );
}
