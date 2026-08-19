import type { DeckConfig } from "../chain";
import { Knob } from "./Knob";

export interface TrackOption {
  id: string;
  title: string;
}

interface FxKnobProps {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  format?: (v: number) => string;
  disabled: boolean;
  onChange: (v: number) => void;
  /** Omitted for lfo/duck depth — those just follow their rate knob's toggle, no toggle
   * of their own. */
  toggle?: { enabled: boolean; disabled: boolean; onToggle: () => void; title: string };
}

/** One filter/mod knob: an optional enable toggle above it, the knob itself, then its
 * label and current value below — grid-aligned against its neighbors (see .deck-fx-grid)
 * rather than laid out as a label-left row like speed/gain above it. */
function FxKnob({ label, unit, value, min, max, format, disabled, onChange, toggle }: FxKnobProps) {
  return (
    <div className="fx-cell">
      {toggle ? (
        <button
          className={`fx-toggle${toggle.enabled ? " active" : ""}`}
          disabled={toggle.disabled}
          onClick={toggle.onToggle}
          title={toggle.title}
        >
          {toggle.enabled ? "on" : "off"}
        </button>
      ) : (
        <span className="fx-toggle-spacer" />
      )}
      <Knob value={value} min={min} max={max} disabled={disabled} onChange={onChange} />
      <span className="fx-cell-label">{label}</span>
      <span className="deck-value">
        {format ? format(value) : value}
        {unit}
      </span>
    </div>
  );
}

interface DeckProps {
  label: string;
  deck: DeckConfig | null;
  tracks: TrackOption[];
  isMaster: boolean;
  onLoadTrack: (trackId: string) => void;
  onSetSpeed: (speed: number) => void;
  onSetGain: (gain: number) => void;
  /** One callback for all six filter/mod knobs (hpf/lpf/lfo/duck) rather than a named
   * setter per knob — they're all just fields on DeckConfig, and the caller (App.tsx)
   * already has a generic `updateDeck(which, patch)` to hand this straight to. */
  onSetFx: (patch: Partial<DeckConfig>) => void;
  onTogglePlaying: () => void;
  /** A hard, immediate stop. Different from onTogglePlaying: that one only removes this
   * deck from the *next* compiled pattern (still debounced, and even once applied,
   * doesn't retroactively silence whatever's already sounding — a long track keeps
   * ringing out on its own). This one kills whatever's audible right now, immediately,
   * at the cost of hushing the whole mix for an instant (there's no per-deck kill switch
   * in Strudel's public API) and restarting whatever else was playing right after. */
  onCut: () => void;
  onMakeMaster: () => void;
  /** Matches this deck's speed so its effective tempo (its track's own declared bpm,
   * from splitTrackCode, times speed) lines up with the room's masterBpm. */
  onSync: () => void;
}

/**
 * One deck: pick a saved Track, play it, shape it with hpf/lpf/lfo and a "duck"
 * (sidechain-style rhythmic gain dip — see chain.ts's DeckConfig for what that really
 * compiles to). dj's whole job is playing *existing* tracks — there's no waveform, no
 * bpm-guessing, no scrub here: a Track is pure Strudel source, not decoded audio, so
 * there's nothing to show or seek through, just code playing as whatever it already is.
 */
