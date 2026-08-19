import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CustomSample } from "@strudel-point/shared";
import {
  analyzeBeat,
  computeRangePeaks,
  decodeAudioFile,
  decodeAudioUrl,
  recomputeCuts,
  type BeatAnalysis,
} from "../audio/analyze";
import { concatAudioBuffers, sliceToFile } from "../audio/wav";
import { suggestName } from "./CustomSamples";

/** One existing sound to pull back into the editor — see `BeatAnalyzerHandle.loadFromSamples`. */
export interface EditSource {
  url: string;
  label: string;
}

export interface BeatAnalyzerHandle {
  /**
   * Loads one or more existing "my sounds" entries into the editor, in place of dropping a
   * fresh file. A single source is "re-scrub/re-chop this sample"; several are concatenated
   * (see concatAudioBuffers) end-to-end first, so "merge" is just "chop the merged result".
   */
  loadFromSamples: (sources: EditSource[]) => void;
}

interface BeatAnalyzerProps {
  /** Uploads one slice (already a "name" of its own) as part of `bankName`, at `bankIndex`. */
  onUploadSlice: (file: File, name: string, bankName: string, bankIndex: number) => Promise<CustomSample>;
  /** Renames the bank just uploaded (every slice moves to the new bankName server-side). */
  onRenameBank: (oldName: string, newName: string) => void;
}

type Stage = "idle" | "analyzing" | "ready" | "uploading" | "done";
/** How far a slice is trimmed in from its left/right edge, in seconds — independent of the
 * shared cut markers, so trimming silence off one slice doesn't move its neighbor. */
type Clip = { start: number; end: number };

const CANVAS_HEIGHT = 100;
const MIN_SLICE_SECONDS = 0.05;
const NO_CLIP: Clip = { start: 0, end: 0 };

function formatTime(sec: number): string {
  return `${sec.toFixed(2)}s`;
}

/** Boundaries (including 0 and duration) implied by the current interior cuts. */
function boundsFromCuts(cuts: number[], duration: number): number[] {
  return [0, ...cuts, duration];
}

const BANK_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function sliceKey(s: { start: number; end: number }): string {
  return `${s.start.toFixed(3)}-${s.end.toFixed(3)}`;
}

/** Slice boundaries after applying its clip-in/clip-out trim. */
function clippedRange(s: { start: number; end: number }, clip: Clip): { start: number; end: number } {
  return { start: s.start + clip.start, end: Math.max(s.start + clip.start + 0.01, s.end - clip.end) };
}

/**
 * Small waveform + two draggable trim handles for one slice — lets its start/end be nudged
 * in independent of the shared cut markers (e.g. to shave a click or a bit of silence off
 * without moving the boundary the neighboring slice also depends on).
 */
