import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  AutosaveDoc,
  ChannelEvent,
  CustomSample,
  Presence,
  StrudelJson,
  Track,
} from "@strudel-point/shared";
import {
  groupSampleBanks,
  bankSampleUrls,
  requestStemSeparation,
  SampleEditor,
  type SampleEditorHandle,
  type StemResult,
} from "@strudel-point/library";
import { Editor, type EditorHandle } from "./components/Editor";
import type { SliderWidgetConfig } from "@strudel/codemirror/slider.mjs";
import { ChannelBar } from "./components/ChannelBar";
import { RoomSwitcher } from "./components/RoomSwitcher";
import { SaveDialog } from "./components/SaveDialog";
import { SoundBank, type SoundBankEntry } from "./components/SoundBank";
import { CustomSamples, playableName } from "./components/CustomSamples";
import { LiveWaveform } from "./components/LiveWaveform";
import { RenameIcon, SaveIcon, DeleteIcon } from "./components/Icon";
import { useChannelSocket } from "./ws";
import { getStrudel } from "./strudel";
import type { StrudelPattern } from "@strudel/web";
import { transpiler } from "@strudel/transpiler";

const DEFAULT_CODE = `// welcome to strudel-point — everyone here shares this buffer.
// ctrl/cmd+enter to evaluate, ctrl/cmd+. to hush.
s("bd hh sd hh")`;

const AUTOSAVE_DEBOUNCE_MS = 3000;
type SidebarTab = "tracks" | "sounds" | "bank" | "instruments";

const SIDEBAR_WIDTH_KEY = "strudel-point:sidebarWidth";
const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 560;

function initialSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0
    ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, stored))
    : DEFAULT_SIDEBAR_WIDTH;
}

