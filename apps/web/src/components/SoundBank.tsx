import { useCallback, useMemo, useState } from "react";
import { getSampleBufferForName } from "../strudel";
import { analyzeLoopSeam, type LoopSeamAnalysis } from "../audio/loopSeam";
import { setSoundDragData } from "../sampleDnd";

export interface SoundBankEntry {
  name: string;
  type: string;
}

interface SoundBankProps {
  sounds: SoundBankEntry[];
  /** Clicking the name auditions the sound in place — doesn't touch the editor or the loop. */
  onPreview: (name: string) => void;
  /** The "add" button inserts the name into the editor at the cursor. */
  onAdd: (name: string) => void;
}

type SeamState = "checking" | "not-sample-based" | { error: string } | LoopSeamAnalysis;

function isAnalysis(state: SeamState | undefined): state is LoopSeamAnalysis {
  return typeof state === "object" && state !== null && "seamless" in state;
}

function seamLabel(state: SeamState | undefined): string {
  if (!state) return "loop check";
  if (state === "checking") return "checking…";
  if (state === "not-sample-based") return "n/a";
  if (!isAnalysis(state)) return "error";
  if (state.seamless) return "✓ seamless";
  const trim = state.trimToZeroCrossing;
  return trim == null ? "⚠ clicks" : `⚠ trim ${(trim * 1000).toFixed(0)}ms`;
}

function seamTitle(name: string, state: SeamState | undefined): string {
  if (!state) return `check whether "${name}" loops without a click`;
  if (state === "checking") return "decoding + analyzing…";
  if (state === "not-sample-based") return "synths/wavetables don't have a fixed buffer to seam-check";
  if (!isAnalysis(state)) return state.error;
  return state.seamless
    ? `seam jump ${state.seamJump.toFixed(4)} — below the audible threshold, loops cleanly as-is`
    : `seam jump ${state.seamJump.toFixed(4)} — will click when looped` +
        (state.trimToZeroCrossing != null
          ? `; nearest clean cut is ${(state.trimToZeroCrossing * 1000).toFixed(0)}ms in from the end`
          : "; no clean zero-crossing found nearby");
}

/**
 * Browsable list of every sound Strudel currently has registered — built from the real
 * runtime registry (`soundMap`), not a hardcoded guess, so it's always accurate to
 * whatever sample packs actually got loaded (see App.tsx's getStrudel()).
 */
export function SoundBank({ sounds, onPreview, onAdd }: SoundBankProps) {
  const [query, setQuery] = useState("");
  // Lazily computed per name — decoding every sound up front would mean fetching/decoding
  // all 900+ dirt-samples just to render the list, so this only runs when someone actually
  // asks "will this click?" for a given sound.
  const [seams, setSeams] = useState<Map<string, SeamState>>(new Map());

  const checkSeam = useCallback(async (name: string) => {
    setSeams((prev) => new Map(prev).set(name, "checking"));
    try {
      const buffer = await getSampleBufferForName(name);
      setSeams((prev) =>
        new Map(prev).set(name, buffer ? analyzeLoopSeam(buffer) : "not-sample-based"),
      );
    } catch (err) {
      setSeams((prev) =>
        new Map(prev).set(name, { error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? sounds.filter((s) => s.name.toLowerCase().includes(q)) : sounds;
    return list.slice(0, 200); // keep the DOM light; dirt-samples alone is 900+ names
  }, [sounds, query]);

  return (
    <div className="sound-bank">
      <input
        className="sound-bank-search"
        placeholder={`search ${sounds.length} sounds…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="sound-bank-list">
        {sounds.length === 0 && (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>loading sounds…</p>
        )}
        {filtered.map((s) => {
          const seam = seams.get(s.name);
          return (
            <div
              key={s.name}
              className="sound-chip"
              title={s.type}
              onDoubleClick={() => onAdd(s.name)}
              draggable
              onDragStart={(e) => setSoundDragData(e, { name: s.name, label: s.name })}
            >
              <button
                className="sound-chip-name"
                onClick={() => onPreview(s.name)}
                aria-label={`preview ${s.name}`}
                title={`click to preview, double-click to add ${s.name} to the loop`}
              >
                {s.name}
              </button>
              <button
                className={
                  "sound-chip-seam" + (isAnalysis(seam) ? (seam.seamless ? " seamless" : " clicks") : "")
                }
                onClick={() => checkSeam(s.name)}
                disabled={seam === "checking"}
                aria-label={`check whether ${s.name} loops seamlessly`}
                title={seamTitle(s.name, seam)}
              >
                {seamLabel(seam)}
              </button>
              <button
                className="sound-chip-add"
                onClick={() => onAdd(s.name)}
                aria-label={`add ${s.name} to the loop`}
                title={`add ${s.name} to the loop`}
              >
                add
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
