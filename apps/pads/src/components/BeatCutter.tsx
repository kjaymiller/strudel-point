import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyzeBeatCuts, type BeatCut, boundsFromCuts, recomputeCuts } from "../audio/beatcut";

const CANVAS_HEIGHT = 100;
const MIN_SLICE_SECONDS = 0.05;
const BANK_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function formatTime(sec: number): string {
  return `${sec.toFixed(2)}s`;
}

interface BeatCutterProps {
  buffer: AudioBuffer;
  fileName: string;
  bankNameSuggestion: string;
  uploading: boolean;
  onCancel: () => void;
  /** Ranges are already in final slice order — index in this array IS the bankIndex,
   * so whatever got merged/split/re-cut here is exactly what ends up on disk under
   * `${bankName}-0`, `${bankName}-1`, … (see App.tsx's uploadFiles: it names/uploads
   * strictly by this array's position, not by any earlier index a slice might have had). */
  onConfirm: (bankName: string, ranges: { start: number; end: number }[]) => void;
}

/**
 * Interactive review step for a dropped loop before it becomes a bank — same cut/cycle
 * editing apps/web/src/components/BeatAnalyzer.tsx offers (drag cut markers, adjust cycle
 * count, split a slice in two, merge two back together), minus that component's
 * per-slice clip-trim handles and one-slice-at-a-time upload progress, since here the
 * whole set is confirmed and uploaded together in one shot by the caller. Straight copy
 * of apps/dj/src/components/BeatCutter.tsx — see that file for why these apps each keep
 * their own rather than importing across app boundaries.
 */
export function BeatCutter({
  buffer,
  fileName,
  bankNameSuggestion,
  uploading,
  onCancel,
  onConfirm,
}: BeatCutterProps) {
  const [analysis, setAnalysis] = useState<BeatCut | null>(null);
  const [cycles, setCycles] = useState(1);
  const [cuts, setCuts] = useState<number[]>([]);
  const [bankName, setBankName] = useState(bankNameSuggestion);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const dragIndexRef = useRef<number | null>(null);

  useEffect(() => {
    const result = analyzeBeatCuts(buffer);
    setAnalysis(result);
    setCycles(result.cycles);
    setCuts(result.cuts);
  }, [buffer]);

  useEffect(() => () => void audioCtxRef.current?.close(), []);

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  }, []);

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
      setCuts(recomputeCuts(buffer, n));
    },
    [buffer],
  );

  // Opposite of split — merges this slice into the previous one by dropping the cut at
  // its start, so what's left is one section covering both original cycles.
  const removeCutBefore = useCallback((sliceIndex: number) => {
    if (sliceIndex === 0) return;
    setCuts((prev) => prev.filter((_, i) => i !== sliceIndex - 1));
    setCycles((c) => Math.max(1, c - 1));
  }, []);

  // Splits this slice in two at its midpoint — the opposite of "merge ↑".
  const splitSlice = useCallback(
    (index: number) => {
      const s = slices[index];
      const mid = (s.start + s.end) / 2;
      setCuts((prev) => [...prev, mid].sort((a, b) => a - b));
      setCycles((c) => c + 1);
    },
    [slices],
  );

  const previewSlice = useCallback(
    (start: number, end: number) => {
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

  const confirm = useCallback(() => {
    const name = bankName.trim();
    if (!BANK_NAME_PATTERN.test(name)) {
      setError("bank name must be 1-64 characters of letters, numbers, _ or -");
      return;
    }
    setError(null);
    onConfirm(name, slices);
  }, [bankName, slices, onConfirm]);

  if (!analysis) return <p style={{ fontSize: 12, color: "var(--muted)" }}>analyzing {fileName}…</p>;

  return (
    <div className="beat-cutter">
      {error && <p style={{ color: "#ff9b9b", fontSize: 12 }}>{error}</p>}
      <p style={{ fontSize: 12, color: "var(--muted)" }}>
        {fileName} · {formatTime(analysis.duration)} · ~{Math.round(analysis.bpm)} bpm detected — check the
        cycle count below if it ends up sounding too fast/slow once the pads are firing; a pad's implied tempo
        (for anything that cares) is derived straight from how long each of these slices is. The whole loop
        uploads too, as "{bankName || "sample"}:0" — the slices below start at :1.
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
          disabled={uploading}
        />
        <button
          className="secondary"
          disabled={uploading}
          onClick={() => {
            const result = analyzeBeatCuts(buffer);
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
          const tooShortToSplit = s.end - s.start < MIN_SLICE_SECONDS * 2;
          return (
            <div
              key={`${s.start.toFixed(3)}-${s.end.toFixed(3)}`}
              className="track"
              style={{ cursor: "default" }}
            >
              <span style={{ fontSize: 12 }}>
                {/* +1: bankIndex 0 is reserved for the whole uncut loop, added automatically
                    on upload (see App.tsx's confirmCut) — these editor slices land at 1..N. */}
                {bankName || "sample"}:{i + 1} · {formatTime(s.end - s.start)}
              </span>
              <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <button className="secondary" onClick={() => previewSlice(s.start, s.end)}>
                  ▶
                </button>
                <button
                  className="secondary"
                  disabled={tooShortToSplit || uploading}
                  onClick={() => splitSlice(i)}
                  title="split this slice into two"
                >
                  split
                </button>
                {i > 0 && (
                  <button
                    className="secondary"
                    disabled={uploading}
                    onClick={() => removeCutBefore(i)}
                    title="merge with previous slice"
                  >
                    merge ↑
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <input
        value={bankName}
        onChange={(e) => setBankName(e.target.value)}
        placeholder="bank name"
        disabled={uploading}
        style={{ width: "100%", marginBottom: 8 }}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={confirm} disabled={uploading || slices.length === 0}>
          {uploading
            ? "cutting & uploading…"
            : `cut & upload — :0 whole loop + ${slices.length} slice${slices.length === 1 ? "" : "s"}`}
        </button>
        <button className="secondary" onClick={onCancel} disabled={uploading}>
          cancel
        </button>
      </div>
    </div>
  );
}
