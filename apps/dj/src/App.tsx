import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChannelEvent, CreateTrackInput, StrudelJson, Track } from "@strudel-point/shared";
import { Deck } from "./components/Deck";
import { getStrudel, setCps } from "./strudel";
import { useChannelSocket } from "./ws";
import { buildLiveCode, buildSetCode, splitTrackCode, type DeckConfig, type Scene } from "./chain";

const EVAL_DEBOUNCE_MS = 120;
// Longer than EVAL_DEBOUNCE_MS on purpose — the live pattern should hot-swap immediately on
// every knob move, but persisting the shareable set to the server doesn't need to keep pace
// with every single drag tick, just settle a beat after you stop touching anything.
const AUTOSAVE_DEBOUNCE_MS = 3000;
// Fallback tempo when the master deck's track never declared its own setcps() (see
// splitTrackCode) — nothing to guess from, since a Track is code, not decoded audio.
const DEFAULT_BPM = 120;

type DeckId = "A" | "B";

function channelIdFromLocation(): string {
  const hash = location.hash.replace(/^#/, "");
  return hash || "lobby";
}

function trackIdFromLocation(): string | null {
  return new URLSearchParams(location.search).get("track");
}

function ensureUsername(): string {
  // Same localStorage key the main web app uses, so opening both apps in one browser
  // shows up as one identity in the room rather than two strangers.
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

function navigateToChannel(channelId: string) {
  location.hash = channelId;
}

export default function App() {
  const [channelId, setChannelId] = useState(channelIdFromLocation);
  const [username] = useState(ensureUsername);
  const [roomInput, setRoomInput] = useState(channelId);
  // Every track saved in this room — the pool each deck's <select> picks from. dj's whole
  // job is playing *existing* tracks; cutting audio into sample banks and pads lives in
  // apps/pads now, a separate app, so there's nothing else to load onto a deck.
  const [trackList, setTrackList] = useState<Track[]>([]);
  const [decks, setDecks] = useState<Record<DeckId, DeckConfig | null>>({ A: null, B: null });
  const [master, setMaster] = useState<DeckId>("A");
  const [crossfade, setCrossfade] = useState(0.5);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [sceneBars, setSceneBars] = useState(8);
  const [setTitle, setSetTitle] = useState("");
  const [savedTrack, setSavedTrack] = useState<Track | null>(null);
  // Auto-save (see the effect below, near setChain/hasSetContent) tracking — declared here
  // rather than down where it's used so the room-change effect can reset them too.
  const [autosaveState, setAutosaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTrackRef = useRef<Track | null>(null);
  useEffect(() => {
    savedTrackRef.current = savedTrack;
  }, [savedTrack]);
  // Guards against re-saving identical content — the autosave effect re-fires on every
  // setChain/title change, but a bunch of those are the same content re-arriving (e.g.
  // savedTrack itself updating, or a knob move that got debounced away already).
  const lastAutosavedRef = useRef<string | null>(null);
  const [loadedTrack, setLoadedTrack] = useState<Track | null>(null);
  const [error, setError] = useState<string | null>(null);
  const evalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showCode, setShowCode] = useState(false);
  // null = "follow the knobs" — the eval effect below just evaluates buildLiveCode(liveScene)
  // as it always has. Once you edit the code panel directly, this holds your hand-typed
  // text instead, and *that's* what gets evaluated (still debounced, still broadcast) —
  // right up until you touch any knob/deck control again, at which point every one of
  // those handlers clears this back to null so the mix reverts to being knob-generated.
  // "The knobs always win" is the whole rule; no separate lock/unlock affordance needed.
  const [codeDraft, setCodeDraft] = useState<string | null>(null);
  const clearCodeDraft = useCallback(() => setCodeDraft(null), []);

  const reportError = useCallback((message: string) => setError(message), []);

  // Nothing left for dj to react to over the socket — sample/bank events belong to
  // apps/pads now. Kept as a named (rather than inline) handler in case that changes;
  // useChannelSocket still needs *something* here to receive eval/hush/etc.
  const handleEvent = useCallback((_event: ChannelEvent) => {}, []);

  const { connected, send } = useChannelSocket({ channelId, username, onEvent: handleEvent, onError: reportError });

  useEffect(() => {
    const onHashChange = () => setChannelId(channelIdFromLocation());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    setRoomInput(channelId);
    setDecks({ A: null, B: null });
    setScenes([]);
    setSavedTrack(null);
    setAutosaveState("idle");
    lastAutosavedRef.current = null;
    fetch(`/api/channels/${channelId}/tracks`)
      .then(jsonOrThrow)
      .then(setTrackList)
      .catch((err) => reportError(`couldn't load this room's saved tracks: ${err.message}`));
  }, [channelId, reportError]);

  // ?track=<id> loads a previously-saved set (this app's own, or any Track from the main
  // editor — it's all just Strudel source) for a one-click "play this set" rather than
  // auto-evaluating on load, since audio can't start without a real user gesture anyway.
  useEffect(() => {
    const id = trackIdFromLocation();
    if (!id) return;
    fetch(`/api/tracks/${id}`)
      .then(jsonOrThrow)
      .then((track: Track) => {
        setLoadedTrack(track);
        if (track.channelId !== channelId) navigateToChannel(track.channelId);
      })
      .catch((err) => reportError(`couldn't load that set: ${err.message}`));
  }, [reportError]); // eslint-disable-line react-hooks/exhaustive-deps -- runs once, from the URL as loaded

  // A deck's tempo is whatever its track itself declared via setcps() (see
  // splitTrackCode) — there's no audio to guess a bpm from, it's just code — times its
  // own speed knob. Falls back to DEFAULT_BPM if the master deck's track never declared
  // one (or no deck is master yet).
  const masterBpm = useMemo(() => {
    const deck = decks[master];
    if (!deck) return DEFAULT_BPM;
    const { bpm } = splitTrackCode(deck.code);
    return (bpm ?? DEFAULT_BPM) * deck.speed;
  }, [decks, master]);

  const liveScene: Scene = useMemo(
    () => ({ bars: sceneBars, masterBpm, crossfade, deckA: decks.A, deckB: decks.B }),
    [decks, crossfade, masterBpm, sceneBars],
  );

  // Every knob/fader move recompiles the whole mix and re-evaluates — Strudel's
  // evaluate() hot-swaps a running pattern rather than restarting it from cycle 0, the
  // same as re-running ctrl+enter on modified code in the main editor, so this is a
  // continuous live remix, not a series of restarts. Debounced so a fast drag doesn't
  // flood the room with eval broadcasts. codeDraft (see the code panel below) takes over
  // as the thing being evaluated whenever it's set — it's still exactly this same
  // pipeline (debounce, evaluate, broadcast), just fed hand-typed text instead of
  // buildLiveCode's output.
  useEffect(() => {
    if (!decks.A && !decks.B && codeDraft === null) return;
    if (evalTimer.current) clearTimeout(evalTimer.current);
    evalTimer.current = setTimeout(async () => {
      const code = codeDraft ?? buildLiveCode(liveScene);
      // The tempo goes to the repl directly (see strudel.ts's setCps) rather than as
      // part of the evaluated text — evaluating a string that still has its own bare
      // `setcps(...)` call in it throws, every time, on this @strudel/web version. Honor
      // whatever the code itself declares (a hand-edit in the code panel might have
      // typed a different one) and only fall back to the knob-derived masterBpm when it
      // doesn't declare one.
      const { bpm, pattern } = splitTrackCode(code);
      try {
        const strudel = await getStrudel();
        setCps((bpm ?? liveScene.masterBpm) / 4 / 60);
        await strudel.evaluate(pattern);
        send({ type: "eval", paneId: "dj", code });
      } catch (err) {
        reportError(`mix failed to play: ${err instanceof Error ? err.message : err}`);
      }
    }, EVAL_DEBOUNCE_MS);
    return () => {
      if (evalTimer.current) clearTimeout(evalTimer.current);
    };
  }, [liveScene, codeDraft, decks.A, decks.B, send, reportError]);

  // Same carry-speed/gain/fx-across-a-reload shape every deck-loading path here uses —
  // loading a different track onto a deck shouldn't silently reset how it's being
  // processed. All fx off by default: turning one on is an explicit action, not a side
  // effect of touching a knob.
  const loadDeck = useCallback(
    (which: DeckId, track: Track) => {
      // Fire-and-forget, called synchronously right here (inside the <select>'s onChange
      // handler) specifically so the AudioContext.resume() inside getStrudel() happens
      // within the same tick as this genuine user gesture. The actual evaluate() call
      // for this deck happens later, debounced, inside a setTimeout — by the time it
      // runs it's no longer "inside" any gesture as far as a strict browser autoplay
      // policy (Safari especially) is concerned, so if this were the *only* place
      // getStrudel() got called, the context could stay silently suspended forever:
      // no thrown error, evaluate() succeeds, samples even decode — it just never
      // reaches the speakers. getStrudel() itself is idempotent (see strudel.ts), so
      // calling it again from the debounced effect later costs nothing.
      void getStrudel();
      clearCodeDraft();
      setDecks((prev) => ({
        ...prev,
        [which]: {
          trackId: track.id,
          trackTitle: track.title,
          code: track.code,
          speed: prev[which]?.speed ?? 1,
          gain: prev[which]?.gain ?? 1,
          playing: true,
          hpfEnabled: prev[which]?.hpfEnabled ?? false,
          hpf: prev[which]?.hpf ?? 20,
          lpfEnabled: prev[which]?.lpfEnabled ?? false,
          lpf: prev[which]?.lpf ?? 20000,
          lfoEnabled: prev[which]?.lfoEnabled ?? false,
          lfoRate: prev[which]?.lfoRate ?? 1,
          lfoDepth: prev[which]?.lfoDepth ?? 0,
          duckEnabled: prev[which]?.duckEnabled ?? false,
          duckRate: prev[which]?.duckRate ?? 8,
          duckDepth: prev[which]?.duckDepth ?? 0,
        },
      }));
    },
    [clearCodeDraft],
  );

  const updateDeck = useCallback(
    (which: DeckId, patch: Partial<DeckConfig>) => {
      // Same reasoning as loadDeck's own call — this is the handler behind every knob,
      // the play/stop toggle, and "make master", all genuine clicks/drags, so this is
      // where the AudioContext actually needs to get resumed, not 120ms later inside the
      // debounced effect.
      void getStrudel();
      clearCodeDraft();
      setDecks((prev) => (prev[which] ? { ...prev, [which]: { ...prev[which]!, ...patch } } : prev));
    },
    [clearCodeDraft],
  );

  const syncDeck = useCallback(
    (which: DeckId) => {
      const target = decks[which];
      if (!target) return;
      const { bpm } = splitTrackCode(target.code);
      if (bpm == null) return; // this track never declared its own tempo — nothing to match
      updateDeck(which, { speed: masterBpm / bpm });
    },
    [decks, masterBpm, updateDeck],
  );

  const addScene = useCallback(() => {
    setScenes((prev) => [...prev, { ...liveScene, bars: sceneBars }]);
  }, [liveScene, sceneBars]);

  const removeScene = useCallback((index: number) => {
    setScenes((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // The set chain — either every scene queued up, or (before "add scene" has been pressed
  // even once) just whatever's live right now — memoized so the autosave effect below only
  // fires on an actual content change, not a new array identity every render.
  const setChain: Scene[] = useMemo(() => (scenes.length > 0 ? scenes : [liveScene]), [scenes, liveScene]);
  const hasSetContent = decks.A !== null || decks.B !== null || scenes.length > 0;

  // Auto-save, not a manual "save" button: you're mixing live, on the fly, so the
  // shareable set should just always reflect whatever's currently playing rather than
  // needing an explicit save/update click every time it changes. First meaningful change
  // creates the track once; every change after that PUT-updates that same one.
  useEffect(() => {
    if (!hasSetContent) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(async () => {
      const title = setTitle.trim() || "untitled set";
      const code = buildSetCode(setChain);
      const strudelJson: StrudelJson = { code, cps: setChain[0].masterBpm / 4 / 60, version: 1 };
      const signature = JSON.stringify({ title, code });
      if (signature === lastAutosavedRef.current) return;
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
              body: JSON.stringify({ channelId, title, author: username, code, strudelJson } satisfies CreateTrackInput),
            }).then(jsonOrThrow);
        lastAutosavedRef.current = signature;
        setSavedTrack(track);
        setAutosaveState("saved");
      } catch (err) {
        setAutosaveState("error");
        reportError(`autosave failed: ${err instanceof Error ? err.message : err}`);
      }
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [hasSetContent, setChain, setTitle, channelId, username, reportError]);

  const playLoadedTrack = useCallback(async () => {
    if (!loadedTrack) return;
    // Same setCps-directly-then-evaluate-the-stripped-pattern move as the live-mix eval
    // effect above, and for the same reason: loadedTrack.code still has its own leading
    // `setcps(...)` (every track this app saves does), and evaluating that text as-is
    // would throw immediately.
    const { bpm, pattern } = splitTrackCode(loadedTrack.code);
    try {
      const strudel = await getStrudel();
      if (bpm != null) setCps(bpm / 4 / 60);
      await strudel.evaluate(pattern);
      send({ type: "eval", paneId: "dj", code: loadedTrack.code });
    } catch (err) {
      reportError(`couldn't play "${loadedTrack.title}": ${err instanceof Error ? err.message : err}`);
    }
  }, [loadedTrack, send, reportError]);

  const hush = useCallback(async () => {
    try {
      const strudel = await getStrudel();
      strudel.hush();
    } catch (err) {
      reportError(`hush failed: ${err instanceof Error ? err.message : err}`);
    }
    send({ type: "hush", paneId: "dj" });
  }, [send, reportError]);

  // A hard, immediate stop for one deck — see Deck.tsx's onCut doc comment for why this
  // needs to be this blunt: a long track already sounding keeps ringing out on its own
  // no matter how fast a re-evaluate drops that deck from the pattern, since evaluate()
  // only affects what gets scheduled going forward, never voices already triggered.
  // hush() is the only thing in Strudel's public API that actually kills audio that's
  // already sounding — there's no per-deck version of it, so this hushes everything for
  // an instant, then marks the deck stopped so the very next debounced re-evaluate
  // (already wired to fire on any deck-state change) brings the *other* deck back in
  // without it, rather than leaving the room in silence until something else happens to
  // touch a knob.
  const cutDeck = useCallback(
    async (which: DeckId) => {
      try {
        const strudel = await getStrudel();
        strudel.hush();
        send({ type: "hush", paneId: "dj" });
      } catch (err) {
        reportError(`cut failed: ${err instanceof Error ? err.message : err}`);
      }
      updateDeck(which, { playing: false });
    },
    [send, reportError, updateDeck],
  );

  const shareUrl = savedTrack ? `${location.origin}${location.pathname}?track=${savedTrack.id}#${channelId}` : null;

  return (
    <div className="dj-app">
      <header className="dj-header">
        <h1>strudel-point · dj mix</h1>
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
        <span className={`connection-dot ${connected ? "connected" : ""}`} title={connected ? "connected" : "disconnected"} />
        <button className="secondary" onClick={hush}>
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

      {loadedTrack && (
        <div className="loaded-track">
          <span>
            loaded set "{loadedTrack.title}" (from this room's saved tracks) —
          </span>
          <button onClick={playLoadedTrack}>▶ play this set</button>
        </div>
      )}

      <div className="decks">
        <Deck
          label="deck A"
          deck={decks.A}
          tracks={trackList}
          isMaster={master === "A"}
          onLoadTrack={(id) => {
            const track = trackList.find((t) => t.id === id);
            if (track) loadDeck("A", track);
          }}
          onSetSpeed={(speed) => updateDeck("A", { speed })}
          onSetGain={(gain) => updateDeck("A", { gain })}
          onSetFx={(patch) => updateDeck("A", patch)}
          onTogglePlaying={() => updateDeck("A", { playing: !decks.A?.playing })}
          onCut={() => cutDeck("A")}
          onMakeMaster={() => {
            clearCodeDraft();
            setMaster("A");
          }}
          onSync={() => syncDeck("A")}
        />

        <div className="crossfader-panel">
          <p className="master-bpm">{Math.round(masterBpm)} bpm (master: deck {master})</p>
          <label className="deck-row deck-row--vertical">
            <span>A ← crossfader → B</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={crossfade}
              onChange={(e) => {
                clearCodeDraft();
                setCrossfade(Number(e.target.value));
              }}
            />
          </label>
        </div>

        <Deck
          label="deck B"
          deck={decks.B}
          tracks={trackList}
          isMaster={master === "B"}
          onLoadTrack={(id) => {
            const track = trackList.find((t) => t.id === id);
            if (track) loadDeck("B", track);
          }}
          onSetSpeed={(speed) => updateDeck("B", { speed })}
          onSetGain={(gain) => updateDeck("B", { gain })}
          onSetFx={(patch) => updateDeck("B", patch)}
          onTogglePlaying={() => updateDeck("B", { playing: !decks.B?.playing })}
          onCut={() => cutDeck("B")}
          onMakeMaster={() => {
            clearCodeDraft();
            setMaster("B");
          }}
          onSync={() => syncDeck("B")}
        />
      </div>

      <section className="code-section">
        <div className="code-section-header">
          <h2>code</h2>
          <button className="secondary" onClick={() => setShowCode((v) => !v)}>
            {showCode ? "hide code" : "show code"}
          </button>
        </div>
        {showCode && (
          <>
            <p className="hint">
              This is the actual Strudel driving the live mix right now — every knob above just
              recompiles it. Edit it directly to push the mix further than the knobs expose;
              touching any knob, deck, or the crossfader regenerates it from scratch and
              discards the edit.
            </p>
            <textarea
              className="code-editor"
              value={codeDraft ?? buildLiveCode(liveScene)}
              onChange={(e) => setCodeDraft(e.target.value)}
              spellCheck={false}
              rows={10}
            />
            {codeDraft !== null && (
              <button className="secondary" onClick={clearCodeDraft}>
                revert to knob-generated code
              </button>
            )}
          </>
        )}
      </section>

      <section className="set-builder">
        <h2>set chain</h2>
        <p className="hint">
          "add scene" freezes the current mix (both decks, speeds, gains, crossfader) for a
          given number of cycles into the chain below. The whole chain auto-saves as one
          Strudel track — <code>arrange()</code> under the hood — playable from a URL with
          this room's number, from this app or the main editor. No manual save needed: it
          keeps itself up to date as you keep mixing.
        </p>

        <div className="scene-controls">
          <label>
            cycles
            <input
              type="number"
              min={1}
              max={256}
              value={sceneBars}
              onChange={(e) => setSceneBars(Math.max(1, Math.min(256, Number(e.target.value))))}
            />
          </label>
          <button onClick={addScene} disabled={!decks.A && !decks.B}>
            + add current mix as a scene
          </button>
        </div>

        {scenes.length > 0 && (
          <ol className="scene-list">
            {scenes.map((s, i) => (
              <li key={i}>
                <span>
                  {i + 1}. {s.bars} cycles @ ~{Math.round(s.masterBpm)}bpm — A:
                  {s.deckA ? `${s.deckA.trackTitle} (${s.deckA.speed.toFixed(2)}×)` : "—"} / B:
                  {s.deckB ? `${s.deckB.trackTitle} (${s.deckB.speed.toFixed(2)}×)` : "—"} · fader{" "}
                  {s.crossfade.toFixed(2)}
                </span>
                <button className="secondary" onClick={() => removeScene(i)}>
                  remove
                </button>
              </li>
            ))}
          </ol>
        )}

        <div className="save-set">
          <input value={setTitle} onChange={(e) => setSetTitle(e.target.value)} placeholder="set title" />
          <span className={`autosave-status autosave-status--${autosaveState}`}>
            {autosaveState === "saving" && "saving…"}
            {autosaveState === "saved" && "✓ saved"}
            {autosaveState === "error" && "autosave failed"}
            {autosaveState === "idle" && hasSetContent && "will save automatically"}
          </span>
        </div>

        {shareUrl && (
          <p className="share-url">
            share this room + set — stays live-updated as you keep mixing:
            <input readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
          </p>
        )}
      </section>
    </div>
  );
}
