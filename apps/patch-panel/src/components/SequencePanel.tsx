import { Jack } from "../PatchBay";
import { jackCapacity } from "../modules";

// No on-screen keyboard here (that's a future app) — mini-notation is the tool for
// writing notes/arpeggios/chords without one. These are just ready-made examples of what
// it can already do, inserted straight into the Sequence field below: an arpeggio is just
// a fast sequence of chord tones (up/down/up-down), `[c,e,g]` stacks notes into a
// simultaneous chord instead of a sequence, and `(3,8)` is Strudel's euclidean-rhythm
// syntax applied to a single note.
const SEQUENCE_PRESETS: { label: string; pattern: string }[] = [
  { label: "up arp", pattern: "c e g c5" },
  { label: "down arp", pattern: "c5 g e c" },
  { label: "up-down arp", pattern: "c e g c5 g e" },
  { label: "chord stab", pattern: "[c,e,g]" },
  { label: "euclid pulse", pattern: "c(3,8)" },
];

interface SequencePanelProps {
  playMode: "sequence" | "hold";
  onPlayModeChange: (mode: "sequence" | "hold") => void;
  sequence: string;
  onSequenceChange: (sequence: string) => void;
  /** True while a Signal gen module's cable is feeding this Sequencer's gate-in — the
   * sequence field shows that module's derived pattern read-only rather than free text,
   * same as a real clock module driving a sequencer overriding whatever was dialed in by
   * hand (see patch.ts's effectiveSequenceFor, which is what actually decides this at
   * codegen time — this prop just mirrors that decision for display). */
  sequenceIsGated: boolean;
  holdNote: string;
  onHoldNoteChange: (note: string) => void;
  holdCycles: number;
  onHoldCyclesChange: (cycles: number) => void;
  /** This Sequencer's own trig-in jack — see modules.ts's "sequencer" jacksFor. */
  gateInAddress: string;
}

/**
 * A Sequencer module's own note source — this is where "what pattern does this module
 * produce" lives, its whole reason to exist, not a fixed part of the app shell. It owns
 * nothing about what the rest of the chain does with what it produces (see
 * SequencerModuleCard, which cables this module's note-out into some VCO/Sampler's unified
 * "in" jack); this
 * panel only ever reads and writes the sequence/hold-mode/hold-note/hold-cycles values its
 * caller hands it.
 *
 * Two note sources, one active at a time: "sequence" free-types mini-notation (with the
 * preset chips below as ready-made starting points); "hold" holds a single note open so
 * the modules cabled after whichever VCO this feeds can be shaped live while it sounds
 * (see patch.ts's noteHeadFor's `.slow(holdCycles)`). The trig-in jack is a third
 * source layered on top of whichever of these is showing — see modules.ts's siggen kind,
 * whose gate-out overrides `sequence` once patched rather than replacing this panel's own
 * inputs.
 */
export function SequencePanel({
  playMode,
  onPlayModeChange,
  sequence,
  onSequenceChange,
  sequenceIsGated,
  holdNote,
  onHoldNoteChange,
  holdCycles,
  onHoldCyclesChange,
  gateInAddress,
}: SequencePanelProps) {
  return (
    <div className="sequencer-body">
      <div className="sequence-heading">
        <div className="mode-toggle" role="group" aria-label="play mode">
          <button
            type="button"
            className={`secondary${playMode === "sequence" ? " active" : ""}`}
            onClick={() => onPlayModeChange("sequence")}
          >
            sequence
          </button>
          <button
            type="button"
            className={`secondary${playMode === "hold" ? " active" : ""}`}
            onClick={() => onPlayModeChange("hold")}
            title="hold one note open and shape it live with whatever's cabled after this VCO, instead of composing a sequence"
          >
            hold note
          </button>
        </div>
        <div className="jack-slot">
          <Jack address={gateInAddress} role="gate-in" capacity={jackCapacity("sequencer", "gate-in")} label="trig in <- a signal gen's out" />
          <span className="jack-label">trig in</span>
        </div>
      </div>
      {playMode === "sequence" ? (
        <>
          <div className="sequence-row">
            <input
              className="sequence-input"
              value={sequence}
              onChange={(e) => onSequenceChange(e.target.value)}
              placeholder='mini-notation, e.g. "c e g c5" or "<c e g>*4"'
              spellCheck={false}
              readOnly={sequenceIsGated}
              title={sequenceIsGated ? "driven by a patched signal gen — unplug its cable to type your own" : undefined}
            />
          </div>
          {!sequenceIsGated && (
            <div className="sequence-presets">
              {SEQUENCE_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="secondary"
                  onClick={() => onSequenceChange(preset.pattern)}
                  title={preset.pattern}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="sequence-row">
          <input
            className="hold-note-input"
            value={holdNote}
            onChange={(e) => onHoldNoteChange(e.target.value)}
            placeholder="note, e.g. c3"
            spellCheck={false}
          />
          <label className="hold-cycles-label">
            hold (cycles)
            <input
              type="number"
              className="hold-cycles-input"
              min={1}
              value={holdCycles}
              onChange={(e) => onHoldCyclesChange(Number(e.target.value) || 1)}
            />
          </label>
        </div>
      )}
    </div>
  );
}
