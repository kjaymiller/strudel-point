import {
  type CSSProperties,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { peaksOf } from "../audio";
import { hueForBank } from "../color";
import { getStrudel, getStrudelIfReady } from "../strudel";

// Exported so App.tsx can size its own rackNames array and hints off the same number
// rather than a second hardcoded 64 drifting out of sync with this one.
export const PAD_COUNT = 64;
// Keyboard shortcuts cover as much of the keyboard as lines up with the grid's own 8
// columns — the number row, then qwertyui/asdfghjk on the next two, then the bottom row
// (which runs one short of 8 real letters before qwerty punctuation takes over, so ","
// and "." fill out its last two columns). That's still short of PAD_COUNT — there's no
// sane single-layer mapping for a full 64-key grid on a regular keyboard — so pads past
// PAD_KEYS.length are click/tap-only, same as most hardware pad controllers past their
// first few banks.
// Exported for App.tsx's own hint text (see the pad-section hint) — kept in sync with
// whatever these four rows actually spell out rather than a hardcoded description of them.
export const PAD_KEYS = [..."12345678", ..."qwertyui", ..."asdfghjk", ..."zxcvbnm,."];
const PADS_STORAGE_PREFIX = "strudel-point:pads:pads:";
const PADS_CUT_STORAGE_PREFIX = "strudel-point:pads:pads-cut:";
const CANVAS_WIDTH = 96;
const CANVAS_HEIGHT = 28;
const PEAK_BUCKETS = 60;
// How long a pad lights up for when `flash()` reports it sounding as part of a playing
// pattern (rack/recording/loaded track) rather than a direct hit — a real hap's actual
// duration isn't worth plumbing through just for this indicator, so every flash gets the
// same short, visible-but-not-sluggish blink.
const FLASH_DURATION = 0.15;
// Same hue as the app's own --accent teal, for an empty pad (nothing assigned yet, so no
// bank name to hash a color from).
const DEFAULT_HUE = 165;

interface PadWaveform {
  peaks: Float32Array;
  duration: number;
}

/** "loading"/"missing" are as real as a decoded waveform — "missing" means this ref's bank
 * isn't known in this room (stale pad from a different room, or the bank got deleted). */
type WaveformState = "loading" | "missing" | PadWaveform;

interface PlayState {
  startAt: number;
  duration: number;
}

function loadStoredNames(storageKey: string): (string | null)[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.from({ length: PAD_COUNT }, (_, i) => (typeof parsed[i] === "string" ? parsed[i] : null));
  } catch {
    return Array(PAD_COUNT).fill(null);
  }
}

// Default true: every cut-enabled pad shares one choke group — hitting one of them stops
// whatever any other cut-enabled pad is still sounding (plus retriggers itself from 0),
// the usual drum-machine behavior for e.g. an open/closed hihat pair on the same voice.
// Pads with cut off don't choke anything and aren't choked by anything — they stack freely
// for deliberate layering/rolls, same as before.
function loadStoredCutModes(storageKey: string): boolean[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.from({ length: PAD_COUNT }, (_, i) => (typeof parsed[i] === "boolean" ? parsed[i] : true));
  } catch {
    return Array(PAD_COUNT).fill(true);
  }
}

function isTypingTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

// A slice ref is always "bankName:index" — the part before the last colon.
function bankNameOf(ref: string): string {
  const idx = ref.lastIndexOf(":");
  return idx === -1 ? ref : ref.slice(0, idx);
}

/** Draws one pad: waveform dimmed, already-played portion + a playhead line lit up bright,
 * all tinted to `hue` (see color.ts's hueForBank) so each bank reads as its own color
 * rather than every pad looking identical. `progress` is 0-1, or null when nothing's
 * playing. */