export function Deck({
  label,
  deck,
  tracks,
  isMaster,
  onLoadTrack,
  onSetSpeed,
  onSetGain,
  onSetFx,
  onTogglePlaying,
  onCut,
  onMakeMaster,
  onSync,
}: DeckProps) {
  return (
    <div className={`deck ${isMaster ? "deck--master" : ""}`}>
      <div className="deck-header">
        <h3>{label}</h3>
        <button
          className="secondary"
          disabled={isMaster}
          onClick={onMakeMaster}
          title="use this deck's track's own declared tempo as the room's master tempo"
        >
          {isMaster ? "★ master" : "make master"}
        </button>
      </div>

      <select value={deck?.trackId ?? ""} onChange={(e) => e.target.value && onLoadTrack(e.target.value)}>
        <option value="" disabled>
          pick a saved track
        </option>
        {tracks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </select>

      <p className="deck-bpm">{deck ? deck.trackTitle : "no track loaded"}</p>

      <label className="deck-row">
        <span>speed</span>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.01}
          value={deck?.speed ?? 1}
          disabled={!deck}
          onChange={(e) => onSetSpeed(Number(e.target.value))}
        />
        <span className="deck-value">{(deck?.speed ?? 1).toFixed(2)}×</span>
      </label>

      <label className="deck-row">
        <span>gain</span>
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={deck?.gain ?? 1}
          disabled={!deck}
          onChange={(e) => onSetGain(Number(e.target.value))}
        />
        <span className="deck-value">{(deck?.gain ?? 1).toFixed(2)}</span>
      </label>

      <div className="deck-fx-grid">
        <FxKnob
          label="hpf"
          unit="hz"
          value={deck?.hpf ?? 20}
          min={20}
          max={4000}
          format={(v) => String(Math.round(v))}
          disabled={!deck || !deck.hpfEnabled}
          onChange={(v) => onSetFx({ hpf: v })}
          toggle={{
            enabled: !!deck?.hpfEnabled,
            disabled: !deck,
            onToggle: () => onSetFx({ hpfEnabled: !deck?.hpfEnabled }),
            title: deck?.hpfEnabled ? "hpf on — click to bypass" : "hpf bypassed — click to enable",
          }}
        />

        <FxKnob
          label="lpf"
          unit="hz"
          value={deck?.lpf ?? 20000}
          min={200}
          max={20000}
          format={(v) => String(Math.round(v))}
          disabled={!deck || !deck.lpfEnabled}
          onChange={(v) => onSetFx({ lpf: v })}
          toggle={{
            enabled: !!deck?.lpfEnabled,
            disabled: !deck,
            onToggle: () => onSetFx({ lpfEnabled: !deck?.lpfEnabled }),
            title: deck?.lpfEnabled ? "lpf on — click to bypass" : "lpf bypassed — click to enable",
          }}
        />

        <FxKnob
          label="lfo rate"
          unit="/cyc"
          value={deck?.lfoRate ?? 1}
          min={0.05}
          max={8}
          format={(v) => v.toFixed(2)}
          disabled={!deck || !deck.lfoEnabled}
          onChange={(v) => onSetFx({ lfoRate: v })}
          toggle={{
            enabled: !!deck?.lfoEnabled,
            disabled: !deck || !deck.lpfEnabled,
            onToggle: () => onSetFx({ lfoEnabled: !deck?.lfoEnabled }),
            title: !deck?.lpfEnabled
              ? "lfo sweeps the lpf cutoff — turn lpf on first"
              : deck?.lfoEnabled
                ? "lfo on — click to disable"
                : "lfo disabled — click to enable",
          }}
        />

        <FxKnob
          label="duck rate"
          unit="/cyc"
          value={deck?.duckRate ?? 8}
          min={0.5}
          max={32}
          format={(v) => v.toFixed(1)}
          disabled={!deck || !deck.duckEnabled}
          onChange={(v) => onSetFx({ duckRate: v })}
          toggle={{
            enabled: !!deck?.duckEnabled,
            disabled: !deck,
            onToggle: () => onSetFx({ duckEnabled: !deck?.duckEnabled }),
            title: deck?.duckEnabled
              ? "sidechain duck on — click to disable"
              : "sidechain duck disabled — click to enable",
          }}
        />

        <span className="fx-cell-blank" />
        <span className="fx-cell-blank" />

        <FxKnob
          label="lfo depth"
          unit="%"
          value={deck?.lfoDepth ?? 0}
          min={0}
          max={1}
          format={(v) => String(Math.round(v * 100))}
          disabled={!deck || !deck.lfoEnabled}
          onChange={(v) => onSetFx({ lfoDepth: v })}
        />

        <FxKnob
          label="duck depth"
          unit="%"
          value={deck?.duckDepth ?? 0}
          min={0}
          max={1}
          format={(v) => String(Math.round(v * 100))}
          disabled={!deck || !deck.duckEnabled}
          onChange={(v) => onSetFx({ duckDepth: v })}
        />
      </div>

      {!isMaster && deck && (
        <button className="secondary" onClick={onSync} title="match this deck's speed to the master tempo">
          sync
        </button>
      )}

      <div className="deck-transport">
        <button disabled={!deck} onClick={onTogglePlaying} className={deck?.playing ? "" : "secondary"}>
          {deck?.playing ? "■ stop" : "▶ play"}
        </button>
        <button
          disabled={!deck}
          onClick={onCut}
          className="deck-cut"
          title="hard, immediate stop — see this file's onCut doc comment"
        >
          ✕ cut
        </button>
      </div>
    </div>
  );
}
