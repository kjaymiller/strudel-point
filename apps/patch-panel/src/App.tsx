import {
  CodeSessionView,
  getTrackDragData,
  LibraryDrawer,
  playableName,
  type RegisteredSound,
  requestStemSeparation,
  type StemResult,
  type TrackDragPayload,
  useChannelLibrary,
} from "@strudel-point/library";
import type { ChannelEvent, CreateTrackInput, StrudelJson, Track } from "@strudel-point/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChannelModuleCard } from "./components/ChannelModuleCard";
import { DelayModuleCard } from "./components/DelayModuleCard";
import { EnvelopeModuleCard } from "./components/EnvelopeModuleCard";
import { EosModuleCard } from "./components/EosModuleCard";
import { FilterEnvModuleCard } from "./components/FilterEnvModuleCard";
import { FilterLfoModuleCard } from "./components/FilterLfoModuleCard";
import { FmOpModuleCard } from "./components/FmOpModuleCard";
import { ModPedalModuleCard } from "./components/ModPedalModuleCard";
import { OutputModuleCard } from "./components/OutputModuleCard";
import { PitchEnvModuleCard } from "./components/PitchEnvModuleCard";
import { PresetBar } from "./components/PresetBar";
import { ReverbModuleCard } from "./components/ReverbModuleCard";
import { SamplerModuleCard } from "./components/SamplerModuleCard";
import { Scope } from "./components/Scope";
import { SequencerModuleCard } from "./components/SequencerModuleCard";
import { SiggenModuleCard } from "./components/SiggenModuleCard";
import { VcfModuleCard } from "./components/VcfModuleCard";
import { VcoModuleCard } from "./components/VcoModuleCard";
import { VibratoModuleCard } from "./components/VibratoModuleCard";
import { type CodeRange, parsePatchCode } from "./importPatch";
import {
  ADDABLE_MODULE_KINDS,
  createModule,
  MODULE_LABELS,
  type ModuleInstance,
  type ModuleKind,
  moduleIdOfAddress,
} from "./modules";
import { PatchBayProvider } from "./PatchBay";
import { buildMixCode, effectiveSequenceFor, sequenceIsGatedFor } from "./patch";
import { defaultRack, deletePreset, factoryPresets, loadPresets, type Preset, savePreset } from "./presets";
import { forgetSound, getStrudel, listRegisteredSounds, registerAllSamples } from "./strudel";
import { useChannelSocket } from "./ws";