function SliceTrimmer({
  buffer,
  slice,
  clip,
  onChange,
}: {
  buffer: AudioBuffer;
  slice: { start: number; end: number };
  clip: Clip;
  onChange: (clip: Clip) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragSideRef = useRef<"start" | "end" | null>(null);
  const width = 120;
  const height = 32;
  const duration = Math.max(0.001, slice.end - slice.start);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.width = width;
    canvas.height = height;
    const { min, max } = computeRangePeaks(buffer, slice.start, slice.end, 80);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#7ee0c1";
    const mid = height / 2;
    const bucketWidth = width / min.length;
    for (let i = 0; i < min.length; i++) {
      const x = i * bucketWidth;
      const top = mid + min[i] * mid;
      const bottom = mid + max[i] * mid;
      ctx.fillRect(x, top, Math.max(1, bucketWidth), Math.max(1, bottom - top));
    }
  }, [buffer, slice.start, slice.end]);

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const side = dragSideRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!side || !rect) return;
      const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * duration;
      if (side === "start") {
        const maxStart = Math.max(0, duration - clip.end - MIN_SLICE_SECONDS);
        onChange({ ...clip, start: Math.min(maxStart, Math.max(0, t)) });
      } else {
        const fromRight = duration - t;
        const maxEnd = Math.max(0, duration - clip.start - MIN_SLICE_SECONDS);
        onChange({ ...clip, end: Math.min(maxEnd, Math.max(0, fromRight)) });
      }
    },
    [clip, duration, onChange],
  );

  const stopDrag = useCallback(() => {
    dragSideRef.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", stopDrag);
  }, [handlePointerMove]);

  const startDrag = useCallback(
    (side: "start" | "end") => {
      dragSideRef.current = side;
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopDrag);
    },
    [handlePointerMove, stopDrag],
  );

  const startPct = (clip.start / duration) * 100;
  const endPct = (clip.end / duration) * 100;

  return (
    <div ref={containerRef} style={{ position: "relative", width, height, flexShrink: 0 }}>
      <canvas ref={canvasRef} style={{ width, height, display: "block" }} />
      {clip.start > 0 && (
        <div
          style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${startPct}%`, background: "rgba(0,0,0,0.6)" }}
        />
      )}
      {clip.end > 0 && (
        <div
          style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: `${endPct}%`, background: "rgba(0,0,0,0.6)" }}
        />
      )}
      <div
        onPointerDown={(e) => {
          e.preventDefault();
          startDrag("start");
        }}
        title={`clip in ${clip.start.toFixed(2)}s`}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `${startPct}%`,
          width: 5,
          marginLeft: -2,
          background: "#e6e6ea",
          cursor: "ew-resize",
        }}
      />
      <div
        onPointerDown={(e) => {
          e.preventDefault();
          startDrag("end");
        }}
        title={`clip out ${clip.end.toFixed(2)}s`}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          right: `${endPct}%`,
          width: 5,
          marginLeft: -2,
          background: "#e6e6ea",
          cursor: "ew-resize",
        }}
      />
    </div>
  );
}

/**
 * Drop a "beat" in — or pull one or more existing "my sounds" entries back in via
 * `loadFromSamples` (CustomSamples' "scrub/chop" and "merge" actions) — see its waveform
 * and a best guess at how many cycles it is and where the cuts should go, adjust to taste,
 * then cut + upload — nothing touches the network until "cut & upload" is pressed. All
 * resulting slices land in Postgres/Valkey under one bank name, so they play back as
 * s("name:0"), s("name:1"), etc. Editing/merging existing sounds never mutates them —
 * this always produces a new bank alongside the originals.
 */
export const BeatAnalyzer = forwardRef<BeatAnalyzerHandle, BeatAnalyzerProps>(function BeatAnalyzer(
  { onUploadSlice, onRenameBank },
  ref,
) {
  const [stage, setStage] = useState<Stage>("idle");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [analysis, setAnalysis] = useState<BeatAnalysis | null>(null);
  const [cycles, setCycles] = useState(1);
  const [cuts, setCuts] = useState<number[]>([]);
  const [bankName, setBankName] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [uploadedBank, setUploadedBank] = useState<{ name: string; count: number } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Keyed by slice time range (stable across re-renders, unlike index — which shifts when a
  // cut is merged away) rather than by index, so per-slice upload status survives that.
  const [sliceStatus, setSliceStatus] = useState<Map<string, "uploading" | "done" | "error">>(
    new Map(),
  );
  // Per-slice trim (clip-in/clip-out), keyed the same way as sliceStatus. Absent === untrimmed.
  const [clips, setClips] = useState<Map<string, Clip>>(new Map());

  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const dragIndexRef = useRef<number | null>(null);

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  }, []);

  useEffect(() => () => void audioCtxRef.current?.close(), []);

  const reset = useCallback(() => {
    setStage("idle");
    setError(null);
    setFileName("");
    setBuffer(null);
    setAnalysis(null);
    setCycles(1);
    setCuts([]);
    setBankName("");
    setProgress({ done: 0, total: 0 });
    setUploadedBank(null);
    setRenameValue("");
    setSliceStatus(new Map());
    setClips(new Map());
  }, []);

  // Shared tail of "get a decoded buffer analyzed and onto the screen" — used whether it
  // came from a file drop or from loadFromSamples pulling existing sounds back in.
  const loadBuffer = useCallback((decoded: AudioBuffer, suggestedName: string) => {
    const result = analyzeBeat(decoded);
    setBuffer(decoded);
    setAnalysis(result);
    setCycles(result.cycles);
    setCuts(result.cuts);
    setBankName(suggestedName);
    setStage("ready");
  }, []);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!file.type.startsWith("audio/")) {
        setError("that doesn't look like an audio file");
        return;
      }
      setError(null);
      setStage("analyzing");
      setFileName(file.name);
      setUploadedBank(null);
      try {
        loadBuffer(await decodeAudioFile(file), suggestName(file.name));
      } catch (err) {
        setError(`couldn't analyze that file: ${err instanceof Error ? err.message : err}`);
        setStage("idle");
      }
    },
    [loadBuffer],
  );

  const loadFromSamples = useCallback(
    async (sources: EditSource[]) => {
      if (sources.length === 0) return;
      setError(null);
      setStage("analyzing");
      const label = sources.map((s) => s.label).join(" + ");
      setFileName(label);
      setUploadedBank(null);
      try {
        const ctx = getAudioCtx();
        const decoded = await Promise.all(sources.map((s) => decodeAudioUrl(ctx, s.url)));
        const merged = decoded.length === 1 ? decoded[0] : concatAudioBuffers(decoded);
        const suggested =
          sources.length === 1
            ? suggestName(`${sources[0].label}-edit`)
            : suggestName(sources.map((s) => s.label).join("-")).slice(0, 60);
        loadBuffer(merged, suggested);
      } catch (err) {
        setError(`couldn't load "${label}": ${err instanceof Error ? err.message : err}`);
        setStage("idle");
      }
    },
    [getAudioCtx, loadBuffer],
  );

  useImperativeHandle(ref, () => ({ loadFromSamples }), [loadFromSamples]);

  // Redraw the waveform whenever the decoded peaks or the container size change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analysis) return;
    const width = containerRef.current?.clientWidth ?? 600;
    canvas.width = width;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, CANVAS_HEIGHT);
    ctx.fillStyle = "#7ee0c1";
    const { min, max } = analysis.peaks;
    const mid = CANVAS_HEIGHT / 2;
    const bucketWidth = width / min.length;
    for (let i = 0; i < min.length; i++) {
      const x = i * bucketWidth;
      const top = mid + min[i] * mid;
      const bottom = mid + max[i] * mid;
      ctx.fillRect(x, top, Math.max(1, bucketWidth), Math.max(1, bottom - top));
    }
  }, [analysis]);

  const slices = useMemo(() => {
    if (!analysis) return [];
    const bounds = boundsFromCuts(cuts, analysis.duration);
    return bounds.slice(0, -1).map((start, i) => ({ start, end: bounds[i + 1] }));
  }, [analysis, cuts]);

  const setCycleCount = useCallback(
    (next: number) => {
      const n = Math.max(1, Math.min(64, Math.round(next)));
      setCycles(n);
      if (buffer) setCuts(recomputeCuts(buffer, n));
    },
    [buffer],
  );

  const removeCutBefore = useCallback((sliceIndex: number) => {
    // Merges this slice into the previous one by dropping the cut at its start.
    if (sliceIndex === 0) return;
    setCuts((prev) => prev.filter((_, i) => i !== sliceIndex - 1));
    setCycles((c) => Math.max(1, c - 1));
  }, []);

  // Splits this slice in two at its midpoint — the opposite of "merge ↑". Ignores any
  // existing trim on the slice (the two new halves start untrimmed).
  const splitSlice = useCallback(
    (index: number) => {
      const s = slices[index];
      const mid = (s.start + s.end) / 2;
      setCuts((prev) => [...prev, mid].sort((a, b) => a - b));
      setCycles((c) => c + 1);
    },
    [slices],
  );

  const getClip = useCallback((key: string) => clips.get(key) ?? NO_CLIP, [clips]);
  const setClip = useCallback((key: string, clip: Clip) => {
    setClips((prev) => new Map(prev).set(key, clip));
  }, []);

  const previewSlice = useCallback(
    (start: number, end: number) => {
      if (!buffer) return;
      const ctx = getAudioCtx();
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0, start, Math.max(0.01, end - start));
    },
    [buffer, getAudioCtx],
  );

  // Dragging a marker updates its time; markers can't cross their neighbors.
  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const i = dragIndexRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      if (i === null || !rect || !analysis) return;
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const t = frac * analysis.duration;
      setCuts((prev) => {
        const lo = i === 0 ? 0.01 : prev[i - 1] + 0.01;
        const hi = i === prev.length - 1 ? analysis.duration - 0.01 : prev[i + 1] - 0.01;
        const next = [...prev];
        next[i] = Math.min(hi, Math.max(lo, t));
        return next;
      });
    },
    [analysis],
  );

  const stopDrag = useCallback(() => {
    dragIndexRef.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", stopDrag);
  }, [handlePointerMove]);

  const startDrag = useCallback(
    (i: number) => {
      dragIndexRef.current = i;
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopDrag);
    },
    [handlePointerMove, stopDrag],
  );

  // Uploads one slice on its own — lets someone grab a single hit out of the bank without
  // waiting on the rest, e.g. to re-cut just that one and re-upload it.
  const uploadOneSlice = useCallback(
    async (index: number) => {
      if (!buffer) return;
      const name = bankName.trim();
      if (!BANK_NAME_PATTERN.test(name)) {
        setError("bank name must be 1-64 characters of letters, numbers, _ or -");
        return;
      }
      setError(null);
      const s = slices[index];
      const key = sliceKey(s);
      const eff = clippedRange(s, getClip(key));
      setSliceStatus((prev) => new Map(prev).set(key, "uploading"));
      try {
        const file = sliceToFile(buffer, eff.start, eff.end, `${name}-${index}.wav`);
        await onUploadSlice(file, `${name}-${index}`, name, index);
        setSliceStatus((prev) => new Map(prev).set(key, "done"));
      } catch (err) {
        setSliceStatus((prev) => new Map(prev).set(key, "error"));
        setError(`upload failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [buffer, bankName, slices, getClip, onUploadSlice],
  );

  const handleUpload = useCallback(async () => {
    if (!buffer || !analysis) return;
    const name = bankName.trim();
    if (!BANK_NAME_PATTERN.test(name)) {
      setError("bank name must be 1-64 characters of letters, numbers, _ or -");
      return;
    }
    setError(null);
    setStage("uploading");
    const pending = slices.filter((s) => sliceStatus.get(sliceKey(s)) !== "done");
    setProgress({ done: slices.length - pending.length, total: slices.length });
    try {
      // Sequential, not parallel — keeps upload order (and therefore bank index) deterministic,
      // and each slice is small enough that this isn't a meaningful latency hit. Slices already
      // uploaded individually (see uploadOneSlice) are skipped rather than re-sent.
      for (let i = 0; i < slices.length; i++) {
        const s = slices[i];
        const key = sliceKey(s);
        if (sliceStatus.get(key) === "done") continue;
        setSliceStatus((prev) => new Map(prev).set(key, "uploading"));
        const eff = clippedRange(s, getClip(key));
        const file = sliceToFile(buffer, eff.start, eff.end, `${name}-${i}.wav`);
        await onUploadSlice(file, `${name}-${i}`, name, i);
        setSliceStatus((prev) => new Map(prev).set(key, "done"));
        setProgress((p) => ({ done: p.done + 1, total: slices.length }));
      }
      setUploadedBank({ name, count: slices.length });
      setRenameValue(name);
      setStage("done");
    } catch (err) {
      setError(`upload failed: ${err instanceof Error ? err.message : err}`);
      setStage("ready");
    }
  }, [buffer, analysis, bankName, slices, sliceStatus, getClip, onUploadSlice]);

  if (stage === "idle" || stage === "analyzing") {
    return (
      <div>
        {error && <p style={{ color: "#ff9b9b", fontSize: 12 }}>{error}</p>}
        <div
          className={`dropzone ${dragOver ? "dragover" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFile(e.dataTransfer.files?.[0]);
          }}
        >
          {stage === "analyzing" ? `analyzing ${fileName}…` : "drop a beat here (or click to browse)"}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          style={{ display: "none" }}
          onChange={(e) => {
            handleFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <p style={{ color: "var(--muted)", fontSize: 12 }}>
          analyzes a loop's waveform, guesses its tempo/cycle count and where the cycle
          boundaries fall, and only uploads once you confirm the cuts — all slices land in one
          sound bank (s("name:0"), s("name:1"), …). you can also send an existing sound (or a
          few, merged) here with "scrub/chop" below.
        </p>
      </div>
    );
  }

  return (
    <div>
      {error && <p style={{ color: "#ff9b9b", fontSize: 12 }}>{error}</p>}

      {analysis && (
        <>
          <p style={{ fontSize: 12, color: "var(--muted)" }}>
            {fileName} · {formatTime(analysis.duration)} · ~{Math.round(analysis.bpm)} bpm
          </p>

          <div ref={containerRef} style={{ position: "relative", marginBottom: 8 }}>
            <canvas ref={canvasRef} style={{ width: "100%", height: CANVAS_HEIGHT, display: "block" }} />
            {cuts.map((t, i) => (
              <div
                key={i}
                onPointerDown={(e) => {
                  e.preventDefault();
                  startDrag(i);
                }}
                title={formatTime(t)}
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `${(t / analysis.duration) * 100}%`,
                  width: 6,
                  marginLeft: -3,
                  background: "rgba(255,255,255,0.5)",
                  cursor: "ew-resize",
                }}
              />
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <label style={{ fontSize: 12, color: "var(--muted)" }}>cycles</label>
            <input
              type="number"
              min={1}
              max={64}
              value={cycles}
              onChange={(e) => setCycleCount(Number(e.target.value))}
              style={{ width: 56 }}
              disabled={stage !== "ready"}
            />
            <button
              className="secondary"
              disabled={stage !== "ready"}
              onClick={() => {
                const result = analyzeBeat(buffer!);
                setAnalysis(result);
                setCycles(result.cycles);
                setCuts(result.cuts);
              }}
            >
              re-detect
            </button>
          </div>

          <div style={{ marginBottom: 10 }}>
            {slices.map((s, i) => {
              const key = sliceKey(s);
              const status = sliceStatus.get(key);
              const clip = getClip(key);
              const eff = clippedRange(s, clip);
              const tooShortToSplit = eff.end - eff.start < MIN_SLICE_SECONDS * 2;
              return (
                <div key={key} className="track" style={{ cursor: "default" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <SliceTrimmer buffer={buffer!} slice={s} clip={clip} onChange={(c) => setClip(key, c)} />
                    <span style={{ fontSize: 12, flex: 1 }}>
                      {bankName || "sample"}:{i} · {formatTime(eff.end - eff.start)}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    <button className="secondary" onClick={() => previewSlice(eff.start, eff.end)}>
                      ▶
                    </button>
                    <button
                      className="secondary"
                      disabled={tooShortToSplit}
                      onClick={() => splitSlice(i)}
                      title="split this slice into two"
                    >
                      split
                    </button>
                    {i > 0 && (
                      <button
                        className="secondary"
                        onClick={() => removeCutBefore(i)}
                        title="merge with previous slice"
                      >
                        merge ↑
                      </button>
                    )}
                    <button
                      className="secondary"
                      disabled={status === "uploading" || stage === "uploading"}
                      onClick={() => uploadOneSlice(i)}
                      title={`upload just this slice as ${bankName || "sample"}:${i}`}
                    >
                      {status === "done" ? "✓ uploaded" : status === "uploading" ? "uploading…" : "upload"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {stage !== "done" && (
            <>
              <input
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder="bank name"
                disabled={stage === "uploading"}
                style={{ width: "100%", marginBottom: 8 }}
              />
              <button onClick={handleUpload} disabled={stage === "uploading" || slices.length === 0}>
                {stage === "uploading"
                  ? `uploading ${progress.done}/${progress.total}…`
                  : (() => {
                      const remaining = slices.filter((s) => sliceStatus.get(sliceKey(s)) !== "done").length;
                      if (remaining === 0) return "finish bank";
                      return remaining === slices.length
                        ? `cut & upload ${slices.length} slice${slices.length === 1 ? "" : "s"}`
                        : `upload remaining ${remaining} slice${remaining === 1 ? "" : "s"}`;
                    })()}
              </button>
            </>
          )}

          {stage === "done" && uploadedBank && (
            <>
              <p style={{ fontSize: 12, color: "var(--accent)" }}>
                ✓ uploaded {uploadedBank.count} slices as "{uploadedBank.name}" — try{" "}
                s("{uploadedBank.name}:0 {uploadedBank.name}:1")
              </p>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="rename bank"
                  style={{ flex: 1 }}
                />
                <button
                  className="secondary"
                  disabled={!renameValue.trim() || renameValue.trim() === uploadedBank.name}
                  onClick={() => {
                    const newName = renameValue.trim();
                    onRenameBank(uploadedBank.name, newName);
                    setUploadedBank({ ...uploadedBank, name: newName });
                    setBankName(newName);
                  }}
                >
                  rename
                </button>
              </div>
              <button className="secondary" onClick={reset}>
                analyze another beat
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
});
