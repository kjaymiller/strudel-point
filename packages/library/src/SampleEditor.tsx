import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { CustomSample } from "@strudel-point/shared";
import {
  analyzeBeat,
  computeRangePeaks,
  decodeAudioFile,
  decodeAudioUrl,
  recomputeCuts,
  type BeatAnalysis,
} from "./audio/analyze";
import { concatAudioBuffers, resampleBuffer, sliceToFile } from "./audio/wav";
import { suggestName } from "./banks";
import { getSoundDragData } from "./dnd";

/** One existing sound to pull back into the editor — see `SampleEditorHandle.loadFromSamples`. */
export interface EditSource {
  url: string;
  label: string;
}

export interface SampleEditorHandle {
  /**
   * Loads one or more existing "my sounds" entries into the editor, in place of dropping a
   * fresh file. A single source is "re-scrub/re-chop this sample"; several are concatenated
   * (see concatAudioBuffers) end-to-end first, so "merge" is just "chop the merged result".
   */
  loadFromSamples: (sources: EditSource[]) => void;
}

export interface StemResult {
  name: string;
  url: string;
}

interface SampleEditorProps {
  /** Uploads one slice (already a "name" of its own) as part of `bankName`, at `bankIndex`. */
  onUploadSlice: (file: File, name: string, bankName: string, bankIndex: number) => Promise<CustomSample>;
  /** Renames the bank just uploaded (every slice moves to the new bankName server-side). */
  onRenameBank: (oldName: string, newName: string) => void;
  /** Sends the currently-loaded (and possibly resampled) whole buffer off for stem
   * separation — vocals/drums/bass/other, or whatever the backing service returns —
   * `baseName` is the bank name field's current value, so results come back named
   * consistently with everything else this editor produces. Optional: omitting this
   * hides the "separate into stems" section entirely, since it needs a real backing
   * service (see apps/spleeter) an app may not have wired up. */
  onSeparateStems?: (file: File, baseName: string) => Promise<StemResult[]>;
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
 * `loadFromSamples` (the library tray's "scrub/chop" and "merge" actions) — see its
 * waveform and a best guess at how many cycles it is and where the cuts should go, adjust
 * to taste, optionally resample the whole thing (speed/pitch move together — see
 * audio/wav.ts's resampleBuffer) or send it off for stem separation, then cut + upload —
 * nothing touches the network until "cut & upload" (or "separate into stems") is
 * pressed. All resulting slices land under one bank name, so they play back as
 * s("name:0"), s("name:1"), etc. Editing/merging existing sounds never mutates them —
 * this always produces a new bank alongside the originals. A bank's index 0 is always
 * its whole, uncut loop (see ensureWholeUploaded) — pull that back in later (single- or
 * multi-select "edit" from the library tray) as the base for a *longer* sample: merging
 * it with itself or anything else just concatenates whatever's picked, so this is also
 * how you go past a sample's own original length rather than only ever cutting within it.
 *
 * Was apps/web's BeatAnalyzer.tsx — moved here so every strudel-point app's library
 * drawer gets the same editor, not just web's own standalone panel.
 */
export const SampleEditor = forwardRef<SampleEditorHandle, SampleEditorProps>(function SampleEditor(
  { onUploadSlice, onRenameBank, onSeparateStems },
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
  // Speed knob for resampleBuffer — 1 = untouched. Applying it replaces `buffer` with the
  // resampled result and re-analyzes from scratch, same as any other buffer-changing step.
  const [resampleRate, setResampleRate] = useState(1);
  const [stemsState, setStemsState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [stems, setStems] = useState<StemResult[]>([]);
  // Whether the whole, uncut buffer has been uploaded yet as this bank's index 0 — see
  // ensureWholeUploaded below. Tracked separately from sliceStatus (which is keyed by cut
  // slice, and the whole buffer isn't one of those); reset alongside everything else in
  // reset()/loadBuffer() whenever a genuinely new buffer comes in.
  const [wholeUploaded, setWholeUploaded] = useState(false);

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
    setResampleRate(1);
    setStemsState("idle");
    setStems([]);
    setWholeUploaded(false);
  }, []);

  // Shared tail of "get a decoded buffer analyzed and onto the screen" — used whether it
  // came from a file drop, loadFromSamples pulling existing sounds back in, or a resample.
  const loadBuffer = useCallback((decoded: AudioBuffer, suggestedName: string) => {
    const result = analyzeBeat(decoded);
    setBuffer(decoded);
    setAnalysis(result);
    setCycles(result.cycles);
    setCuts(result.cuts);
    setBankName(suggestedName);
    setStage("ready");
    setSliceStatus(new Map());
    setClips(new Map());
    setWholeUploaded(false);
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

  // Applies the Speed knob to the whole loaded buffer, replacing it and starting a fresh
  // analysis pass (new peaks, new tempo/cut guess) — any cuts/trims/upload progress so far
  // are for the *old* buffer and wouldn't line up, so this intentionally resets them, same
  // as loading a different source would.
  const applyResample = useCallback(() => {
    if (!buffer || resampleRate === 1) return;
    try {
      const resampled = resampleBuffer(buffer, resampleRate);
      loadBuffer(resampled, `${bankName || "sample"}-${resampleRate}x`);
      setResampleRate(1);
    } catch (err) {
      setError(`couldn't resample: ${err instanceof Error ? err.message : err}`);
    }
  }, [buffer, resampleRate, bankName, loadBuffer]);

  const separateStems = useCallback(async () => {
    if (!buffer || !onSeparateStems) return;
    setStemsState("running");
    setError(null);
    try {
      const name = bankName.trim() || "sample";
      const file = sliceToFile(buffer, 0, buffer.duration, `${name}.wav`);
      const result = await onSeparateStems(file, name);
      setStems(result);
      setStemsState("done");
    } catch (err) {
      setStemsState("error");
      setError(`stem separation failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [buffer, bankName, onSeparateStems]);

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

  // Uploads the whole, uncut buffer as this bank's index 0 the first time anything else
  // in it gets uploaded — same "index 0 is always the full loop, cut slices start at 1"
  // convention apps/pads' own drop-straight-onto-the-grid flow already established, kept
  // here so the two paths agree and a bank you built through *this* editor can still be
  // pulled back in whole later (see the library tray's multi-select "merge" and the
  // lengthen-by-merging-with-itself workflow that depends on it existing at all). A
  // no-op past the first call for the current buffer (see wholeUploaded/loadBuffer).
  const ensureWholeUploaded = useCallback(
    async (name: string) => {
      if (!buffer || wholeUploaded) return;
      const file = sliceToFile(buffer, 0, buffer.duration, `${name}-0.wav`);
      await onUploadSlice(file, `${name}-0`, name, 0);
      setWholeUploaded(true);
    },
    [buffer, wholeUploaded, onUploadSlice],
  );

  // Uploads one slice on its own — lets someone grab a single hit out of the bank without
  // waiting on the rest, e.g. to re-cut just that one and re-upload it. Cut slices land at
  // index+1 (index 0 is reserved for the whole loop — see ensureWholeUploaded).
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
        await ensureWholeUploaded(name);
        const bankIndex = index + 1;
        const file = sliceToFile(buffer, eff.start, eff.end, `${name}-${bankIndex}.wav`);
        await onUploadSlice(file, `${name}-${bankIndex}`, name, bankIndex);
        setSliceStatus((prev) => new Map(prev).set(key, "done"));
      } catch (err) {
        setSliceStatus((prev) => new Map(prev).set(key, "error"));
        setError(`upload failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [buffer, bankName, slices, getClip, onUploadSlice, ensureWholeUploaded],
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
    // +1 for the whole-loop upload (index 0) alongside every cut slice — skipped from the
    // total, same as an already-done slice, once ensureWholeUploaded has already run.
    const total = pending.length + (wholeUploaded ? 0 : 1);
    setProgress({ done: 0, total });
    try {
      await ensureWholeUploaded(name);
      if (!wholeUploaded) setProgress((p) => ({ ...p, done: p.done + 1 }));
      // Sequential, not parallel — keeps upload order (and therefore bank index) deterministic,
      // and each slice is small enough that this isn't a meaningful latency hit. Slices already
      // uploaded individually (see uploadOneSlice) are skipped rather than re-sent. Cut slices
      // land at i+1 — index 0 is the whole loop just uploaded above.
      for (let i = 0; i < slices.length; i++) {
        const s = slices[i];
        const key = sliceKey(s);
        if (sliceStatus.get(key) === "done") continue;
        setSliceStatus((prev) => new Map(prev).set(key, "uploading"));
        const eff = clippedRange(s, getClip(key));
        const bankIndex = i + 1;
        const file = sliceToFile(buffer, eff.start, eff.end, `${name}-${bankIndex}.wav`);
        await onUploadSlice(file, `${name}-${bankIndex}`, name, bankIndex);
        setSliceStatus((prev) => new Map(prev).set(key, "done"));
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
      setUploadedBank({ name, count: slices.length + 1 });
      setRenameValue(name);
      setStage("done");
    } catch (err) {
      setError(`upload failed: ${err instanceof Error ? err.message : err}`);
      setStage("ready");
    }
  }, [buffer, analysis, bankName, slices, sliceStatus, getClip, onUploadSlice, ensureWholeUploaded, wholeUploaded]);

  if (stage === "idle" || stage === "analyzing") {
    return (
      <div className="sample-editor">
        {error && <p className="sample-editor-error">{error}</p>}
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
            const sound = getSoundDragData(e);
            if (sound?.url) {
              loadFromSamples([{ url: sound.url, label: sound.label ?? sound.name }]);
              return;
            }
            handleFile(e.dataTransfer.files?.[0]);
          }}
        >
          {stage === "analyzing"
            ? `analyzing ${fileName}…`
            : "drop a beat here, or drag an existing sound in from the library above (or click to browse)"}
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
        <p className="sample-editor-hint">
          analyzes a loop's waveform, guesses its tempo/cycle count and where the cycle
          boundaries fall, and only uploads once you confirm the cuts — all slices land in one
          sound bank (s("name:0"), s("name:1"), …).
        </p>
      </div>
    );
  }

  return (
    <div
      className="sample-editor"
      onDragOver={(e) => {
        if (getSoundDragData(e)?.url) e.preventDefault();
      }}
      onDrop={(e) => {
        const sound = getSoundDragData(e);
        if (!sound?.url) return;
        e.preventDefault();
        loadFromSamples([{ url: sound.url, label: sound.label ?? sound.name }]);
      }}
    >
      {error && <p className="sample-editor-error">{error}</p>}

      {analysis && (
        <>
          <p className="sample-editor-meta">
            {fileName} · {formatTime(analysis.duration)} · ~{Math.round(analysis.bpm)} bpm
          </p>

          <div ref={containerRef} className="sample-editor-waveform">
            <canvas ref={canvasRef} style={{ width: "100%", height: CANVAS_HEIGHT, display: "block" }} />
            {cuts.map((t, i) => (
              <div
                key={i}
                onPointerDown={(e) => {
                  e.preventDefault();
                  startDrag(i);
                }}
                title={formatTime(t)}
                className="sample-editor-cut-marker"
                style={{ left: `${(t / analysis.duration) * 100}%` }}
              />
            ))}
          </div>

          <div className="sample-editor-cycles-row">
            <label className="knob-label">cycles</label>
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

          <div className="sample-editor-resample-row">
            <label className="knob-label">speed</label>
            <input
              type="number"
              min={0.1}
              max={4}
              step={0.05}
              value={resampleRate}
              onChange={(e) => setResampleRate(Math.max(0.1, Math.min(4, Number(e.target.value) || 1)))}
              style={{ width: 64 }}
              disabled={stage !== "ready"}
            />
            <button className="secondary" disabled={stage !== "ready" || resampleRate === 1} onClick={applyResample}>
              resample
            </button>
            <span className="sample-editor-hint" style={{ margin: 0 }}>
              (speed and pitch move together — this isn't pitch-corrected time-stretching)
            </span>
          </div>

          {onSeparateStems && (
            <div className="sample-editor-stems-row">
              <button className="secondary" disabled={stemsState === "running"} onClick={separateStems}>
                {stemsState === "running" ? "separating…" : "separate into stems"}
              </button>
              {stemsState === "done" && (
                <span className="sample-editor-hint" style={{ margin: 0 }}>
                  ✓ {stems.length} stem{stems.length === 1 ? "" : "s"} added — {stems.map((s) => s.name).join(", ")}
                </span>
              )}
            </div>
          )}

          <div className="sample-editor-slices">
            {slices.map((s, i) => {
              const key = sliceKey(s);
              const status = sliceStatus.get(key);
              const clip = getClip(key);
              const eff = clippedRange(s, clip);
              const tooShortToSplit = eff.end - eff.start < MIN_SLICE_SECONDS * 2;
              return (
                <div key={key} className="track sample-editor-slice">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <SliceTrimmer buffer={buffer!} slice={s} clip={clip} onChange={(c) => setClip(key, c)} />
                    <span style={{ fontSize: 12, flex: 1 }}>
                      {bankName || "sample"}:{i + 1} · {formatTime(eff.end - eff.start)}
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
                      title={`upload just this slice as ${bankName || "sample"}:${i + 1}`}
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
                      if (remaining === 0 && wholeUploaded) return "finish bank";
                      if (remaining === slices.length && !wholeUploaded) {
                        // Nothing uploaded yet — this pass also uploads the whole loop as
                        // index 0, so say so up front rather than surprising anyone with an
                        // extra request.
                        return `cut & upload ${slices.length} slice${slices.length === 1 ? "" : "s"} + full loop`;
                      }
                      return remaining === 0
                        ? "upload full loop"
                        : `upload remaining ${remaining} slice${remaining === 1 ? "" : "s"}`;
                    })()}
              </button>
            </>
          )}

          {stage === "done" && uploadedBank && (
            <>
              <p className="sample-editor-done">
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
                edit another
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
});