function channelIdFromLocation(): string {
  const hash = location.hash.replace(/^#/, "");
  return hash || "lobby";
}

function navigateToChannel(channelId: string) {
  location.hash = channelId;
}

function ensureUsername(): string {
  // Same localStorage key web/dj/pads all use, so opening any strudel-point app in one
  // browser shows up as one identity in the room rather than a stranger per app.
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

// Appended only to the copy of `code` we hand to strudel.evaluate() for local playback —
// never to what gets broadcast (see playInRoom below) or saved as a Track, since another
// client evaluating this room's eval event has no reason to assume a #test-canvas exists
// on their page (see components/Scope.tsx).
const SCOPE_SUFFIX = '\n  .color("#f2a33d")\n  .scope({ thickness: 2 })';
// How long to let knob-dragging settle before re-evaluating the now-playing pattern —
// long enough that a drag's flurry of onChange calls collapses into one re-eval, short
// enough that turning a knob still feels live.
const LIVE_UPDATE_DEBOUNCE_MS = 120;

export default function App() {
  const [channelId, setChannelId] = useState(channelIdFromLocation);
  const [username] = useState(ensureUsername);
  const [roomInput, setRoomInput] = useState(channelId);
  const [error, setError] = useState<string | null>(null);
  const reportError = useCallback((message: string) => setError(message), []);

  useEffect(() => {
    function onHashChange() {
      const next = channelIdFromLocation();
      setChannelId(next);
      setRoomInput(next);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // The room's shared library — saved Tracks + custom sample uploads (see
  // @strudel-point/library) — same source both apps/web and apps/pads already draw
  // their own bespoke versions of this from, just centralized so every app renders the
  // identical tray. Registering fetched samples into *this* app's own Strudel module
  // (see strudel.ts's registerAllSamples) is this app's own job — the hook itself never
  // touches any app's sound registry.
  const [registeredSounds, setRegisteredSounds] = useState<RegisteredSound[]>([]);
  const refreshRegisteredSounds = useCallback(() => {
    listRegisteredSounds()
      .then(setRegisteredSounds)
      .catch((err) =>
        reportError(`couldn't read sound registry: ${err instanceof Error ? err.message : err}`),
      );
  }, [reportError]);
  const library = useChannelLibrary(channelId, (samples) => {
    registerAllSamples(samples)
      .then(refreshRegisteredSounds)
      .catch((err) =>
        reportError(`couldn't load channel sounds: ${err instanceof Error ? err.message : err}`),
      );
  });
  // Built-in packs (dirt-samples/tidal-drum-machines) finish loading independently of
  // whether this channel has any custom samples at all — same "populate once the default
  // pack is ready" effect apps/web runs, so the tray isn't empty on a fresh room.
  useEffect(refreshRegisteredSounds, [refreshRegisteredSounds]);

  const handleChannelEvent = useCallback(
    (event: ChannelEvent) => {
      switch (event.type) {
        case "sample:added":
        case "sample:removed":
          // Cheapest correct response to a sample changing mid-session — same "just
          // refetch" approach apps/pads' own refreshBanks already uses; these are
          // infrequent, human-triggered events, not worth patching in place.
          library.refresh().catch(() => {});
          break;
        case "bank:renamed":
          // The old name has to stop resolving locally before the new one's registered
          // under it, same order apps/web's own handler uses.
          forgetSound(event.oldName)
            .then(() => library.refresh())
            .catch(() => {});
          break;
      }
    },
    [library],
  );

  const { connected, send } = useChannelSocket({
    channelId,
    username,
    onEvent: handleChannelEvent,
    onError: reportError,
  });

  // A quick one-shot audition — same "click to preview, doesn't touch the loop/rack"
  // behavior apps/web's SoundBank gives its own sound chips.
  const previewSound = useCallback(
    (name: string) => {
      // `name` may carry Strudel's "bank:index" mini-notation suffix (a registered
      // sample bank slice) — superdough looks up `s` as a literal registry key and
      // never splits that suffix itself, so it has to be split here or the lookup
      // misses even though the bank is loaded.
      const match = /^(.*):(\d+)$/.exec(name);
      const hap = match ? { s: match[1], n: Number(match[2]) } : { s: name };
      getStrudel()
        .then((strudel) => strudel.superdough(hap, strudel.getAudioContext().currentTime + 0.05, 0.5))
        .catch((err) =>
          reportError(`couldn't preview "${name}": ${err instanceof Error ? err.message : err}`),
        );
    },
    [reportError],
  );

  // This app's first custom-sample *creation* path — previously only apps/web's
  // BeatAnalyzer could chop/upload a bank at all; this is the same edit tab as every
  // other app now gets (see @strudel-point/library's LibraryTray "edit" tab), and it
  // deliberately doesn't hand-maintain local sample/sound-registry state the way
  // apps/web's own uploadSample does — this app's `sample:added`/`bank:renamed` channel
  // event handler above already reacts to its own echoed event by calling
  // `library.refresh()` (which re-registers with strudel.ts and re-broadcasts), so
  // sending the event after a successful upload is enough for this app's own registry to
  // pick it up on the same round trip every *other* client's does.
  const handleUploadSlice = useCallback(
    async (file: File, name: string, bankName: string, bankIndex: number) => {
      const form = new FormData();
      form.append("file", file);
      form.append("name", name);
      form.append("bankName", bankName);
      form.append("bankIndex", String(bankIndex));
      const sample = await fetch(`/api/channels/${channelId}/samples`, { method: "POST", body: form }).then(
        jsonOrThrow,
      );
      send({ type: "sample:added", sample });
      return sample;
    },
    [channelId, send],
  );

  const handleRenameBank = useCallback(
    (oldName: string, newName: string) => {
      fetch(`/api/channels/${channelId}/banks/${encodeURIComponent(oldName)}/rename`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newName }),
      })
        .then(jsonOrThrow)
        .then((samples) => send({ type: "bank:renamed", oldName, newName, samples }))
        .catch((err) =>
          reportError(`couldn't rename "${oldName}": ${err instanceof Error ? err.message : err}`),
        );
    },
    [channelId, send, reportError],
  );

  // Feeds the sample editor's "separate into stems" button (see SampleEditor.tsx) — the
  // four returned stems are already stored server-side by the time this resolves, so
  // this only needs to announce them and hand back their playable names/urls for the
  // editor's own success message.
  const handleSeparateStems = useCallback(
    async (file: File, baseName: string): Promise<StemResult[]> => {
      const stems = await requestStemSeparation(channelId, file, baseName);
      for (const sample of stems) send({ type: "sample:added", sample });
      return stems.map((s) => ({ name: playableName(s), url: s.url }));
    },
    [channelId, send],
  );

  // The rack: a free-patch graph of module instances + the cables between their jacks
  // (see modules.ts/cables.ts) — no fixed VCO->VCF->VCA order, you build the chain by
  // patching. Seeded with the simplest possible complete voice so a fresh browser isn't
  // a silent blank slate.
  const [modules, setModules] = useState<ModuleInstance[]>(() => defaultRack().modules);
  const [cables, setCables] = useState<string[]>(() => defaultRack().cables);
  const moduleSeq = useRef(1);

  const addModule = useCallback((kind: ModuleKind) => {
    const id = `mod-${moduleSeq.current++}`;
    setModules((mods) => {
      const countOfKind = mods.filter((m) => m.kind === kind).length;
      const name = `${MODULE_LABELS[kind]} ${countOfKind + 1}`;
      const outputIdx = mods.findIndex((m) => m.kind === "output");
      const next = [...mods];
      next.splice(outputIdx === -1 ? next.length : outputIdx, 0, createModule(kind, id, name));
      return next;
    });
  }, []);

  const removeModule = useCallback((id: string) => {
    setModules((mods) => mods.filter((m) => m.id !== id));
    setCables((cbs) =>
      cbs.filter((c) => !c.split("->").some((address) => moduleIdOfAddress(address) === id)),
    );
  }, []);

  const renameModule = useCallback((id: string, name: string) => {
    setModules((mods) => mods.map((m) => (m.id === id ? { ...m, name } : m)));
  }, []);

  // Reordering the rack only ever touches this array's *display* order — cables are
  // stored by "moduleId:jackId" address (see modules.ts's jackAddress), never by
  // position, so dragging a module elsewhere in the grid can't disconnect anything; every
  // cable's two endpoints still resolve to the same jacks regardless of where their owning
  // module cards now sit. Dropping onto itself, or a stale/removed id, is a no-op.
  const moveModule = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    setModules((mods) => {
      const from = mods.findIndex((m) => m.id === draggedId);
      const to = mods.findIndex((m) => m.id === targetId);
      if (from === -1 || to === -1) return mods;
      const next = [...mods];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  // Every module card's onChange hands back a fresh params object already shaped for
  // that module's own kind (see e.g. VcoModuleCard) — this just needs to slot it in.
  const updateModuleParams = useCallback((id: string, params: ModuleInstance["params"]) => {
    setModules((mods) => mods.map((m) => (m.id === id ? ({ ...m, params } as ModuleInstance) : m)));
  }, []);

  const [presets, setPresets] = useState<Preset[]>(() => {
    const saved = loadPresets();
    return saved.length > 0 ? saved : factoryPresets();
  });
  const [activePreset, setActivePreset] = useState<string | null>("init");

  const loadRack = useCallback((preset: Preset) => {
    setModules(preset.rack.modules);
    setCables(preset.rack.cables);
    setActivePreset(preset.name);
  }, []);

  // The whole rack's output: every voice source (VCO or Sampler) whose audio-out chain
  // actually reaches the master Output gets its own voice, stacked together — see
  // buildMixCode/expressionAt.
  const { code, unterminatedSourceIds } = useMemo(() => buildMixCode(modules, cables), [modules, cables]);

  const [isPlaying, setIsPlaying] = useState(false);

  // Re-evaluates whatever `code` currently is, for the room to hear — Strudel's scheduler
  // keeps running across an evaluate() while playing (same "ctrl+enter doesn't restart the
  // clock" behavior the main editor relies on), so this is also what makes knob edits (on
  // any module) actually audible on an already-playing pattern rather than just updating
  // the code preview: see the live-update effect below, which calls this on every `code`
  // change while isPlaying.
  const evaluateCurrent = useCallback(async () => {
    try {
      const strudel = await getStrudel();
      await strudel.evaluate(code + SCOPE_SUFFIX);
      send({ type: "eval", paneId: "patch-panel", code });
    } catch (err) {
      reportError(`play failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [code, send, reportError]);

  const playInRoom = useCallback(() => setIsPlaying(true), []);

  useEffect(() => {
    if (!isPlaying) return;
    const timer = setTimeout(evaluateCurrent, LIVE_UPDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [isPlaying, evaluateCurrent]);

  const stop = useCallback(async () => {
    setIsPlaying(false);
    try {
      const strudel = await getStrudel();
      strudel.hush();
    } catch (err) {
      reportError(`stop failed: ${err instanceof Error ? err.message : err}`);
    }
    send({ type: "hush", paneId: "patch-panel" });
  }, [send, reportError]);

  const [title, setTitle] = useState("");
  const [savedTrack, setSavedTrack] = useState<Track | null>(null);
  const savedTrackRef = useRef<Track | null>(null);
  useEffect(() => {
    savedTrackRef.current = savedTrack;
  }, [savedTrack]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const saveAsTrack = useCallback(async () => {
    const trackTitle = title.trim() || `patch: ${activePreset ?? "untitled"}`;
    const strudelJson: StrudelJson = { code, version: 1 };
    setSaveState("saving");
    try {
      const existing = savedTrackRef.current;
      const track: Track = existing
        ? await fetch(`/api/tracks/${existing.id}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: trackTitle, code, strudelJson }),
          }).then(jsonOrThrow)
        : await fetch("/api/tracks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              channelId,
              title: trackTitle,
              author: username,
              code,
              strudelJson,
            } satisfies CreateTrackInput),
          }).then(jsonOrThrow);
      setSavedTrack(track);
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      reportError(`couldn't save track: ${err instanceof Error ? err.message : err}`);
    }
  }, [title, activePreset, code, channelId, username, reportError]);

  const saveAsNewTrack = useCallback(() => {
    setSavedTrack(null);
    savedTrackRef.current = null;
    setSaveState("idle");
  }, []);

  // Whatever importPatch.ts's parser couldn't turn into modules/cables from the most
  // recently dropped track — shown read-only below so that source stays visible (and
  // still gets saved if you save over this rack) instead of silently vanishing. Cleared
  // on a drop that parses cleanly, so this panel only ever appears when there's actually
  // something to review.
  const [importReview, setImportReview] = useState<{
    title: string;
    code: string;
    unmatchedRanges: CodeRange[];
  } | null>(null);

  // Turns a dropped Track's source back into this app's own module+cable rack — see
  // importPatch.ts's own doc comment for what this can and can't reconstruct. Dropping a
  // track is loading a *different* rack, not continuing to edit this one's save slot, so
  // this resets the save state the same way starting a fresh preset would (saveAsNewTrack)
  // rather than risking an unrelated track silently overwriting whichever one was already
  // saved here.
  const loadTrackFromDrag = useCallback(
    (track: TrackDragPayload) => {
      const parsed = parsePatchCode(track.code);
      setModules(parsed.modules);
      setCables(parsed.cables);
      setActivePreset(null);
      setTitle(track.title);
      saveAsNewTrack();
      setImportReview(
        parsed.unmatchedRanges.length > 0
          ? { title: track.title, code: track.code, unmatchedRanges: parsed.unmatchedRanges }
          : null,
      );
    },
    [saveAsNewTrack],
  );

  const shareUrl = savedTrack
    ? `${location.origin}${location.pathname}?track=${savedTrack.id}#${channelId}`
    : null;

  const connections = useMemo(() => new Set(cables), [cables]);
  const handleConnectionsChange = useCallback((next: Set<string>) => setCables(Array.from(next)), []);

  const outputModule = modules.find(
    (m): m is Extract<ModuleInstance, { kind: "output" }> => m.kind === "output",
  );

  return (
    <PatchBayProvider connections={connections} onConnectionsChange={handleConnectionsChange}>
      <div className="patch-app">
        <header className="patch-header">
          <h1>strudel-point · patch panel</h1>
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
          <button className="secondary" onClick={stop} title="stop everything playing in this room">
            ■ hush
          </button>
        </header>

        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button className="secondary" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}

        {/* The room's shared library, tucked into a toggleable side drawer so it never
            eats into the play space — same drawer apps/web/dj/pads render (see
            @strudel-point/library): sounds (built-in packs + this room's own uploads)
            and this room's saved Tracks, all draggable. Drag a sound name onto a
            Sampler's Sample field (see SamplerModuleCard); drag a track onto the drop
            zone below to load its rack (see loadTrackFromDrag/importPatch.ts). */}
        <LibraryDrawer
          tracks={library.tracks}
          customSamples={library.customSamples}
          registeredSounds={registeredSounds}
          onPreviewSound={previewSound}
          onUploadSlice={handleUploadSlice}
          onRenameBank={handleRenameBank}
          onSeparateStems={handleSeparateStems}
          onLoadTrack={loadTrackFromDrag}
        />

        {/* Always visible (not just while a track drag is in flight) so it's discoverable
            without first knowing tracks are draggable — same "explicit drop target with
            its own label" idea as apps/dj's own .deck-drop-target. getTrackDragData only
            ever reads this app's typed track MIME (see dnd.ts), never plain text, so this
            can't misfire on a module-card reorder drag even though both live under the
            same header. */}
        <div
          className="track-drop-zone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const dragged = getTrackDragData(e);
            if (dragged) loadTrackFromDrag(dragged);
          }}
        >
          drag a track from the library here to load its rack
        </div>

        {importReview && (
          <section className="import-review">
            <div className="import-review-header">
              <span>
                "{importReview.title}" loaded — {importReview.unmatchedRanges.length} part
                {importReview.unmatchedRanges.length > 1 ? "s" : ""} of its code (highlighted below) couldn't
                be turned back into modules and were left out of the rack.
              </span>
              <button className="secondary" onClick={() => setImportReview(null)}>
                dismiss
              </button>
            </div>
            <CodeSessionView code={importReview.code} unmatchedRanges={importReview.unmatchedRanges} />
          </section>
        )}

        {/* The toolbar: add any number of module instances, wire them together yourself
            with the patch bay's cables. Nothing plays until a VCO's audio-out chain
            reaches the Output module at the bottom — see unterminatedHint below. */}
        <div className="module-toolbar">
          {ADDABLE_MODULE_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className="secondary"
              onClick={() => addModule(kind)}
              title={`add a ${MODULE_LABELS[kind]} module`}
            >
              + {MODULE_LABELS[kind]}
            </button>
          ))}
        </div>

        {unterminatedSourceIds.length > 0 && (
          <div className="unterminated-hint">
            {unterminatedSourceIds.length} voice source{unterminatedSourceIds.length > 1 ? "s" : ""}{" "}
            (VCO/Sampler) not reaching Output — cable its audio out all the way through to be heard.
          </div>
        )}

        <PresetBar
          presets={presets}
          activeName={activePreset}
          onLoad={loadRack}
          onSave={(name) => {
            setPresets(savePreset(name, { modules, cables }));
            setActivePreset(name);
          }}
          onDelete={(name) => {
            setPresets(deletePreset(name));
            if (activePreset === name) setActivePreset(null);
          }}
        />

        <main className="patch-grid">
          {modules
            .filter((m) => m.kind !== "output")
            .map((module) => (
              // The drop target for reordering — drag-start itself happens on the grip
              // inside ModuleHeader, deep within whichever card this wraps; this div only
              // needs to accept the drop and tell moveModule where the dragged module
              // landed. Dropping anywhere over a card (not just its header) moves the
              // dragged module to that card's position, same "drop it near where you want
              // it" feel as dragging a real rack module into a new slot.
              <div
                key={module.id}
                className="module-slot"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const draggedId = e.dataTransfer.getData("text/plain");
                  if (draggedId) moveModule(draggedId, module.id);
                }}
              >
                <ModuleCard
                  module={module}
                  modules={modules}
                  cables={cables}
                  onChangeParams={(params) => updateModuleParams(module.id, params)}
                  onNameChange={(name) => renameModule(module.id, name)}
                  onRemove={() => removeModule(module.id)}
                />
              </div>
            ))}
          {outputModule && <OutputModuleCard module={outputModule} />}
        </main>

        <Scope />

        <section className="panel">
          <div className="transport-row">
            <button
              onClick={playInRoom}
              disabled={isPlaying}
              title="evaluate the whole rack for the room to hear"
            >
              ▶ play in room
            </button>
            <button className="secondary" onClick={stop} disabled={!isPlaying} title="stop everything">
              ■ stop
            </button>
          </div>
          <pre className="code-preview">{code}</pre>
          <div className="save-row">
            <input
              type="text"
              placeholder="track title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <button className="secondary" onClick={saveAsTrack} disabled={saveState === "saving"}>
              {savedTrack ? "update track" : "save as track"}
            </button>
            {savedTrack && (
              <button className="secondary" onClick={saveAsNewTrack}>
                save as new
              </button>
            )}
            {saveState === "saved" && shareUrl && (
              <a className="share-link" href={shareUrl}>
                {shareUrl}
              </a>
            )}
          </div>
        </section>
      </div>
    </PatchBayProvider>
  );
}

