// A clock/gate signal generator — deliberately not a melodic step sequencer. Every step
// gets an equal clock tick; a step is either gated on (fires the patch) or off (a rest).
// There's no pitch/note selection here at all — that's a different tool's job (see
// App.tsx's Sequence field for typing actual note patterns, or a future dedicated
// keyboard app). Every gated step here just triggers the same reference note, so this is
// purely a rhythm/trigger source: think "clock module", not "sequencer with pitch bars".

export const STEP_COUNT = 16;
/** The single note every gated step (and an EOS module's single pulse, see eosPattern
 * below) triggers — see the module comment above. */
export const GATE_NOTE = "c3";

// A real signal generator's defining trait is that it free-runs continuously — it isn't
// something that only ticks while the rest of the patch happens to be playing. The step
// light in components/SignalGen.tsx is driven by its own always-on timer for exactly that
// reason (see that file), not by whether audio is currently evaluating. This is the
// timer's base tick length at rate=1 (one full 16-step cycle every 2s, matching Strudel's
// own default cps of 0.5) — an approximation, since the visual clock has no way to read
// the room's actual live cps, but it's consistent regardless of whether anything's playing.
export const BASE_STEP_MS = 125;

/** Seeded with a basic quarter-note pulse (every 4th of 16 steps) so the generator isn't
 * silent the first time you open the app — same idea as presets.ts's factory presets. */
export function defaultGates(): boolean[] {
  return Array.from({ length: STEP_COUNT }, (_, i) => i % 4 === 0);
}

export function clearedGates(): boolean[] {
  return Array.from({ length: STEP_COUNT }, () => false);
}

/** One mini-notation token per step: the gate note when on, "~" (a rest) when off. */
export function gatesToPattern(gates: boolean[]): string {
  return gates.map((on) => (on ? GATE_NOTE : "~")).join(" ");
}

/** Wraps the gate pattern with mini-notation's own `*rate` speed operator when rate !== 1
 * — a clock rate/division control without any change to patch.ts's codegen: rate=2 runs
 * the whole 16-step row twice per cycle (faster clock), rate=0.5 half as often. */
export function gatesToSequenceText(gates: boolean[], rate: number): string {
  const pattern = gatesToPattern(gates);
  return rate === 1 ? pattern : `[${pattern}]*${rate}`;
}

/** An EOS (end-of-sequence/cycle) module's whole output: one trigger, once per cycle —
 * no rate, no per-step editing, nothing to configure. Just `GATE_NOTE` on its own: a bare
 * note with no rhythmic subdivision plays once per cycle by definition, same as any other
 * one-hit-per-cycle pattern in this app (e.g. an unpatched VCO's bare `s(...)`). */
export function eosPattern(): string {
  return GATE_NOTE;
}