function drawPad(
  canvas: HTMLCanvasElement,
  wf: WaveformState | undefined,
  progress: number | null,
  hue: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const lit = `hsl(${hue} 70% 65%)`;
  const dim = `hsl(${hue} 55% 55% / 0.4)`;

  if (!wf || wf === "loading" || wf === "missing") {
    if (progress != null) {
      ctx.fillStyle = `hsl(${hue} 70% 65% / 0.45)`;
      ctx.fillRect(0, 0, Math.min(1, Math.max(0, progress)) * width, height);
    }
    return;
  }

  const { peaks } = wf;
  const mid = height / 2;
  const bucketWidth = width / peaks.length;
  const playedBuckets = progress == null ? -1 : Math.floor(Math.min(1, Math.max(0, progress)) * peaks.length);
  for (let i = 0; i < peaks.length; i++) {
    const x = i * bucketWidth;
    const h = Math.max(1, peaks[i] * height);
    ctx.fillStyle = i <= playedBuckets ? lit : dim;
    ctx.fillRect(x, mid - h / 2, Math.max(1, bucketWidth), h);
  }
  if (progress != null) {
    ctx.strokeStyle = "#fff";
    ctx.beginPath();
    const x = Math.min(1, Math.max(0, progress)) * width;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

interface PadBank {
  bankName: string;
  /** e.g. ["kicks:0", "kicks:1", ...] — already ordered by bankIndex. */
  slices: string[];
}

interface PadGridProps {
  channelId: string;
  /** Every bank known in this room — looked up by bare bank name (no ":index") when
   * something dropped on the grid is a whole bank rather than one slice; see
   * isBankName below. */
  banks: PadBank[];
  /** Every slice ref ("bankName:index") known in this room, mapped to its audio url. */
  refUrls: Map<string, string>;
  /** Fired whenever the pad assignments change (load, clear, bank fill) — lets App.tsx
   * fold the current rack into this room's saved Track (see chain.ts's buildRackCode). */
  onChange?: (names: (string | null)[]) => void;
  /** Fired on every successful pad hit (click or key), *before* the audio actually starts —
   * lets App.tsx timestamp it for the press-recorder (see buildRecordingCode) without that
   * timestamp drifting by however long decode-on-first-hit takes. */
  onTrigger?: (ref: string) => void;
}

export interface PadGridHandle {
  /** For App.tsx's own drop-a-loop-here upload flow: once a freshly cut bank finishes
   * uploading, it isn't in `banks` yet on this render (that update is still in flight), so
   * App.tsx hands the just-uploaded bank here directly rather than waiting on props to
   * catch up — same reasoning as apps/dj/src/App.tsx's loadBankOption comment. */
  fillFromBank: (bank: PadBank) => void;
  /** Lights up every pad currently assigned `ref` for FLASH_DURATION, without playing any
   * audio itself — for App.tsx to call as it observes a *playing* pattern's own haps (the
   * rack, a recording, or a loaded track, all played via strudel.evaluate() straight
   * through the normal scheduler) so the grid visibly shows what that pattern is actually
   * triggering, not just what a direct click/key hit. A no-op for a ref no pad currently
   * holds. */
  flash: (ref: string) => void;
}

// A slice ref is always "bankName:index" (see parseSliceRef in chain.ts); bank names
// themselves are sanitized to [a-zA-Z0-9_-] server-side, so they can never contain a
// colon. A dropped string with no colon at all is therefore never a slice — but it's
// not necessarily a fillable multi-slice bank either: a single custom sample (e.g. a
// stem, which has no bankName of its own) also shows up here as its bare, colon-free
// name (see App.tsx's groupBanks, which wraps each single in a one-slice fake "bank"
// only so the shelf can render it uniformly). So this also needs the actual bank
// looked up, to tell "drop the whole kit" apart from "drop this one sample onto this
// one pad" — a one-slice bank always means the latter.
function isBankName(dropped: string, bank: PadBank | undefined): boolean {
  return !dropped.includes(":") && !!bank && bank.slices.length > 1;
}

/**
 * An 8×8 (64-pad) grid: drag a slice ref in from the sample shelf to load one pad, click
 * (or its key on the first 16 — see PAD_KEYS) to fire it as a one-shot straight off the
 * decoded buffer, bypassing the pattern scheduler entirely, so hitting a pad never fights
 * any pattern already playing in the room.
 *
 * Drop a whole *bank* instead (the bank-name chip in the shelf, not one of its slice
 * chips — see SampleShelf) and it loads the entire grid in one go: slice 0 onto pad 1,
 * slice 1 onto pad 2, and so on up to PAD_COUNT, overwriting whatever those pads held
 * before. Which specific pad you dropped it on doesn't matter — it always fills from pad 1.
 *
 * Mount this with `key={channelId}` — assignments are persisted per-room in localStorage,
 * and remounting on room change is the simplest way to load the new room's pads and drop
 * any stale playing state from the old one.
 */
export const PadGrid = forwardRef<PadGridHandle, PadGridProps>(function PadGrid(
  { channelId, banks, refUrls, onChange, onTrigger },
  handleRef,
) {
  const storageKey = `${PADS_STORAGE_PREFIX}${channelId}`;
  const cutStorageKey = `${PADS_CUT_STORAGE_PREFIX}${channelId}`;
  const [names, setNames] = useState<(string | null)[]>(() => loadStoredNames(storageKey));
  const [cutModes, setCutModes] = useState<boolean[]>(() => loadStoredCutModes(cutStorageKey));
  const [waveforms, setWaveforms] = useState<Map<string, WaveformState>>(new Map());
  const [playing, setPlaying] = useState<Map<number, PlayState>>(new Map());
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const bankByName = useMemo(() => new Map(banks.map((b) => [b.bankName, b])), [banks]);

  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const bufferCache = useRef<Map<string, AudioBuffer>>(new Map());
  const loadingRefs = useRef<Set<string>>(new Set());
  // The currently-sounding voice per pad (if any) — kept so a "cut"-mode retrigger has
  // something to actually stop. Not React state: swapping it shouldn't cause a render on
  // its own, only `playing` (below) drives the waveform/playhead redraw.
  const activeSources = useRef<Map<number, AudioBufferSourceNode>>(new Map());
  // Mirrors the latest render's state for the rAF loop below, which is set up once and
  // shouldn't get torn down/recreated on every trigger/load.
  const latest = useRef({ names, cutModes, waveforms, playing, refUrls });
  useEffect(() => {
    latest.current = { names, cutModes, waveforms, playing, refUrls };
  }, [names, cutModes, waveforms, playing, refUrls]);

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(names));
    onChange?.(names);
  }, [names, storageKey, onChange]);

  useEffect(() => {
    localStorage.setItem(cutStorageKey, JSON.stringify(cutModes));
  }, [cutModes, cutStorageKey]);

  const decodeCached = useCallback(async (ref: string, url: string): Promise<AudioBuffer> => {
    const cached = bufferCache.current.get(ref);
    if (cached) return cached;
    const strudel = await getStrudel();
    const ac = strudel.getAudioContext();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`couldn't fetch "${ref}" (${res.status})`);
    const buffer = await ac.decodeAudioData(await res.arrayBuffer());
    bufferCache.current.set(ref, buffer);
    return buffer;
  }, []);

  const ensureWaveform = useCallback(
    (ref: string) => {
      if (latest.current.waveforms.has(ref) || loadingRefs.current.has(ref)) return;
      const url = latest.current.refUrls.get(ref);
      if (!url) {
        setWaveforms((prev) => new Map(prev).set(ref, "missing"));
        return;
      }
      loadingRefs.current.add(ref);
      setWaveforms((prev) => new Map(prev).set(ref, "loading"));
      (async () => {
        try {
          const buffer = await decodeCached(ref, url);
          setWaveforms((prev) =>
            new Map(prev).set(ref, { peaks: peaksOf(buffer, PEAK_BUCKETS), duration: buffer.duration }),
          );
        } catch {
          setWaveforms((prev) => new Map(prev).set(ref, "missing"));
        } finally {
          loadingRefs.current.delete(ref);
        }
      })();
    },
    [decodeCached],
  );

  const assignPad = useCallback(
    (index: number, ref: string) => {
      setNames((prev) => prev.map((n, i) => (i === index ? ref : n)));
      ensureWaveform(ref);
    },
    [ensureWaveform],
  );

  const clearPad = useCallback((index: number) => {
    setNames((prev) => prev.map((n, i) => (i === index ? null : n)));
  }, []);

  // Dropping a whole bank loads the entire grid at once — slice 0 onto pad 1, slice 1 onto
  // pad 2, etc, up to PAD_COUNT — overwriting whatever those pads held, regardless of
  // which pad it landed on. Slices beyond PAD_COUNT (or pads beyond the bank's own slice
  // count) are left alone.
  const fillFromBank = useCallback(
    (bank: PadBank) => {
      const n = Math.min(PAD_COUNT, bank.slices.length);
      setNames((prev) => prev.map((existing, i) => (i < n ? bank.slices[i] : existing)));
      for (let i = 0; i < n; i++) ensureWaveform(bank.slices[i]);
    },
    [ensureWaveform],
  );

  // See PadGridHandle's doc comment — lights up every pad currently holding `ref` without
  // triggering any audio of its own; the pattern actually sounding it plays straight
  // through the shared scheduler, entirely outside this component. Silently does nothing
  // if Strudel hasn't initialized yet (nothing can be playing in that case anyway) or if
  // no pad currently holds `ref`.
  const flash = useCallback((ref: string) => {
    const ac = getStrudelIfReady()?.getAudioContext();
    if (!ac) return;
    const startAt = ac.currentTime;
    setPlaying((prev) => {
      let next: Map<number, PlayState> | null = null;
      latest.current.names.forEach((n, i) => {
        if (n !== ref) return;
        if (!next) next = new Map(prev);
        next.set(i, { startAt, duration: FLASH_DURATION });
      });
      return next ?? prev;
    });
  }, []);

  useImperativeHandle(handleRef, () => ({ fillFromBank, flash }), [fillFromBank, flash]);

  const toggleCut = useCallback((index: number) => {
    setCutModes((prev) => prev.map((c, i) => (i === index ? !c : c)));
  }, []);

  // Stops every *other* cut-enabled pad that's still sounding — the shared choke group.
  // Also drops their `playing` entries immediately so the rAF loop stops drawing progress
  // for a voice that's actually gone silent, rather than animating out to its original
  // (now moot) duration.
  const chokeGroup = useCallback((triggeredIndex: number) => {
    const { cutModes } = latest.current;
    const toChoke: number[] = [];
    for (const i of activeSources.current.keys()) {
      if (i !== triggeredIndex && cutModes[i]) toChoke.push(i);
    }
    if (toChoke.length === 0) return;
    for (const i of toChoke) activeSources.current.get(i)?.stop();
    setPlaying((prev) => {
      if (!toChoke.some((i) => prev.has(i))) return prev;
      const next = new Map(prev);
      for (const i of toChoke) next.delete(i);
      return next;
    });
  }, []);

  const triggerPad = useCallback(
    async (index: number) => {
      const ref = latest.current.names[index];
      if (!ref) return;
      // Timestamped here, not after the decode/schedule below — a first hit on a not-yet-
      // decoded pad can take a while, and the press-recorder needs the moment you actually
      // hit the pad, not whenever its audio happened to become ready.
      onTrigger?.(ref);
      const url = latest.current.refUrls.get(ref);
      try {
        const strudel = await getStrudel();
        const ac = strudel.getAudioContext();
        // Resolved directly (not read off the `waveforms` display cache, which may not
        // have settled yet on this pad's very first hit) — decodeCached shares its buffer
        // cache with ensureWaveform, so this costs nothing once that's already run.
        const buffer = url ? await decodeCached(ref, url) : null;
        ensureWaveform(ref);
        if (!buffer) throw new Error("no audio decoded for this ref");
        const duration = buffer.duration;
        const startAt = ac.currentTime + 0.01;

        // "cut" mode: retriggering this pad chokes whatever it's still playing (itself, and
        // every other cut-enabled pad — see chokeGroup) rather than layering on top of it,
        // the usual one-shot-drum-pad behavior; off, hits stack freely for deliberate
        // rolls/buildups. Played as a raw buffer source (not through superdough)
        // specifically so we keep a handle to `.stop()` on the next hit — superdough's
        // public API doesn't hand back anything stoppable.
        if (latest.current.cutModes[index]) {
          activeSources.current.get(index)?.stop();
          chokeGroup(index);
        }
        const source = ac.createBufferSource();
        source.buffer = buffer;
        source.connect(ac.destination);
        source.start(startAt);
        activeSources.current.set(index, source);
        source.addEventListener("ended", () => {
          // Only clear the slot if we're still the pad's current voice — an older,
          // layered (cut-off) hit finishing shouldn't clobber a newer one's entry.
          if (activeSources.current.get(index) === source) activeSources.current.delete(index);
        });

        setPlaying((prev) => new Map(prev).set(index, { startAt, duration }));
      } catch (err) {
        console.error(`pad ${index + 1} ("${ref}") failed to trigger:`, err);
      }
    },
    [decodeCached, ensureWaveform, chokeGroup, onTrigger],
  );

  // One rAF loop for the whole grid — redraws every pad's canvas each frame and retires
  // playing entries once their duration has elapsed. Reads everything through `latest` so
  // it never needs to restart.
  useEffect(() => {
    let raf: number;
    function tick() {
      const strudel = getStrudelIfReady();
      const ac = strudel?.getAudioContext();
      const { names, waveforms, playing } = latest.current;
      const expired: number[] = [];
      for (let i = 0; i < names.length; i++) {
        const canvas = canvasRefs.current.get(i);
        if (!canvas) continue;
        const ref = names[i];
        const wf = ref ? waveforms.get(ref) : undefined;
        const play = playing.get(i);
        const progress = play && ac ? (ac.currentTime - play.startAt) / play.duration : null;
        drawPad(canvas, wf, progress, ref ? hueForBank(bankNameOf(ref)) : DEFAULT_HUE);
        if (play && ac && ac.currentTime >= play.startAt + play.duration) expired.push(i);
      }
      if (expired.length) {
        setPlaying((prev) => {
          const next = new Map(prev);
          for (const i of expired) next.delete(i);
          return next;
        });
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Keyboard triggers — guarded so typing in the room-name/set-title inputs doesn't get
  // eaten by pad shortcuts that reuse plain letter keys.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (isTypingTarget(document.activeElement)) return;
      const index = PAD_KEYS.indexOf(e.key.toLowerCase());
      if (index === -1) return;
      e.preventDefault();
      triggerPad(index);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [triggerPad]);

  return (
    <div className="pad-grid">
      {names.map((ref, index) => (
        <div
          key={index}
          className={`pad${ref ? " filled" : ""}${dragOverIndex === index ? " dragover" : ""}${playing.has(index) ? " sounding" : ""}`}
          style={{ "--pad-hue": ref ? hueForBank(bankNameOf(ref)) : DEFAULT_HUE } as CSSProperties}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverIndex(index);
          }}
          onDragLeave={() => setDragOverIndex((cur) => (cur === index ? null : cur))}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverIndex(null);
            const dropped = e.dataTransfer.getData("text/plain").trim();
            if (!dropped) return;
            const bank = bankByName.get(dropped);
            if (isBankName(dropped, bank)) {
              fillFromBank(bank as PadBank);
            } else {
              assignPad(index, dropped);
            }
          }}
          onClick={() => triggerPad(index)}
          onContextMenu={(e) => {
            e.preventDefault();
            clearPad(index);
          }}
          title={
            ref
              ? `${ref}${PAD_KEYS[index] ? ` · key "${PAD_KEYS[index]}"` : ""} · click to play, right-click to clear`
              : `drag a slice here, or drop a whole bank to fill all ${PAD_COUNT}${PAD_KEYS[index] ? ` (key "${PAD_KEYS[index]}")` : ""}`
          }
        >
          <canvas
            ref={(el) => {
              if (el) canvasRefs.current.set(index, el);
              else canvasRefs.current.delete(index);
            }}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className="pad-canvas"
          />
          {PAD_KEYS[index] && <span className="pad-key">{PAD_KEYS[index]}</span>}
          <span className="pad-name">{ref ?? "empty"}</span>
          {ref && (
            <>
              <button
                className="pad-clear"
                onClick={(e) => {
                  e.stopPropagation();
                  clearPad(index);
                }}
                aria-label={`clear pad ${index + 1}`}
                title="clear this pad"
              >
                ×
              </button>
              <button
                className={`pad-cut${cutModes[index] ? " active" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleCut(index);
                }}
                aria-label={`cut mode ${cutModes[index] ? "on" : "off"} for pad ${index + 1}`}
                title={
                  cutModes[index]
                    ? "cut: on — hitting this pad chokes itself and every other cut-on pad (click to allow layering)"
                    : "cut: off — this pad layers freely and won't be choked by other cut-on pads (click to join the choke group)"
                }
              >
                cut
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
});