/** Dispatches to the right module-card component by kind — the one place App.tsx needs
 * to know every ModuleKind exists, so adding a new module type later only means adding
 * one case here (plus a card component and a modules.ts/patch.ts entry). */
function ModuleCard({
  module,
  modules,
  cables,
  onChangeParams,
  onNameChange,
  onRemove,
}: {
  module: ModuleInstance;
  modules: ModuleInstance[];
  cables: string[];
  onChangeParams: (params: ModuleInstance["params"]) => void;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}) {
  switch (module.kind) {
    case "sequencer":
      return (
        <SequencerModuleCard
          module={module}
          onChange={onChangeParams}
          onNameChange={onNameChange}
          onRemove={onRemove}
          sequenceIsGated={sequenceIsGatedFor(module, modules, cables)}
          effectiveSequence={effectiveSequenceFor(module, modules, cables)}
        />
      );
    case "vco":
      return (
        <VcoModuleCard
          module={module}
          onChange={onChangeParams}
          onNameChange={onNameChange}
          onRemove={onRemove}
        />
      );
    case "sampler":
      return (
        <SamplerModuleCard
          module={module}
          onChange={onChangeParams}
          onNameChange={onNameChange}
          onRemove={onRemove}
        />
      );
    case "vcf":
      return (
        <VcfModuleCard
          module={module}
          onChange={onChangeParams}
          onNameChange={onNameChange}
          onRemove={onRemove}
        />
      );
    case "envelope":
      return (
        <EnvelopeModuleCard
          module={module}
          onChange={onChangeParams}
          onNameChange={onNameChange}
          onRemove={onRemove}
        />
      );
    case "filterenv":
      return (
        <FilterEnvModuleCard
          module={module}
          onChange={onChangeParams}
          onNameChange={onNameChange}
          onRemove={onRemove}
        />
      );
    case "filterlfo":
      return (
        <FilterLfoModuleCard
          module={module}
          onChange={onChangeParams}
          onNameChange={onNameChange}
          onRemove={onRemove}
        />
      );
    case "pitchenv":
      return (
        <PitchEnvModuleCard
          module={module}
          onChange={onChangeParams}
          onNameChange={onNameChange}
          onRemove={onRemove}
        />
      );
    case "vibrato":
      return (
        <VibratoModuleCard
          module={module}
          onChange={onChangeParams}
          onNameChange={onNameChange}
          onRemove={onRemove}
        />
      );
    case "fmop":
      return (
        <FmOpModuleCard
          module={module}
          onChange={onChangeParams}
          onNameChange={onNameChange}
          onRemove={onRemove}
        />
      );
    case "delay":
      return (
        <DelayModuleCard
          module={module}
          onChange={onChangeParams}
          onNameChange={onNameChange}
          onRemove={onRemove}
        />
      );
    case "reverb":
      return (
        <ReverbModuleCard
          module={module}
          onChange={onChangeParams}
          onNameChange={onNameChange}
          onRemove={onRemove}
        />
      );
    case "siggen":
      return (
        <SiggenModuleCard
          module={module}
          onChange={onChangeParams}
          onNameChange={onNameChange}
          onRemove={onRemove}
        />
      );
    case "eos":
      return <EosModuleCard module={module} onNameChange={onNameChange} onRemove={onRemove} />;
    case "modpedal":
      return (
        <ModPedalModuleCard
          module={module}
          onChange={onChangeParams}
          onNameChange={onNameChange}
          onRemove={onRemove}
        />
      );
    case "channel":
      return <ChannelModuleCard module={module} onNameChange={onNameChange} onRemove={onRemove} />;
    case "output":
      return null; // rendered separately, always last — see App's return above.
  }
}
