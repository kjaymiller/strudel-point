import {
  groupSampleBanks,
  LibraryDrawer,
  playableName,
  type RegisteredSound,
  requestStemSeparation,
  type StemResult,
} from "@strudel-point/library";
import type { ChannelEvent, CreateTrackInput, CustomSample, StrudelJson, Track } from "@strudel-point/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeAudioFile, sliceToFile } from "./audio/beatcut";
import {
  buildRackCode,
  buildRecordingCode,
  estimateBpmFromHits,
  parseSliceRef,
  parseTrackBpm,
  type RecordedHit,
} from "./chain";
import { BeatCutter } from "./components/BeatCutter";
import { PAD_COUNT, PadGrid, type PadGridHandle } from "./components/PadGrid";
import { SampleShelf } from "./components/SampleShelf";
import { getStrudel, listRegisteredSounds } from "./strudel";
import { useChannelSocket } from "./ws";

// Debounce for the pad-recording autosave (see the effect near stopRecording) — a take
// only actually changes when you stop recording, so this mostly just guards against
// stopping/restarting a take in quick succession spamming /api/tracks. The rack below
// saves on demand instead (see saveRack) — no debounce needed for something a button
// triggers directly.
const AUTOSAVE_DEBOUNCE_MS = 1500;
const DEFAULT_RECORD_BPM = 120;
// 4 beats/cycle, same convention chain.ts's buildRecordingCode (and the rest of this app's
// tempo math) already uses — one full cycle's worth of count-in before capture starts.
const COUNT_IN_BEATS = 4;
// Fixed draw() id for the "visualize whatever's playing" loop (see playVisualized below),
// distinct from any other .draw() user in this app (there isn't one yet) — reusing the
// same id is what lets playing the rack/a recording/a loaded track again supersede the
// previous visualization loop instead of stacking a second one on top of it, same
// reasoning as apps/dj/src/App.tsx used to give this (before dj dropped pads entirely).
const PAD_TRACK_DRAW_ID = 7;

interface BankOption {
  bankName: string;
  slices: string[];
  urls: string[];
}

function channelIdFromLocation(): string {
  const hash = location.hash.replace(/^#/, "");
  return hash || "lobby";
}

function trackIdFromLocation(): string | null {
  return new URLSearchParams(location.search).get("track");
}

function ensureUsername(): string {
  // Same localStorage key the main web app (and dj) use, so opening any of these apps in
  // one browser shows up as one identity in the room rather than three strangers.
  const existing = localStorage.getItem("strudel-point:username");
  if (existing) return existing;
  const generated = `guest-${Math.random().toString(36).slice(2, 6)}`;
  localStorage.setItem("strudel-point:username", generated);
  return generated;
}

async function jsonOrThrow(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `request failed with ${res.status}`);
  }
  return res.json();
}

/** Groups a channel's custom samples into playable banks — built on
 * @strudel-point/library's groupSampleBanks (the same grouping every strudel-point app
 * now shares), just reshaped into this app's own BankOption (PadGrid/SampleShelf's
 * {bankName, slices, urls} — a standalone single becomes its own one-slice "bank" here,
 * so both kinds of row can drag/drop through the identical pad-grid code path). */
function groupBanks(samples: CustomSample[]): BankOption[] {
  const { banks, singles } = groupSampleBanks(samples);
  const fromBanks = banks.map((b) => ({
    bankName: b.bankName,
    slices: b.slices.map((s) => `${b.bankName}:${s.bankIndex}`),
    urls: b.slices.map((s) => s.url),
  }));
  const fromSingles = singles.map((s) => ({ bankName: s.name, slices: [s.name], urls: [s.url] }));
  return [...fromBanks, ...fromSingles].sort((a, b) => a.bankName.localeCompare(b.bankName));
}

function navigateToChannel(channelId: string) {
  location.hash = channelId;
}

// Guards the spacebar record shortcut below the same way PadGrid guards its own pad-key
// shortcuts — so typing in the room/title/bpm inputs doesn't get eaten by it.
function isTypingTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

// Same sanitizing rule as apps/web/src/components/CustomSamples.tsx's suggestName (and
// apps/dj/src/App.tsx's copy of it) — Strudel sample names end up as bare identifiers
// (s("name")), so keep them safe.
function suggestSampleName(fileName: string): string {
  return (
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .slice(0, 64) || "sample"
  );
}

