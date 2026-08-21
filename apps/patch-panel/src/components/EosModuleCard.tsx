import { useEffect, useRef, useState } from "react";
import { jackAddress, jackCapacity, type ModuleInstance } from "../modules";
import { Jack } from "../PatchBay";
import { getStrudelIfReady } from "../strudel";
import { ModuleHeader } from "./ModuleHeader";

type EosInstance = Extract<ModuleInstance, { kind: "eos" }>;

interface EosModuleCardProps {
  module: EosInstance;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

/** An EOS (end-of-sequence/cycle) trigger: fires one pulse per cycle, nothing to
 * configure — no rate, no per-step grid, just a fixed downbeat. Cable its out to a
 * Sequencer's gate-in and that Sequencer plays the EOS pulse instead of its own typed
 * sequence (see patch.ts's effectiveSequenceFor/eosFeeding), or straight to a VCO/
 * Sampler's own gate-in to skip the Sequencer entirely (see directGatePatternFor) —
 * same relationship a Signal gen has, just simpler: think "once-per-cycle master reset/
 * downbeat pulse" rather than a programmable clock. Same jack role (gate-out) as Signal
 * gen, so it's interchangeable — cable this in instead when you want a plain downbeat
 * rather than a pattern to edit.
 *
 * The pulse light is phase-locked the same way Signal gen's step light is (see
 * SiggenModuleCard) — the real scheduler clock (getTime()) once Strudel has initialized,
 * a wall-clock approximation before that so it isn't inert on first load. */
export function EosModuleCard({ module, onNameChange, onRemove }: EosModuleCardProps) {
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    let raf: number;
    let lastCycle = -1;
    const fallbackStart = performance.now();
    // Wall-clock fallback assumes the same base tempo the rest of this app does
    // (Strudel's own default cps of 0.5, i.e. one cycle every 2s) — see sequencer.ts's
    // BASE_STEP_MS comment for the equivalent reasoning on Signal gen's fallback.
    const FALLBACK_CYCLE_MS = 2000;

    const tick = () => {
      let cyclePosition: number | null = null;
      const strudel = getStrudelIfReady();
      if (strudel) {
        try {
          cyclePosition = strudel.getTime();
        } catch {
          cyclePosition = null;
        }
      }
      if (cyclePosition === null) {
        cyclePosition = (performance.now() - fallbackStart) / FALLBACK_CYCLE_MS;
      }
      const cycle = Math.floor(cyclePosition);
      if (cycle !== lastCycle) {
        lastCycle = cycle;
        setPulsing(true);
        window.setTimeout(() => setPulsing(false), 90);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <section className="panel module-card eos-panel">
      <ModuleHeader
        kindLabel="EOS trigger"
        name={module.name}
        onNameChange={onNameChange}
        colorId={module.id}
        onRemove={onRemove}
      />
      <div className="knob-row">
        <div className={`eos-pulse${pulsing ? " on" : ""}`} title="fires once per cycle" />
        <div className="jack-slot">
          <Jack
            address={jackAddress(module.id, "gate-out")}
            role="gate-out"
            capacity={jackCapacity("eos", "gate-out")}
            label="out -> a Sequencer's or a VCO/Sampler's trig in (one pulse per cycle)"
          />
          <span className="jack-label">out</span>
        </div>
      </div>
    </section>
  );
}