function channelIdFromLocation(): string {
  const hash = location.hash.replace(/^#/, "");
  return hash || "lobby";
}

function ensureUsername(): string {
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

/**
 * Registers every custom sample for playback, grouping any that share a `bankName` into one
 * Strudel bank (`samples({ [bankName]: [url0, url1, ...] })`, playable as s("bankName:0")
 * etc.) instead of registering each slice under its own standalone name — the same
 * grouping every strudel-point app now shares (see @strudel-point/library's banks.ts).
 * Recomputed from the full current list each time, so it's idempotent and self-corrects
 * regardless of the order bank slices arrive in (relevant for peers receiving
 * `sample:added` one slice at a time).
 */
async function registerAllSamples(samples: CustomSample[]) {
  const strudel = await getStrudel();
  const { banks, singles } = groupSampleBanks(samples);
  await Promise.all([
    ...singles.map((s) => strudel.samples({ [s.name]: s.url })),
    ...banks.map((bank) => strudel.samples({ [bank.bankName]: bankSampleUrls(bank) })),
  ]);
}

/**
 * Clears a stale bank/sample name out of Strudel's soundMap after a rename. `setKey`
 * with `undefined` is nanostores' own delete — see strudel-web.d.ts. Belt-and-suspenders
 * on casing: superdough's own sample lookup lowercases at read time (getSound()), but
 * doesn't lowercase at registration, so which casing actually ends up as the live key can
 * vary — clearing both means the old name can't linger playable under either.
 */
async function forgetSound(oldName: string) {
  const strudel = await getStrudel();
  strudel.soundMap.setKey(oldName, undefined);
  strudel.soundMap.setKey(oldName.toLowerCase(), undefined);
}

/** Reads the live sound registry — accurate to whatever packs actually loaded, not a guess. */
async function listRegisteredSounds(): Promise<SoundBankEntry[]> {
  const strudel = await getStrudel();
  const registry = strudel.soundMap.get();
  return Object.entries(registry)
    .map(([name, entry]) => ({ name, type: entry.data?.tag ?? entry.data?.type ?? "sound" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Sends the browser to a different room by rewriting the hash — same-tab, no reload. */
function navigateToChannel(channelId: string) {
  location.hash = channelId;
}

export default function App() {
  const [channelId, setChannelId] = useState(channelIdFromLocation);
  const [username] = useState(ensureUsername);
  const [roomSwitcherOpen, setRoomSwitcherOpen] = useState(false);
  const [peerIds, setPeerIds] = useState<Set<string>>(new Set());
  const [tracks, setTracks] = useState<Track[]>([]);
  const [customSamples, setCustomSamples] = useState<CustomSample[]>([]);
  const [soundBank, setSoundBank] = useState<SoundBankEntry[]>([]);
  // soundMap mixes sample-based sounds and built-in oscillator synths (registerSynthSounds
  // tags each as `{ type: "synth" }`) into one registry — split it here rather than at the
  // source so the sound bank and instruments tabs stay in sync with a single fetch.
  const sampleBank = useMemo(() => soundBank.filter((s) => s.type !== "synth"), [soundBank]);
  const instrumentBank = useMemo(() => soundBank.filter((s) => s.type === "synth"), [soundBank]);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("tracks");
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [error, setError] = useState<{ message: string; kind: "error" | "warning" } | null>(
    null,
  );
  const [autosaveState, setAutosaveState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const editorRef = useRef<EditorHandle>(null);
  const sampleEditorRef = useRef<SampleEditorHandle>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  const reportError = useCallback((message: string) => setError({ message, kind: "error" }), []);
  // Strudel code that fails to evaluate is a problem with the user's input, not the
  // platform — surface it as a warning rather than the same red "something's broken" banner.
  const reportWarning = useCallback(
    (message: string) => setError({ message, kind: "warning" }),
    [],
  );

  // The "note highlight" — every mini-notation token currently sounding lights up
  // directly in the code. `.draw()` is a self-driving requestAnimationFrame loop (see
  // strudel-web.d.ts); calling it again on a new pattern (same `id`) cancels the
  // previous loop automatically, which is exactly what we want on every re-evaluate.
  const attachHighlighting = useCallback((pattern: StrudelPattern | undefined) => {
    if (!pattern) return;
    pattern.draw(
      (haps, time) => {
        const active = haps
          .filter((h) => h.isActive(time))
          .flatMap((h) => h.context.locations ?? []);
        editorRef.current?.setHighlightRanges(active);
      },
      { lookbehind: 0, lookahead: 0.1, id: 1 },
    );
  }, []);

  // slider(...) widgets: extracted from the source text alone (an AST walk, independent
  // of whether the pattern evaluates cleanly), so this runs on every evaluate attempt —
  // yours or a peer's — regardless of whether attachHighlighting's pattern came back.
  // @strudel/web transpiles slider(...) the same way internally for actual playback; this
  // second, separate transpile call only exists to get widget positions for the editor.
  const syncSliderWidgets = useCallback((code: string) => {
    try {
      const { widgets } = transpiler(code);
      const sliders = widgets.filter(
        (w): w is SliderWidgetConfig =>
          w.type === "slider" && w.from !== undefined && w.to !== undefined,
      );
      editorRef.current?.updateSliders(sliders);
    } catch {
      // invalid code — handleEvaluate's own transpile/eval already surfaces this error;
      // no need to duplicate it here, just leave whatever sliders were last shown as-is.
    }
  }, []);

  // Switching rooms rewrites location.hash (navigateToChannel / the RoomSwitcher) rather
  // than doing a full page reload — pick that back up here so channelId (and everything
  // derived from it: the socket, tracks, samples, autosave) follows along live.
  useEffect(() => {
    const onHashChange = () => setChannelId(channelIdFromLocation());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Last-resort net: anything that throws/rejects outside a path we explicitly wrapped
  // (e.g. deep inside @strudel/web's audio scheduling) still surfaces here instead of
  // vanishing into the browser console.
  useEffect(() => {
    const onError = (e: ErrorEvent) => reportError(e.message);
    const onRejection = (e: PromiseRejectionEvent) =>
      reportError(e.reason instanceof Error ? e.reason.message : String(e.reason));
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [reportError]);

  const handleEvent = useCallback(
    (event: ChannelEvent) => {
      switch (event.type) {
        case "doc:update":
          editorRef.current?.applyRemoteContent(event.content);
          break;
        case "eval":
          editorRef.current?.flash();
          syncSliderWidgets(event.code);
          getStrudel()
            .then((s) => s.evaluate(event.code))
            .then(attachHighlighting)
            .catch((err) => reportWarning(`failed to play ${event.userId}'s evaluate: ${err}`));
          break;
        case "user:joined":
          setPeerIds((prev) => new Set(prev).add(event.userId));
          break;
        case "user:left":
          setPeerIds((prev) => {
            const next = new Set(prev);
            next.delete(event.userId);
            return next;
          });
          break;
        case "sample:added":
          setCustomSamples((prev) => {
            const next = prev.some((s) => s.id === event.sample.id)
              ? prev
              : [event.sample, ...prev];
            registerAllSamples(next)
              .then(() => listRegisteredSounds().then(setSoundBank))
              .catch((err) => reportError(`failed to load "${event.sample.name}": ${err}`));
            return next;
          });
          break;
        case "sample:removed":
          setCustomSamples((prev) => prev.filter((s) => s.id !== event.sampleId));
          break;
        case "bank:renamed":
          setCustomSamples((prev) => {
            const byId = new Map(event.samples.map((s) => [s.id, s]));
            const next = prev.map((s) => byId.get(s.id) ?? s);
            forgetSound(event.oldName)
              .then(() => registerAllSamples(next))
              .then(() => listRegisteredSounds().then(setSoundBank))
              .catch((err) => reportError(`failed to apply bank rename: ${err}`));
            return next;
          });
          break;
        case "hush":
          getStrudel()
            .then((s) => s.hush())
            .catch((err) => reportError(`failed to apply ${event.userId}'s hush: ${err}`));
          break;
      }
    },
    [reportError, reportWarning, attachHighlighting, syncSliderWidgets],
  );

  // Seeds the peer list from the gateway's roster (Valkey-backed, so it spans every
  // gateway instance) the moment our join is acked. The user:joined/user:left stream alone
  // only ever describes changes *after* we connected, so without this, walking into a busy
  // room reads "0 peers" until someone else happens to join or leave. Runs on reconnects
  // too — each join gets a fresh userId, and a reconnect is exactly when the event-only
  // view is most stale.
  const handleJoined = useCallback(
    (selfUserId: string) => {
      fetch(`/api/channels/${channelId}/presence`)
        .then(jsonOrThrow)
        .then((presence: Presence) => {
          setPeerIds(
            new Set(presence.peers.map((p) => p.userId).filter((id) => id !== selfUserId)),
          );
        })
        .catch((err) => reportError(`couldn't load the room roster: ${err.message}`));
    },
    [channelId, reportError],
  );

  const { connected, send } = useChannelSocket({
    channelId,
    username,
    onEvent: handleEvent,
    onError: reportError,
    onJoined: handleJoined,
  });

  // Load saved tracks, this channel's custom samples, and the last autosaved buffer.
  // Also resets everything that's meaningfully per-room: switching rooms (RoomSwitcher /
  // a hash edit) no longer reloads the page, so state left over from the old room — its
  // peer list, its buffer — would otherwise bleed into the new one.
  useEffect(() => {
    setPeerIds(new Set());
    editorRef.current?.applyRemoteContent(DEFAULT_CODE);

    fetch(`/api/channels/${channelId}/tracks`)
      .then(jsonOrThrow)
      .then(setTracks)
      .catch((err) => reportError(`couldn't load saved tracks: ${err.message}`));

    fetch(`/api/channels/${channelId}/autosave`)
      .then(jsonOrThrow)
      .then((doc: AutosaveDoc | null) => {
        if (doc?.code) editorRef.current?.applyRemoteContent(doc.code);
      })
      .catch((err) => reportError(`couldn't restore autosave: ${err.message}`));

    fetch(`/api/channels/${channelId}/samples`)
      .then(jsonOrThrow)
      .then(async (samples: CustomSample[]) => {
        setCustomSamples(samples);
        if (samples.length === 0) return;
        // Register every previously-uploaded sample (and bank) for this channel so it's
        // ready to play the moment someone evaluates code that references it.
        await registerAllSamples(samples);
        setSoundBank(await listRegisteredSounds());
      })
      .catch((err) => reportError(`couldn't load channel sounds: ${err.message}`));
  }, [channelId, reportError]);

  // Populate the sound bank once the default pack finishes loading, even if the channel
  // has no custom samples (the branch above would otherwise be the only place this runs).
  useEffect(() => {
    listRegisteredSounds()
      .then(setSoundBank)
      .catch((err) => reportError(`couldn't read sound registry: ${err.message}`));
  }, [reportError]);

  const autosaveNow = useCallback(
    async (code: string) => {
      if (!code.trim()) return;
      setAutosaveState("saving");
      try {
        const strudelJson: StrudelJson = { code, version: 1 };
        await fetch(`/api/channels/${channelId}/autosave`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, strudelJson }),
        }).then(jsonOrThrow);
        setAutosaveState("saved");
      } catch (err) {
        setAutosaveState("error");
        reportError(`autosave failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [channelId, reportError],
  );

  useEffect(() => {
    // Any pending debounce belongs to the channel being left — drop it rather than
    // autosaving stale content into the channel we're navigating to.
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [channelId]);

  const handleLocalChange = useCallback(
    (content: string) => {
      send({ type: "doc:update", paneId: "main", content });

      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = setTimeout(() => autosaveNow(content), AUTOSAVE_DEBOUNCE_MS);
    },
    [send, autosaveNow],
  );

  const handleEvaluate = useCallback(async () => {
    const code = editorRef.current?.getCode() ?? "";
    editorRef.current?.flash();
    syncSliderWidgets(code);
    try {
      const strudel = await getStrudel();
      const pattern = await strudel.evaluate(code);
      attachHighlighting(pattern);
    } catch (err) {
      reportWarning(`evaluate failed: ${err instanceof Error ? err.message : err}`);
    }
    send({ type: "eval", paneId: "main", code });

    // Evaluating is the natural "this is worth keeping" checkpoint — autosave immediately
    // rather than waiting out the debounce, and skip it if one's already pending.
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveNow(code);
  }, [send, autosaveNow, reportWarning, attachHighlighting, syncSliderWidgets]);

  const handleHush = useCallback(async () => {
    try {
      const strudel = await getStrudel();
      strudel.hush();
    } catch (err) {
      reportError(`hush failed: ${err instanceof Error ? err.message : err}`);
    }
    send({ type: "hush", paneId: "main" });
  }, [send, reportError]);

  const handleSave = useCallback(
    async (title: string) => {
      const code = editorRef.current?.getCode() ?? "";
      const strudelJson: StrudelJson = { code, version: 1 };
      try {
        const track = await fetch("/api/tracks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channelId, title, author: username, code, strudelJson }),
        }).then(jsonOrThrow);
        setTracks((prev) => [track, ...prev]);
        setSaveOpen(false);
      } catch (err) {
        reportError(`save failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [channelId, username, reportError],
  );

  const handleUpdateTrack = useCallback(
    async (track: Track, e: MouseEvent) => {
      e.stopPropagation();
      const code = editorRef.current?.getCode() ?? "";
      const strudelJson: StrudelJson = { code, version: 1 };
      try {
        const updated: Track = await fetch(`/api/tracks/${track.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, strudelJson }),
        }).then(jsonOrThrow);
        setTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      } catch (err) {
        reportError(`couldn't update "${track.title}": ${err instanceof Error ? err.message : err}`);
      }
    },
    [reportError],
  );

  const handleRenameTrack = useCallback(
    async (track: Track, e: MouseEvent) => {
      e.stopPropagation();
      // A blocking prompt is one line instead of a whole dialog component — same
      // trade-off knobs.ts makes for its numeric input.
      const title = window.prompt("rename track:", track.title)?.trim();
      if (!title || title === track.title) return;
      try {
        const updated: Track = await fetch(`/api/tracks/${track.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title }),
        }).then(jsonOrThrow);
        setTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      } catch (err) {
        reportError(`couldn't rename "${track.title}": ${err instanceof Error ? err.message : err}`);
      }
    },
    [reportError],
  );

  const handleDeleteTrack = useCallback(
    async (track: Track, e: MouseEvent) => {
      e.stopPropagation();
      try {
        await fetch(`/api/tracks/${track.id}`, { method: "DELETE" }).then((res) => {
          if (!res.ok && res.status !== 204) return jsonOrThrow(res);
        });
        setTracks((prev) => prev.filter((t) => t.id !== track.id));
      } catch (err) {
        reportError(`couldn't delete "${track.title}": ${err instanceof Error ? err.message : err}`);
      }
    },
    [reportError],
  );

  const loadTrack = useCallback(
    (track: Track) => {
      editorRef.current?.applyRemoteContent(track.code);
      handleLocalChange(track.code);
    },
    [handleLocalChange],
  );

  // Shared by plain "my sounds" uploads and the sample editor's per-slice bank uploads —
  // bankName/bankIndex are omitted for the former.
  const uploadSample = useCallback(
    async (file: File, name: string, bankName?: string, bankIndex?: number) => {
      const form = new FormData();
      form.append("file", file);
      form.append("name", name);
      if (bankName !== undefined) {
        form.append("bankName", bankName);
        form.append("bankIndex", String(bankIndex));
      }
      const sample: CustomSample = await fetch(`/api/channels/${channelId}/samples`, {
        method: "POST",
        body: form,
      }).then(jsonOrThrow);

      let next: CustomSample[] = [];
      setCustomSamples((prev) => {
        next = prev.some((s) => s.id === sample.id) ? prev : [sample, ...prev];
        return next;
      });
      await registerAllSamples(next);
      setSoundBank(await listRegisteredSounds());

      send({ type: "sample:added", sample });
      return sample;
    },
    [channelId, send],
  );

  const handleUploadSample = useCallback(
    async (file: File, name: string) => {
      try {
        await uploadSample(file, name);
      } catch (err) {
        reportError(`upload failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [uploadSample, reportError],
  );

  // The sample editor only calls this once cuts are confirmed — nothing is uploaded
  // while the user is still previewing/dragging cut points client-side.
  const handleUploadSlice = useCallback(
    (file: File, name: string, bankName: string, bankIndex: number) =>
      uploadSample(file, name, bankName, bankIndex),
    [uploadSample],
  );

  // "chop" / "merge & chop" in CustomSamples: hand the picked sound(s) off to the sample
  // editor to be re-decoded, (merged if more than one), and re-analyzed for cuts.
  const handleEditSamples = useCallback((samples: CustomSample[]) => {
    sampleEditorRef.current?.loadFromSamples(
      samples.map((s) => ({ url: s.url, label: playableName(s) })),
    );
  }, []);

  // Feeds the sample editor's "separate into stems" button (see
  // @strudel-point/library's SampleEditor.tsx). The four returned stems are already
  // stored server-side by the time this resolves — this just registers them into this
  // app's own Strudel module/sound bank (same as any other new upload) and announces
  // them so peers pick them up too.
  const handleSeparateStems = useCallback(
    async (file: File, baseName: string): Promise<StemResult[]> => {
      const stems = await requestStemSeparation(channelId, file, baseName);
      let next: CustomSample[] = [];
      setCustomSamples((prev) => {
        next = [...stems, ...prev];
        return next;
      });
      await registerAllSamples(next);
      setSoundBank(await listRegisteredSounds());
      for (const sample of stems) send({ type: "sample:added", sample });
      return stems.map((s) => ({ name: playableName(s), url: s.url }));
    },
    [channelId, send],
  );

  const handleDeleteSample = useCallback(
    async (sample: CustomSample) => {
      try {
        await fetch(`/api/samples/${sample.id}`, { method: "DELETE" }).then((res) => {
          if (!res.ok && res.status !== 204) return jsonOrThrow(res);
        });
        setCustomSamples((prev) => prev.filter((s) => s.id !== sample.id));
        send({ type: "sample:removed", sampleId: sample.id, name: sample.name });
      } catch (err) {
        reportError(`couldn't delete "${sample.name}": ${err instanceof Error ? err.message : err}`);
      }
    },
    [send, reportError],
  );

  const renameBank = useCallback(
    async (oldName: string, newName: string) => {
      try {
        const updated: CustomSample[] = await fetch(
          `/api/channels/${channelId}/banks/${encodeURIComponent(oldName)}/rename`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ newName }),
          },
        ).then(jsonOrThrow);

        let next: CustomSample[] = [];
        setCustomSamples((prev) => {
          const byId = new Map(updated.map((s) => [s.id, s]));
          next = prev.map((s) => byId.get(s.id) ?? s);
          return next;
        });
        await forgetSound(oldName);
        await registerAllSamples(next);
        setSoundBank(await listRegisteredSounds());

        send({ type: "bank:renamed", oldName, newName, samples: updated });
      } catch (err) {
        reportError(`couldn't rename "${oldName}": ${err instanceof Error ? err.message : err}`);
      }
    },
    [channelId, send, reportError],
  );

  const insertSoundName = useCallback((name: string) => {
    editorRef.current?.insertText(name);
  }, []);

  // Fires a one-shot preview straight through superdough rather than strudel.evaluate() —
  // evaluate() replaces the repl's live pattern, which would cut off whatever's currently
  // looping in the editor just to audition a sound from the bank.
  const previewSound = useCallback(
    async (name: string) => {
      try {
        const strudel = await getStrudel();
        const ac = strudel.getAudioContext();
        // `name` may be plain ("foo") or mini-notation-style bank addressing ("foo:0") — the
        // ":n" suffix is only ever split into separate s/n fields by Strudel's mini-notation
        // parser, never by superdough itself, so it has to be split here or a bank slice's
        // registry lookup silently misses (the whole "foo:0" string was never a registered key).
        const match = /^(.*):(\d+)$/.exec(name);
        const hap = match ? { s: match[1], n: Number(match[2]) } : { s: name };
        await strudel.superdough(hap, ac.currentTime + 0.01, 0.2);
      } catch (err) {
        reportError(`couldn't preview "${name}": ${err instanceof Error ? err.message : err}`);
      }
    },
    [reportError],
  );

  // Sidebar resize: dragging the handle sets width from the container's right edge, not a
  // running delta — avoids drift if a pointermove event gets dropped mid-drag.
  const handleResizePointerMove = useCallback((e: PointerEvent) => {
    const rect = mainRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = rect.right - e.clientX;
    setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, next)));
  }, []);

  const stopResize = useCallback(() => {
    setResizing(false);
    window.removeEventListener("pointermove", handleResizePointerMove);
    window.removeEventListener("pointerup", stopResize);
    setSidebarWidth((w) => {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
      return w;
    });
  }, [handleResizePointerMove]);

  const startResize = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      setResizing(true);
      window.addEventListener("pointermove", handleResizePointerMove);
      window.addEventListener("pointerup", stopResize);
    },
    [handleResizePointerMove, stopResize],
  );

  return (
    <>
      {error && (
        <div className={`error-banner${error.kind === "warning" ? " error-banner--warning" : ""}`}>
          <span>{error.message}</span>
          <button className="secondary" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}
      <ChannelBar
        channelId={channelId}
        username={username}
        connected={connected}
        peerCount={peerIds.size}
        autosaveState={autosaveState}
        onEvaluate={handleEvaluate}
        onHush={handleHush}
        onSave={() => setSaveOpen(true)}
        onOpenRooms={() => setRoomSwitcherOpen(true)}
      />
      <div
        className="main"
        ref={mainRef}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <div className="editor-pane">
          <Editor
            ref={editorRef}
            initialContent={DEFAULT_CODE}
            onLocalChange={handleLocalChange}
            onEvaluate={handleEvaluate}
            onHush={handleHush}
          />
        </div>
        <div
          className={`sidebar-resizer ${resizing ? "resizing" : ""}`}
          onPointerDown={startResize}
          onDoubleClick={() => {
            setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
            localStorage.setItem(SIDEBAR_WIDTH_KEY, String(DEFAULT_SIDEBAR_WIDTH));
          }}
          title="drag to resize (double-click to reset)"
        />
        <div className="sidebar">
          <div className="sidebar-tabs">
            <button
              className={sidebarTab === "tracks" ? "active" : ""}
              onClick={() => setSidebarTab("tracks")}
            >
              tracks
            </button>
            <button
              className={sidebarTab === "sounds" ? "active" : ""}
              onClick={() => setSidebarTab("sounds")}
            >
              my sounds
            </button>
            <button
              className={sidebarTab === "bank" ? "active" : ""}
              onClick={() => setSidebarTab("bank")}
            >
              sound bank
            </button>
            <button
              className={sidebarTab === "instruments" ? "active" : ""}
              onClick={() => setSidebarTab("instruments")}
            >
              instruments
            </button>
          </div>

          {sidebarTab === "tracks" && (
            <>
              <h2>saved tracks</h2>
              {tracks.length === 0 && (
                <p style={{ color: "var(--muted)", fontSize: 13 }}>none yet</p>
              )}
              {tracks.map((t) => (
                <div key={t.id} className="track" onClick={() => loadTrack(t)}>
                  <div className="title">{t.title}</div>
                  <div className="meta">
                    {t.author ?? "anonymous"} · {new Date(t.createdAt).toLocaleString()}
                  </div>
                  <div className="track-actions">
                    <button
                      className="icon-button"
                      onClick={(e) => handleRenameTrack(t, e)}
                      title="rename track"
                      aria-label="rename track"
                    >
                      <RenameIcon />
                    </button>
                    <button
                      className="icon-button"
                      onClick={(e) => handleUpdateTrack(t, e)}
                      title="overwrite this track with the current editor buffer"
                      aria-label="update track"
                    >
                      <SaveIcon />
                    </button>
                    <button
                      className="icon-button"
                      onClick={(e) => handleDeleteTrack(t, e)}
                      title="delete track"
                      aria-label="delete track"
                    >
                      <DeleteIcon />
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {sidebarTab === "sounds" && (
            <>
              <h2>sample editor</h2>
              <SampleEditor
                ref={sampleEditorRef}
                onUploadSlice={handleUploadSlice}
                onRenameBank={renameBank}
                onSeparateStems={handleSeparateStems}
              />
              <h2 style={{ marginTop: 20 }}>my sounds</h2>
              <CustomSamples
                samples={customSamples}
                onUpload={handleUploadSample}
                onDelete={handleDeleteSample}
                onPreview={previewSound}
                onPick={insertSoundName}
                onRenameBank={renameBank}
                onEditSamples={handleEditSamples}
              />
            </>
          )}

          {sidebarTab === "bank" && (
            <>
              <h2>sound bank</h2>
              <SoundBank sounds={sampleBank} onPreview={previewSound} onAdd={insertSoundName} />
            </>
          )}

          {sidebarTab === "instruments" && (
            <>
              <h2>instruments</h2>
              <SoundBank sounds={instrumentBank} onPreview={previewSound} onAdd={insertSoundName} />
            </>
          )}
        </div>
      </div>
      <LiveWaveform />
      <SaveDialog open={saveOpen} onClose={() => setSaveOpen(false)} onSave={handleSave} />
      <RoomSwitcher
        open={roomSwitcherOpen}
        currentChannelId={channelId}
        onClose={() => setRoomSwitcherOpen(false)}
        onSwitch={(id) => {
          setRoomSwitcherOpen(false);
          navigateToChannel(id);
        }}
      />
    </>
  );
}