export default function App() {
  const [channelId, setChannelId] = useState(channelIdFromLocation);
  const [username] = useState(ensureUsername);
  const [roomInput, setRoomInput] = useState(channelId);
  const [banks, setBanks] = useState<BankOption[]>([]);
  // Raw (ungrouped) form of the same fetch `refreshBanks` already does, plus this room's
  // saved Tracks and the live sound registry — the three things @strudel-point/library's
  // <LibraryDrawer> renders. `banks` above stays the source PadGrid/SampleShelf actually
  // drive; these are just reshaped/additional views onto the same data for the drawer.
  const [rawCustomSamples, setRawCustomSamples] = useState<CustomSample[]>([]);
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([]);
  const [registeredSounds, setRegisteredSounds] = useState<RegisteredSound[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rackTitle, setRackTitle] = useState("");
  // This room's one rack Track, saved on demand (see saveRack below) rather than
  // autosaved — filling/clearing pads is exploratory and happens constantly, and
  // shouldn't be quietly writing a database row on every change.
  const [savedTrack, setSavedTrack] = useState<Track | null>(null);
  const [autosaveState, setAutosaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const savedTrackRef = useRef<Track | null>(null);
  useEffect(() => {
    savedTrackRef.current = savedTrack;
  }, [savedTrack]);
  // The rack's current pad assignments, lifted out of PadGrid via its onChange — this is
  // the one thing that turns into Strudel source for the saved Track (see chain.ts).
  const [rackNames, setRackNames] = useState<(string | null)[]>(Array(PAD_COUNT).fill(null));
  const hasRackContent = rackNames.some((n) => n !== null);
  // Imperative escape hatch into PadGrid — auto-filling the grid right after a fresh
  // drop-and-cut upload finishes (see uploadBank below), and lighting up whatever pads a
  // playing pattern is actually sounding (see playVisualized below); everything else about
  // the grid stays owned by PadGrid itself.
  const padGridRef = useRef<PadGridHandle>(null);
  // ?track=<id> loads a previously-saved track (this room's rack, its pad recording, or
  // any Track from the main editor/dj app — it's all just Strudel source) for a one-click
  // "play this track" rather than auto-evaluating on load, since audio can't start without
  // a real user gesture anyway.
  const [loadedTrack, setLoadedTrack] = useState<Track | null>(null);

  // A background upload's progress, shown as a persistent status bar rather than inside
  // the (now already-dismissed) BeatCutter overlay — see confirmCut/uploadBank below.
  const [uploadStatus, setUploadStatus] = useState<{
    bankName: string;
    done: number;
    total: number;
    state: "uploading" | "done" | "error";
    message?: string;
  } | null>(null);
  // One entry per dropped file awaiting review in <BeatCutter>, processed head-first.
  const [reviewQueue, setReviewQueue] = useState<{ file: File; buffer: AudioBuffer }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The press-recorder: while `recording`, every pad hit (see handlePadTrigger, wired to
  // PadGrid's onTrigger) is timestamped relative to `recordStartRef` and pushed onto
  // `hitsRef`. Kept as a ref rather than state — timestamps need to land in real time
  // without waiting on a render, and nothing about the recording itself needs to be
  // reactive except the hit *count* (for UI feedback) and the on/off flag.
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const recordStartRef = useRef(0);
  const hitsRef = useRef<RecordedHit[]>([]);
  const [hitCount, setHitCount] = useState(0);
  const [recordBpm, setRecordBpm] = useState(DEFAULT_RECORD_BPM);
  const [recordedCode, setRecordedCode] = useState<string | null>(null);
  // The bpm actually baked into `recordedCode` at the moment recording stopped — kept
  // separate from the live `recordBpm` input (which stays editable afterward, for the
  // *next* take) so a saved track's `strudelJson.cps` always matches the code that's
  // actually in it, even if you nudge the bpm field before starting a fresh recording.
  const [recordedBpm, setRecordedBpm] = useState(DEFAULT_RECORD_BPM);
  const [recordTitle, setRecordTitle] = useState("");
  // One pad track per room, same as the rack below: the first stopped recording creates
  // it, every recording after that PUT-updates that same row. "new pad track" (see
  // startNewPadTrack) is the deliberate escape hatch — it forgets this pointer so the
  // *next* stop-recording creates a fresh row instead of overwriting this one.
  const [recordedTrack, setRecordedTrack] = useState<Track | null>(null);
  const recordedTrackRef = useRef<Track | null>(null);
  useEffect(() => {
    recordedTrackRef.current = recordedTrack;
  }, [recordedTrack]);
  const [recordAutosaveState, setRecordAutosaveState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const recordAutosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutosavedRecordRef = useRef<string | null>(null);
  // Bumped by "new pad track" to force the autosave effect below to re-fire even though
  // `recordedCode` itself didn't change — clearing `lastAutosavedRecordRef` alone wouldn't
  // do that on its own, since the effect only re-runs when one of its dependencies does.
  const [recordGeneration, setRecordGeneration] = useState(0);

  // A white-noise click track at `recordBpm`, accented every 4th beat (the same
  // "4 beats/cycle" convention the rest of this app's tempo math uses) — toggleable on its
  // own for jamming along, and also what "● record" runs as a count-in before it actually
  // starts capturing hits, so the very first beat you play to lines up with something
  // audible rather than a silent guess. `metronomeBeatRef` is the running beat counter (not
  // state — it drives audio scheduling every tick, not a render); `countIn`, in beats
  // remaining, *is* state purely so the record button can show it.
  const [metronomeOn, setMetronomeOn] = useState(false);
  const metronomeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const metronomeBeatRef = useRef(0);
  const [countIn, setCountIn] = useState<number | null>(null);

  // One white-noise burst — direct through superdough, same as pad triggers/previews, so
  // it never touches (or waits on) the pattern scheduler. Best-effort: a missed click
  // shouldn't ever be worth surfacing as an error banner, let alone blocking recording.
  const playClick = useCallback(async (accented: boolean) => {
    try {
      const strudel = await getStrudel();
      const ac = strudel.getAudioContext();
      await strudel.superdough(
        { s: "white", decay: 0.05, gain: accented ? 1 : 0.55 },
        ac.currentTime + 0.01,
        0.05,
      );
    } catch {
      // see above — a dropped click isn't worth reportError-ing over
    }
  }, []);

  const stopMetronome = useCallback(() => {
    if (metronomeTimerRef.current) clearInterval(metronomeTimerRef.current);
    metronomeTimerRef.current = null;
    setMetronomeOn(false);
  }, []);

  // Continuous click at `bpm`, accented every 4th beat — restarts the accent count from
  // beat 1 each time this is called (so calling it fresh right after a count-in, as
  // startRecording does, lines its first continuous beat up with the recording's own
  // beat 1, not wherever a previously-running standalone metronome happened to be).
  const startMetronome = useCallback(
    (bpm: number) => {
      stopMetronome();
      const beatMs = (60 / bpm) * 1000;
      metronomeBeatRef.current = 0;
      void playClick(true);
      metronomeBeatRef.current = 1;
      metronomeTimerRef.current = setInterval(() => {
        void playClick(metronomeBeatRef.current % 4 === 0);
        metronomeBeatRef.current += 1;
      }, beatMs);
      setMetronomeOn(true);
    },
    [playClick, stopMetronome],
  );

  const toggleMetronome = useCallback(() => {
    if (metronomeOn) stopMetronome();
    else startMetronome(recordBpm);
  }, [metronomeOn, stopMetronome, startMetronome, recordBpm]);

  const reportError = useCallback((message: string) => setError(message), []);

  const refreshBanks = useCallback(async () => {
    const samples: CustomSample[] = await fetch(`/api/channels/${channelId}/samples`).then(jsonOrThrow);
    setRawCustomSamples(samples);
    const grouped = groupBanks(samples);
    setBanks(grouped);
    // Register every bank with Strudel as soon as we know about it, same reasoning as
    // apps/dj/src/App.tsx's refreshBanks — a saved rack can reference a bank by name
    // without anyone having dragged it onto a pad this session.
    const strudel = await getStrudel();
    await Promise.all(grouped.map((b) => strudel.samples({ [b.bankName]: b.urls })));
    setRegisteredSounds(await listRegisteredSounds());
  }, [channelId]);

  const handleEvent = useCallback(
    (event: ChannelEvent) => {
      if (event.type === "sample:added" || event.type === "sample:removed" || event.type === "bank:renamed") {
        // Cheapest correct response to a bank changing mid-session: just refetch the
        // list — these are infrequent, human-triggered events, not worth patching in place.
        refreshBanks().catch(() => {});
      }
    },
    [refreshBanks],
  );

  const { connected, send } = useChannelSocket({
    channelId,
    username,
    onEvent: handleEvent,
    onError: reportError,
  });

  useEffect(() => {
    const onHashChange = () => setChannelId(channelIdFromLocation());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const id = trackIdFromLocation();
    if (!id) return;
    fetch(`/api/tracks/${id}`)
      .then(jsonOrThrow)
      .then((track: Track) => {
        setLoadedTrack(track);
        if (track.channelId !== channelId) navigateToChannel(track.channelId);
        // Adopt the loaded track's own declared tempo (if it has one — see chain.ts's
        // parseTrackBpm) as this app's own bpm, so the metronome/count-in for whatever
        // you record or jam along with next actually matches what you just loaded,
        // instead of leaving it at whatever was dialed in before.
        const bpm = parseTrackBpm(track.code);
        if (bpm) setRecordBpm(Math.max(20, Math.min(300, Math.round(bpm))));
      })
      .catch((err) => reportError(`couldn't load that track: ${err.message}`));
  }, [reportError]); // eslint-disable-line react-hooks/exhaustive-deps -- runs once, from the URL as loaded

  // This room's saved Tracks, for @strudel-point/library's <LibraryDrawer> — new here
  // (pads never browsed the full list before, only ever a single `?track=` load).
  useEffect(() => {
    fetch(`/api/channels/${channelId}/tracks`)
      .then(jsonOrThrow)
      .then(setLibraryTracks)
      .catch((err) => reportError(`couldn't load saved tracks: ${err.message}`));
  }, [channelId, reportError]);

  useEffect(() => {
    setRoomInput(channelId);
    setSavedTrack(null);
    setAutosaveState("idle");
    setRecordedCode(null);
    setRecordedTrack(null);
    lastAutosavedRecordRef.current = null;
    setRecordAutosaveState("idle");
    recordingRef.current = false;
    setRecording(false);
    setCountIn(null);
    stopMetronome();
    refreshBanks().catch((err) => reportError(`couldn't load this room's sound banks: ${err.message}`));
  }, [channelId, reportError, refreshBanks, stopMetronome]);

  // Every slice ref known in this room, mapped to its audio url — feeds PadGrid's
  // decode-on-drop/trigger, independent of which bank (if any) has been dragged anywhere.
  const refUrls = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of banks) b.slices.forEach((ref, i) => m.set(ref, b.urls[i]));
    return m;
  }, [banks]);

  // One-shot preview straight through superdough — same reasoning as PadGrid's trigger:
  // evaluate() would disturb whatever pattern is actually playing in the room just to
  // audition a slice from the shelf.
  const previewSample = useCallback(
    async (ref: string) => {
      const url = refUrls.get(ref);
      if (!url) return;
      try {
        const strudel = await getStrudel();
        const ac = strudel.getAudioContext();
        const res = await fetch(url);
        if (!res.ok) throw new Error(`couldn't fetch "${ref}" (${res.status})`);
        const buffer = await ac.decodeAudioData(await res.arrayBuffer());
        const { s, n } = parseSliceRef(ref);
        await strudel.superdough({ s, n }, ac.currentTime + 0.01, buffer.duration);
      } catch (err) {
        reportError(`couldn't preview "${ref}": ${err instanceof Error ? err.message : err}`);
      }
    },
    [refUrls, reportError],
  );

  // A simpler preview for @strudel-point/library's <LibraryDrawer> "all sounds" tab —
  // that list spans built-in packs too, which have no fetchable `url` of their own for
  // previewSample's manual decode path to use, so this just triggers superdough directly
  // and lets it resolve the name against whatever's already registered.
  const previewLibrarySound = useCallback(
    (name: string) => {
      // `name` may carry Strudel's "bank:index" mini-notation suffix (e.g. from a
      // registered sample bank slice) — superdough looks up `s` as a literal registry
      // key and never splits that suffix itself, so it has to be split here or the
      // lookup misses even though the bank is loaded.
      const { s, n } = parseSliceRef(name);
      getStrudel()
        .then((strudel) => strudel.superdough({ s, n }, strudel.getAudioContext().currentTime + 0.05, 0.5))
        .catch((err) =>
          reportError(`couldn't preview "${name}": ${err instanceof Error ? err.message : err}`),
        );
    },
    [reportError],
  );

  // Press-and-hold on a bank's name (see SampleShelf) plays through its slices in
  // sequence, one after another — an audition of the whole bank, not a loop. Release
  // stops it before the next slice starts. A cancellation token rather than
  // AbortController since all that's needed is "stop scheduling more slices", checked
  // between each one.
  const previewSequenceToken = useRef<{ cancelled: boolean } | null>(null);

  const previewBankSequence = useCallback(
    async (bankName: string) => {
      const bank = banks.find((b) => b.bankName === bankName);
      if (!bank) return;
      const token = { cancelled: false };
      previewSequenceToken.current = token;
      try {
        const strudel = await getStrudel();
        const ac = strudel.getAudioContext();
        for (const ref of bank.slices) {
          if (token.cancelled) break;
          const url = refUrls.get(ref);
          if (!url) continue;
          const res = await fetch(url);
          if (!res.ok) continue;
          const buffer = await ac.decodeAudioData(await res.arrayBuffer());
          if (token.cancelled) break;
          const { s, n } = parseSliceRef(ref);
          await strudel.superdough({ s, n }, ac.currentTime + 0.01, buffer.duration);
          await new Promise<void>((resolve) => setTimeout(resolve, buffer.duration * 1000));
        }
      } catch (err) {
        reportError(`couldn't preview "${bankName}": ${err instanceof Error ? err.message : err}`);
      }
    },
    [banks, refUrls, reportError],
  );

  const stopPreviewBankSequence = useCallback(() => {
    if (previewSequenceToken.current) previewSequenceToken.current.cancelled = true;
  }, []);

  // Uploads one already-cut slice as part of `bankName` at `bankIndex` — same
  // POST /api/channels/:channelId/samples the web app's CustomSamples/BeatAnalyzer and the
  // dj app's own dropzone hit, no gateway changes needed. Returns the created sample
  // (rather than void) so uploadBank can build the resulting bank's url list itself,
  // straight from what it just uploaded — no need to wait on/search `banks`, which
  // wouldn't have caught up yet anyway (see uploadBank's own comment).
  const uploadSlice = useCallback(
    async (file: File, name: string, bankName: string, bankIndex: number): Promise<CustomSample> => {
      const form = new FormData();
      form.append("file", file);
      form.append("name", name);
      form.append("bankName", bankName);
      form.append("bankIndex", String(bankIndex));
      const sample: CustomSample = await fetch(`/api/channels/${channelId}/samples`, {
        method: "POST",
        body: form,
      }).then(jsonOrThrow);
      send({ type: "sample:added", sample });
      return sample;
    },
    [channelId, send],
  );

  // Drop audio straight onto the pads app to add it as a loadable bank, without switching
  // over to the main editor's beat-analyzer tab (or the dj app) first. Each dropped file is
  // decoded and queued for review in <BeatCutter> (drag markers, merge, split) rather than
  // auto-cut-and-uploaded blind, since the auto-detected cycle count is only a guess.
  // Reviewed one file at a time via `reviewQueue`.
  const uploadFiles = useCallback(
    async (files: FileList | null) => {
      if (!files) return;
      const audioFiles = Array.from(files).filter((f) => f.type.startsWith("audio/"));
      if (audioFiles.length === 0) return;
      try {
        const decoded = await Promise.all(
          audioFiles.map(async (file) => ({ file, buffer: await decodeAudioFile(file) })),
        );
        setReviewQueue((prev) => [...prev, ...decoded]);
      } catch (err) {
        reportError(`couldn't read that file: ${err instanceof Error ? err.message : err}`);
      }
    },
    [reportError],
  );

  // Runs in the background after the BeatCutter overlay has already closed (see
  // confirmCut) — progress goes to the uploadStatus bar instead of a prop on a modal
  // that's no longer there to receive it. Once every slice is up, fills the whole pad
  // grid from the resulting bank (see PadGridHandle) — built directly from what was just
  // uploaded, not a `banks` lookup, since `banks` wouldn't have caught up to refreshBanks()
  // yet (that update is still in flight/queued) — same reasoning as apps/dj/src/App.tsx's
  // loadBankOption comment.
  const uploadBank = useCallback(
    async (bankName: string, buffer: AudioBuffer, ranges: { start: number; end: number }[]) => {
      // bankIndex 0 is always the whole, uncut loop — lets s("bankName:0") play the
      // original alongside the individually cut pieces at 1..N, rather than forcing a
      // choice between "the loop" and "its slices". The editor's own slices (whatever
      // merging/splitting happened there) shift up to start at 1.
      const full = { start: 0, end: buffer.duration };
      const all = [full, ...ranges];
      setUploadStatus({ bankName, done: 0, total: all.length, state: "uploading" });
      try {
        const samples: CustomSample[] = [];
        // Sequential, not parallel — keeps upload order (and therefore bank index)
        // deterministic; each slice is small enough this isn't a meaningful latency hit.
        for (let i = 0; i < all.length; i++) {
          const slice = sliceToFile(buffer, all[i].start, all[i].end, `${bankName}-${i}.wav`);
          samples.push(await uploadSlice(slice, `${bankName}-${i}`, bankName, i));
          setUploadStatus((prev) => (prev && prev.bankName === bankName ? { ...prev, done: i + 1 } : prev));
        }
        await refreshBanks();
        setUploadStatus((prev) => (prev && prev.bankName === bankName ? { ...prev, state: "done" } : prev));
        padGridRef.current?.fillFromBank({
          bankName,
          slices: samples.map((_, i) => `${bankName}:${i}`),
        });
      } catch (err) {
        setUploadStatus((prev) =>
          prev && prev.bankName === bankName
            ? { ...prev, state: "error", message: err instanceof Error ? err.message : String(err) }
            : prev,
        );
      }
    },
    [uploadSlice, refreshBanks],
  );

  // Enables the shared library's "edit" tab (see @strudel-point/library's LibraryTray)
  // to rename a bank the same way this app's own drop-and-cut flow creates one — the
  // "bank:renamed" branch already wired into handleEvent above (it just calls
  // refreshBanks()) picks the result up the same round trip every other client's does.
  const renameBank = useCallback(
    async (oldName: string, newName: string) => {
      try {
        await fetch(`/api/channels/${channelId}/banks/${encodeURIComponent(oldName)}/rename`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ newName }),
        }).then(jsonOrThrow);
        await refreshBanks();
        send({ type: "bank:renamed", oldName, newName, samples: [] });
      } catch (err) {
        reportError(`couldn't rename "${oldName}": ${err instanceof Error ? err.message : err}`);
      }
    },
    [channelId, send, refreshBanks, reportError],
  );

  // Feeds the sample editor's "separate into stems" button — the four resulting samples
  // are already stored server-side by the time this resolves, so this only needs to
  // announce them (refreshBanks picks them up the same way any other upload does) and
  // hand back their playable names/urls for the editor's own success message.
  const separateStems = useCallback(
    async (file: File, baseName: string): Promise<StemResult[]> => {
      const stems = await requestStemSeparation(channelId, file, baseName);
      for (const sample of stems) send({ type: "sample:added", sample });
      await refreshBanks();
      return stems.map((s) => ({ name: playableName(s), url: s.url }));
    },
    [channelId, send, refreshBanks],
  );

  // Confirming a cut closes the review overlay immediately — uploading (all N slices, one
  // request each) happens in the background instead of behind a modal that blocks the rest
  // of the app (and the next queued file's review) until every slice finishes.
  const confirmCut = useCallback(
    (bankName: string, ranges: { start: number; end: number }[]) => {
      const current = reviewQueue[0];
      if (!current) return;
      setReviewQueue((prev) => prev.slice(1));
      void uploadBank(bankName, current.buffer, ranges);
    },
    [reviewQueue, uploadBank],
  );

  const cancelCut = useCallback(() => {
    setReviewQueue((prev) => prev.slice(1));
  }, []);

  // Wired to PadGrid's onTrigger — every pad hit lands here first, recording or not; only
  // while `recording` does it actually get kept. Reading `recordingRef` (not the `recording`
  // state) so this stays a stable callback identity for PadGrid rather than resubscribing
  // every time recording toggles.
  const handlePadTrigger = useCallback((ref: string) => {
    if (!recordingRef.current) return;
    hitsRef.current.push({ ref, t: performance.now() - recordStartRef.current });
    setHitCount(hitsRef.current.length);
  }, []);

  // "● record" (button, or the spacebar — see the keydown effect below) always leads with
  // a 4-beat white-noise count-in at `recordBpm` (accented on 1) rather than starting
  // capture the instant you press it — otherwise the very first beat you actually mean to
  // play has nothing audible to land on. Real hit-capture (and the continuous metronome
  // that keeps going through the take) only starts once the count-in's last beat fires.
  const startRecording = useCallback(() => {
    if (recordingRef.current || countIn !== null) return;
    stopMetronome();
    hitsRef.current = [];
    setHitCount(0);
    setRecordedCode(null);
    const bpm = recordBpm;
    const beatMs = (60 / bpm) * 1000;
    let beat = 0;
    setCountIn(COUNT_IN_BEATS);
    const tick = () => {
      void playClick(beat === 0);
      beat += 1;
      if (beat < COUNT_IN_BEATS) {
        setCountIn(COUNT_IN_BEATS - beat);
        setTimeout(tick, beatMs);
        return;
      }
      setCountIn(null);
      recordStartRef.current = performance.now();
      recordingRef.current = true;
      setRecording(true);
      startMetronome(bpm);
    };
    tick();
  }, [recordBpm, countIn, playClick, stopMetronome, startMetronome]);

  // Stopping just freezes the take into real Strudel source (see chain.ts's
  // buildRecordingCode) — "▶ play recording" below is a separate, deliberate step; saving
  // itself happens automatically (see the autosave effect below), same as the rack.
  //
  // The cps that ends up in the code (and in `recordedBpm`, for the saved track's
  // strudelJson) comes from how you actually played it, not the bpm dialed in beforehand —
  // see chain.ts's estimateBpmFromHits. That's a best guess, not a certainty, so it only
  // takes over when there's actually enough of a performance to guess from; a one- or
  // two-hit take falls back to whatever bpm was set (the metronome you counted in against,
  // if nothing else). Feeding the detected bpm back into the input, too, means the *next*
  // take's count-in/metronome picks up wherever this one left off tempo-wise.
  const stopRecording = useCallback(() => {
    recordingRef.current = false;
    setRecording(false);
    stopMetronome();
    const hits = hitsRef.current;
    const detected = estimateBpmFromHits(hits);
    const bpm = detected ?? recordBpm;
    if (detected) setRecordBpm(Math.max(20, Math.min(300, Math.round(detected))));
    setRecordedBpm(bpm);
    setRecordedCode(buildRecordingCode(hits, bpm));
  }, [recordBpm, stopMetronome]);

  // The spacebar record shortcut — global rather than tied to a specific element, so it
  // works no matter what's focused on the page (short of an actual text field). Space is
  // free precisely because PAD_KEYS never claims it; every other key that could plausibly
  // mean "record" is already a pad.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (isTypingTarget(document.activeElement)) return;
      if (e.code !== "Space") return;
      e.preventDefault();
      if (recordingRef.current) stopRecording();
      else if (countIn === null) startRecording();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [startRecording, stopRecording, countIn]);

  // Shared tail end of every "play some code, for the whole room" path (the rack, a
  // recording, a loaded track) — evaluates it, broadcasts it same as the main editor/dj do,
  // and attaches a draw() loop that lights up whichever pads (see PadGridHandle.flash) the
  // pattern is actually sounding as it plays. That observation is exactly what dj's own
  // playLoadedTrack used to do before dj dropped pads entirely (see chain.ts's
  // buildRecordingCode for the other half of that same "real Strudel, not a shadow
  // format" idea) — the pattern itself is what's playing; this only ever watches it.
  const playVisualized = useCallback(
    async (code: string) => {
      const strudel = await getStrudel();
      const pattern = await strudel.evaluate(code);
      send({ type: "eval", paneId: "pads", code });
      pattern?.draw(
        (haps, time) => {
          for (const hap of haps) {
            if (!hap.isActive(time)) continue;
            const s = hap.value.s;
            if (typeof s !== "string") continue;
            const n = hap.value.n;
            const ref = typeof n === "number" ? `${s}:${n}` : s;
            padGridRef.current?.flash(ref);
          }
        },
        { lookbehind: 0, lookahead: 0.1, id: PAD_TRACK_DRAW_ID },
      );
    },
    [send],
  );

  const playRecording = useCallback(async () => {
    if (!recordedCode) return;
    try {
      await playVisualized(recordedCode);
    } catch (err) {
      reportError(`recording failed to play: ${err instanceof Error ? err.message : err}`);
    }
  }, [recordedCode, playVisualized, reportError]);

  // Auto-save, same convention as the rack below: whatever the latest stopped take is,
  // this room's one pad-recording Track should just reflect it, no separate save button
  // needed. The first take creates it; every take after that PUT-updates that same row —
  // that's the "only one pad track, update it when you have changes" behavior. Forgetting
  // the pointer (see startNewPadTrack) is the only way to make the *next* take start a new
  // row instead — bumping `recordGeneration` is what makes that happen even when
  // `recordedCode` itself hasn't changed since the last save.
  useEffect(() => {
    if (!recordedCode || recording) return;
    if (recordAutosaveTimer.current) clearTimeout(recordAutosaveTimer.current);
    recordAutosaveTimer.current = setTimeout(async () => {
      const title = recordTitle.trim() || "pad recording";
      const strudelJson: StrudelJson = { code: recordedCode, cps: recordedBpm / 4 / 60, version: 1 };
      const signature = JSON.stringify({ title, code: recordedCode });
      if (signature === lastAutosavedRecordRef.current) return;
      setRecordAutosaveState("saving");
      try {
        const existing = recordedTrackRef.current;
        const track: Track = existing
          ? await fetch(`/api/tracks/${existing.id}`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title, code: recordedCode, strudelJson }),
            }).then(jsonOrThrow)
          : await fetch("/api/tracks", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                channelId,
                title,
                author: username,
                code: recordedCode,
                strudelJson,
              } satisfies CreateTrackInput),
            }).then(jsonOrThrow);
        lastAutosavedRecordRef.current = signature;
        setRecordedTrack(track);
        setRecordAutosaveState("saved");
      } catch (err) {
        setRecordAutosaveState("error");
        reportError(`autosave failed: ${err instanceof Error ? err.message : err}`);
      }
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (recordAutosaveTimer.current) clearTimeout(recordAutosaveTimer.current);
    };
  }, [recordedCode, recording, recordedBpm, recordTitle, channelId, username, reportError, recordGeneration]);

  // The deliberate escape hatch: forgets which Track this room's takes have been updating,
  // so the *next* stopped recording creates a brand-new one instead of overwriting it. The
  // current take (recordedCode) is left alone — this only affects where the *next* save
  // (or, via recordGeneration, an immediate re-save of the current code) lands.
  const startNewPadTrack = useCallback(() => {
    setRecordedTrack(null);
    recordedTrackRef.current = null;
    lastAutosavedRecordRef.current = null;
    setRecordAutosaveState("idle");
    setRecordGeneration((g) => g + 1);
  }, []);

  const recordShareUrl = recordedTrack
    ? `${location.origin}${location.pathname}?track=${recordedTrack.id}#${channelId}`
    : null;

  // "▶ play rack" hands the current pad layout to the pattern scheduler as one loop (see
  // chain.ts's buildRackCode) and broadcasts it, same eval/hush convention the main
  // editor and dj use — so everyone else in the room hears it too. Individual pad hits
  // stay direct one-shots and never touch this.
  const playRack = useCallback(async () => {
    try {
      await playVisualized(buildRackCode(rackNames));
    } catch (err) {
      reportError(`rack failed to play: ${err instanceof Error ? err.message : err}`);
    }
  }, [rackNames, playVisualized, reportError]);

  const playLoadedTrack = useCallback(async () => {
    if (!loadedTrack) return;
    try {
      await playVisualized(loadedTrack.code);
    } catch (err) {
      reportError(`couldn't play "${loadedTrack.title}": ${err instanceof Error ? err.message : err}`);
    }
  }, [loadedTrack, playVisualized, reportError]);

  const hush = useCallback(async () => {
    try {
      const strudel = await getStrudel();
      strudel.hush();
    } catch (err) {
      reportError(`hush failed: ${err instanceof Error ? err.message : err}`);
    }
    send({ type: "hush", paneId: "pads" });
  }, [send, reportError]);

  // A deliberate save, not an autosave — dragging/clearing pads is exploratory, happens
  // constantly, and shouldn't be quietly writing (and rewriting) a database row on every
  // single change; a Track only gets made or touched when you actually press "save rack".
  // Same "one track per room" rule as the pad recording above once you do: the first save
  // creates it, every save after that PUT-updates that same row, until "new rack track"
  // forgets the pointer so the *next* save starts a fresh one instead.
  const saveRack = useCallback(async () => {
    if (!hasRackContent) return;
    const title = rackTitle.trim() || "untitled pad rack";
    const code = buildRackCode(rackNames);
    const strudelJson: StrudelJson = { code, version: 1 };
    setAutosaveState("saving");
    try {
      const existing = savedTrackRef.current;
      const track: Track = existing
        ? await fetch(`/api/tracks/${existing.id}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title, code, strudelJson }),
          }).then(jsonOrThrow)
        : await fetch("/api/tracks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              channelId,
              title,
              author: username,
              code,
              strudelJson,
            } satisfies CreateTrackInput),
          }).then(jsonOrThrow);
      setSavedTrack(track);
      setAutosaveState("saved");
    } catch (err) {
      setAutosaveState("error");
      reportError(`couldn't save rack: ${err instanceof Error ? err.message : err}`);
    }
  }, [hasRackContent, rackNames, rackTitle, channelId, username, reportError]);

  // The deliberate escape hatch, same as the pad recording's startNewPadTrack — forgets
  // which Track "save rack" has been updating, so the *next* save creates a brand-new one
  // instead of overwriting it.
  const startNewRackTrack = useCallback(() => {
    setSavedTrack(null);
    savedTrackRef.current = null;
    setAutosaveState("idle");
  }, []);

  const shareUrl = savedTrack
    ? `${location.origin}${location.pathname}?track=${savedTrack.id}#${channelId}`
    : null;

  return (
    <div className="pads-app">
      <header className="pads-header">
        <h1>strudel-point · pads</h1>
        <form
          className="room-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (roomInput.trim()) navigateToChannel(roomInput.trim());
          }}
        >
          <label>
            room
            <input value={roomInput} onChange={(e) => setRoomInput(e.target.value)} />
          </label>
          <button className="secondary" type="submit">
            go
          </button>
        </form>
        <span
          className={`connection-dot ${connected ? "connected" : ""}`}
          title={connected ? "connected" : "disconnected"}
        />
        <button
          className="secondary"
          onClick={playRack}
          disabled={!hasRackContent}
          title="play the current rack as a loop, for the whole room to hear"
        >
          ▶ play rack
        </button>
        <button className="secondary" onClick={hush}>
          ■ hush
        </button>
      </header>

      {/* The room's shared library, same drawer every strudel-point app renders (see
          @strudel-point/library) — this room's saved Tracks plus every registered sound
          (built-in packs + this room's own uploads, the latter already browsable via
          SampleShelf below too, just without the built-ins). Sound chips drag the same
          "text/plain" ref SampleShelf's own chips already do, so dropping one straight
          onto a pad works with no changes to PadGrid at all. */}
      <LibraryDrawer
        tracks={libraryTracks}
        customSamples={rawCustomSamples}
        registeredSounds={registeredSounds}
        onPreviewSound={previewLibrarySound}
        onUploadSlice={uploadSlice}
        onRenameBank={renameBank}
        onSeparateStems={separateStems}
      />

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="secondary" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      {uploadStatus && (
        <div className={`upload-status upload-status--${uploadStatus.state}`}>
          <div className="upload-status-row">
            <span>
              {uploadStatus.state === "uploading" &&
                `uploading "${uploadStatus.bankName}" — ${uploadStatus.done}/${uploadStatus.total} slices…`}
              {uploadStatus.state === "done" &&
                `✓ uploaded ${uploadStatus.total} slices as "${uploadStatus.bankName}" — all ${PAD_COUNT} pads filled`}
              {uploadStatus.state === "error" &&
                `upload of "${uploadStatus.bankName}" failed: ${uploadStatus.message}`}
            </span>
            <button className="secondary" onClick={() => setUploadStatus(null)}>
              dismiss
            </button>
          </div>
          <div className="upload-status-bar">
            <div
              className="upload-status-fill"
              style={{ width: `${uploadStatus.total ? (uploadStatus.done / uploadStatus.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {reviewQueue[0] && (
        <div className="beat-cutter-overlay">
          <BeatCutter
            key={reviewQueue[0].file.name + reviewQueue[0].file.size}
            buffer={reviewQueue[0].buffer}
            fileName={reviewQueue[0].file.name}
            bankNameSuggestion={suggestSampleName(reviewQueue[0].file.name)}
            uploading={false}
            onCancel={cancelCut}
            onConfirm={confirmCut}
          />
        </div>
      )}

      {loadedTrack &&
        (() => {
          const trackBpm = parseTrackBpm(loadedTrack.code);
          return (
            <div className="loaded-track">
              <span>
                loaded track "{loadedTrack.title}" (from this room's saved tracks)
                {trackBpm ? ` — bpm below adopted its ~${Math.round(trackBpm)} bpm` : ""} —
              </span>
              <button onClick={playLoadedTrack}>▶ play this track</button>
              <button className="secondary" onClick={hush}>
                ■ stop
              </button>
            </div>
          );
        })()}

      <div
        className={`dropzone ${dragOver ? "dragover" : ""}`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          uploadFiles(e.dataTransfer.files);
        }}
      >
        {reviewQueue.length > 0
          ? `drop a loop to cut into a bank (${reviewQueue.length} queued)`
          : `drop a loop here (or click to browse) to cut it into a bank and fill all ${PAD_COUNT} pads — auto-loads once cut`}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          uploadFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <section className="pad-section">
        <h2>pads</h2>
        <p className="hint">
          drag a slice from the shelf onto a pad, then click it (or, for the first 16, its key —
          1234/qwer/asdf/zxcv) to fire it straight through. Drag a bank's name instead (not one of its slices)
          onto the grid and it loads all {PAD_COUNT} pads at once — slice 0 onto pad 1, slice 1 onto pad 2,
          and so on. Press & hold a bank's name in the shelf to preview it in sequence without touching a pad
          at all.
        </p>
        <SampleShelf
          banks={banks}
          onPreview={previewSample}
          onPreviewBankStart={previewBankSequence}
          onPreviewBankStop={stopPreviewBankSequence}
        />
        <PadGrid
          ref={padGridRef}
          key={channelId}
          channelId={channelId}
          banks={banks}
          refUrls={refUrls}
          onChange={setRackNames}
          onTrigger={handlePadTrigger}
        />
      </section>

      <section className="record-section">
        <h2>record a performance</h2>
        <p className="hint">
          record hits the pads land while you're pressing them and turn them into their own Strudel track —
          every hit snapped to the nearest 16th note, two pads landing on the same step stacked together,
          empty steps as rests. Individual pad hits still fire as direct one-shots the whole time; recording
          only ever *observes* them. This room keeps just one pad-recording track — every take after the first
          auto-saves over it — until you press "new pad track" to start a fresh one. Hit record (or press
          spacebar) and a 4-beat white-noise count-in plays first, accented on 1, so your first hit has
          something to land on; the click keeps going through the take to keep you on the grid. Toggle the
          metronome on its own any time to jam along without recording anything. Stopping re-reads the bpm
          from how far apart your presses actually landed (not just the number below) whenever there's enough
          of a take to tell — the field updates to match, so the next count-in picks up the same tempo.
        </p>
        <div className="record-controls">
          <label>
            bpm
            <input
              type="number"
              min={20}
              max={300}
              value={recordBpm}
              disabled={recording || countIn !== null}
              onChange={(e) => setRecordBpm(Math.max(20, Math.min(300, Number(e.target.value))))}
            />
          </label>
          <button
            className={`secondary${metronomeOn ? " active" : ""}`}
            onClick={toggleMetronome}
            title={metronomeOn ? "stop the metronome" : "start a standalone metronome click at the bpm above"}
          >
            {metronomeOn ? "🔊 metronome" : "🔇 metronome"}
          </button>
          {!recording ? (
            <button
              className="record-button"
              onClick={startRecording}
              disabled={countIn !== null}
              title="record (spacebar)"
            >
              {countIn !== null ? `counting in… ${countIn}` : "● record"}
            </button>
          ) : (
            <button className="record-button recording" onClick={stopRecording} title="stop (spacebar)">
              ■ stop
            </button>
          )}
          {recording && (
            <span className="record-hit-count">
              {hitCount} hit{hitCount === 1 ? "" : "s"} recorded…
            </span>
          )}
        </div>

        {recordedCode && !recording && (
          <>
            <p className="hint" style={{ margin: "0 0 6px" }}>
              recorded at ~{Math.round(recordedBpm)} bpm
            </p>
            <textarea className="record-code" value={recordedCode} readOnly spellCheck={false} rows={4} />
            <div className="save-set">
              <button className="secondary" onClick={playRecording}>
                ▶ play recording
              </button>
              <button className="secondary" onClick={hush}>
                ■ stop
              </button>
              <input
                value={recordTitle}
                onChange={(e) => setRecordTitle(e.target.value)}
                placeholder="pad track title"
              />
              <button className="secondary" onClick={startNewPadTrack} disabled={!recordedTrack}>
                new pad track
              </button>
              <span className={`autosave-status autosave-status--${recordAutosaveState}`}>
                {recordAutosaveState === "saving" && "saving…"}
                {recordAutosaveState === "saved" && "✓ saved"}
                {recordAutosaveState === "error" && "autosave failed"}
                {recordAutosaveState === "idle" && "will save automatically"}
              </span>
            </div>
            {recordShareUrl && (
              <p className="share-url">
                share this room's pad track — stays live-updated as you record more takes:
                <input readOnly value={recordShareUrl} onFocus={(e) => e.currentTarget.select()} />
              </p>
            )}
          </>
        )}
      </section>

      <section className="rack-save">
        <h2>this room's pad rack</h2>
        <p className="hint">
          save the current rack — every filled pad in order, empty ones as rests — as a Strudel track,
          playable from a URL with this room's name, from this app or the main editor. Nothing gets saved just
          from filling/clearing pads; press "save rack" whenever you actually want this layout kept. This room
          keeps just one rack track — every save after the first updates that same one — until "new rack
          track" starts a fresh one.
        </p>
        <div className="save-set">
          <input value={rackTitle} onChange={(e) => setRackTitle(e.target.value)} placeholder="rack title" />
          <button onClick={saveRack} disabled={!hasRackContent || autosaveState === "saving"}>
            save rack
          </button>
          <button className="secondary" onClick={startNewRackTrack} disabled={!savedTrack}>
            new rack track
          </button>
          <span className={`autosave-status autosave-status--${autosaveState}`}>
            {autosaveState === "saving" && "saving…"}
            {autosaveState === "saved" && "✓ saved"}
            {autosaveState === "error" && "save failed"}
          </span>
        </div>
        {shareUrl && (
          <p className="share-url">
            share this room's rack track — stays live-updated as you save more changes:
            <input readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
          </p>
        )}
      </section>
    </div>
  );
}
