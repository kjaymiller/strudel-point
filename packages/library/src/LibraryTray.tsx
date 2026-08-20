// The shared "library" panel — every app (web/dj/pads/patch-panel) that renders this
// shows the same three tabs, sourced the same way: this room's saved Tracks, every sound
// currently registered with Strudel (built-in packs + this room's own custom uploads,
// already merged by whichever registry the caller reads — see `registeredSounds`
// below), and — when the caller wires it up — a real sample editor (see SampleEditor.tsx,
// moved here from apps/web's standalone BeatAnalyzer.tsx) for cutting a dropped beat into
// a bank, resampling, and (optionally) stem separation. The sounds/tracks tabs stay
// read+drag only regardless; only the edit tab actually creates anything, and only once
// an app supplies real onUploadSlice/onRenameBank handlers — omit them and that tab
// simply doesn't appear, same as apps/web's own CustomSamples.tsx still being the place
// bank rename/delete *management* (as opposed to creation) lives.
//
// Classless of any particular visual language on purpose — no bundled CSS. Every class
// name here (`library-tray`, `library-tab`, `library-track-row`, `library-sound-chip`,
// ...) is meant to be styled per-app, same as this app's own existing `panel`/`knob`
// convention, so the tray reads as native to whichever app it's dropped into rather than
// visually foreign.
import { useMemo, useRef, useState } from "react";
import type { CustomSample, Track } from "@strudel-point/shared";
import { groupSampleBanks, playableName } from "./banks";
import { setSoundDragData, setTrackDragData } from "./dnd";
import { SampleEditor, type SampleEditorHandle, type StemResult } from "./SampleEditor";

export interface RegisteredSound {
  name: string;
  /** Whatever tag/type the registry itself carries — "dirt-samples", "tidal-drum-
   * machines", a custom bank's own name, or a generic fallback. Display-only. */
  type: string;
}

export interface LibraryTrayProps {
  tracks: Track[];
  /** This room's own uploads — rendered as their own "My sounds" section, grouped by
   * bank, ahead of the merged built-in+custom search list below. Optional: a caller with
   * nothing else to show here (no custom-sample feature at all) can just omit it. */
  customSamples?: CustomSample[];
  /** Every sound currently registered with *this app's own* Strudel module — built-ins
   * and custom uploads already merged (see e.g. `strudel.soundMap.get()`). Only the
   * caller knows this, since each app has its own singleton with its own prebake. */
  registeredSounds: RegisteredSound[];
  /** Clicking a sound's name auditions it in place — doesn't touch anything else. */
  onPreviewSound?: (name: string) => void;
  /** Clicking a track row's "load" button — what "using" a track means is entirely up
   * to the caller (open it in a deck, load its rack, drop its code into the editor). */
  onLoadTrack?: (track: Track) => void;
  /** Wire these two up to enable the "edit" tab at all (see SampleEditor.tsx) — both
   * required together, since a bank you can create but never rename isn't much of an
   * editor. Leave both undefined to hide the tab entirely. */
  onUploadSlice?: (file: File, name: string, bankName: string, bankIndex: number) => Promise<CustomSample>;
  onRenameBank?: (oldName: string, newName: string) => void;
  /** Enables the editor's "separate into stems" section — see SampleEditor.tsx's own doc
   * comment on why this is independently optional from onUploadSlice/onRenameBank. */
  onSeparateStems?: (file: File, baseName: string) => Promise<StemResult[]>;
}

type Tab = "sounds" | "tracks" | "edit";

function SoundChip({
  name,
  onPreview,
  onEdit,
  selected,
  onToggleSelected,
}: {
  name: string;
  onPreview?: (name: string) => void;
  /** Only ever passed for a "my sounds" chip (see playableName) — sends this exact sound
   * back into the edit tab's SampleEditor to be re-scrubbed/chopped, same "scrub/chop"
   * action apps/web's CustomSamples.tsx already has. Absent for "all sounds" entries,
   * which don't carry a fetchable url of their own to send. */
  onEdit?: () => void;
  /** Whether this chip is checked for the "merge selected" action below — same
   * my-sounds-only restriction as onEdit, and for the same reason (needs a real url). */
  selected?: boolean;
  onToggleSelected?: () => void;
}) {
  return (
    <div className="library-sound-chip" draggable onDragStart={(e) => setSoundDragData(e, { name, label: name })}>
      {onToggleSelected && (
        <input
          type="checkbox"
          className="library-sound-select"
          checked={selected ?? false}
          onChange={onToggleSelected}
          title={`select "${name}" to merge with other selected sounds`}
          aria-label={`select ${name} for merging`}
        />
      )}
      <button
        type="button"
        className="library-sound-name"
        onClick={() => onPreview?.(name)}
        aria-label={`preview ${name}`}
        title="drag onto a sample slot, or click to preview"
      >
        {name}
      </button>
      {onEdit && (
        <button type="button" className="library-sound-edit" onClick={onEdit} title={`edit ${name}`} aria-label={`edit ${name}`}>
          ✎
        </button>
      )}
    </div>
  );
}

export function LibraryTray({
  tracks,
  customSamples,
  registeredSounds,
  onPreviewSound,
  onLoadTrack,
  onUploadSlice,
  onRenameBank,
  onSeparateStems,
}: LibraryTrayProps) {
  const [tab, setTab] = useState<Tab>("sounds");
  const [query, setQuery] = useState("");
  const editorRef = useRef<SampleEditorHandle>(null);
  const canEdit = Boolean(onUploadSlice && onRenameBank);

  const editSound = (sample: CustomSample) => {
    setTab("edit");
    editorRef.current?.loadFromSamples([{ url: sample.url, label: playableName(sample) }]);
  };

  // Checked "my sounds" entries awaiting the "merge selected" action below — restoring
  // apps/web's old CustomSamples.tsx checkbox "merge & chop" flow, generalized into the
  // shared tray. Keyed by sample id, cleared on every successful merge (not persisted
  // across a search-query change or anything else — picking sounds to merge is meant to
  // be a quick one-off, not a saved selection).
  const [selectedForMerge, setSelectedForMerge] = useState<Set<string>>(new Set());
  const toggleMergeSelected = (id: string) => {
    setSelectedForMerge((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const mergeSelected = () => {
    const picked = (customSamples ?? []).filter((s) => selectedForMerge.has(s.id));
    if (picked.length === 0) return;
    setTab("edit");
    editorRef.current?.loadFromSamples(picked.map((s) => ({ url: s.url, label: playableName(s) })));
    setSelectedForMerge(new Set());
  };

  // Which bank headers are collapsed to just their name — client-side only, same
  // "resets on reload rather than round-tripping through the server" choice
  // apps/web's CustomSamples.tsx already makes for the identical control.
  const [collapsedBanks, setCollapsedBanks] = useState<Set<string>>(new Set());
  const toggleBankCollapsed = (bankName: string) => {
    setCollapsedBanks((prev) => {
      const next = new Set(prev);
      if (next.has(bankName)) next.delete(bankName);
      else next.add(bankName);
      return next;
    });
  };

  const { banks: myBanks, singles: mySingles } = useMemo(
    () => groupSampleBanks(customSamples ?? []),
    [customSamples],
  );

  const q = query.trim().toLowerCase();

  // One search box, filtering both sections at once: a bank matches if its own name does
  // or any of its slices' playable names do (so searching "kick" still surfaces a
  // "drums" bank that has a kick slice in it, not just banks literally named "kick").
  const filteredMyBanks = useMemo(() => {
    if (!q) return myBanks;
    return myBanks.filter(
      (bank) => bank.bankName.toLowerCase().includes(q) || bank.slices.some((s) => playableName(s).toLowerCase().includes(q)),
    );
  }, [myBanks, q]);
  const filteredMySingles = useMemo(() => {
    if (!q) return mySingles;
    return mySingles.filter((s) => playableName(s).toLowerCase().includes(q));
  }, [mySingles, q]);

  const filteredSounds = useMemo(() => {
    const list = q ? registeredSounds.filter((s) => s.name.toLowerCase().includes(q)) : registeredSounds;
    // Keeps the DOM light regardless of how many hundred built-in one-shots are loaded —
    // same cap apps/web's own SoundBank uses for the identical reason.
    return list.slice(0, 200);
  }, [registeredSounds, q]);

  return (
    <div className="library-tray">
      <div className="library-tabs" role="tablist" aria-label="library">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "sounds"}
          className={`secondary library-tab${tab === "sounds" ? " active" : ""}`}
          onClick={() => setTab("sounds")}
        >
          sounds
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "tracks"}
          className={`secondary library-tab${tab === "tracks" ? " active" : ""}`}
          onClick={() => setTab("tracks")}
        >
          tracks
        </button>
        {canEdit && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === "edit"}
            className={`secondary library-tab${tab === "edit" ? " active" : ""}`}
            onClick={() => setTab("edit")}
          >
            edit
          </button>
        )}
      </div>

      {tab === "sounds" && (
        <div className="library-sounds">
          <input
            className="library-search"
            placeholder={`search ${registeredSounds.length} sounds…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {customSamples !== undefined && (
            <div className="library-my-sounds">
              <span className="library-section-label">my sounds</span>
              {canEdit && selectedForMerge.size > 0 && (
                <button type="button" className="secondary library-merge-button" onClick={mergeSelected}>
                  merge {selectedForMerge.size} selected → edit
                </button>
              )}
              {filteredMyBanks.length === 0 && filteredMySingles.length === 0 && (
                <p className="library-empty">{q ? "no matches" : "no uploads in this room yet"}</p>
              )}
              <div className="library-sound-list">
                {filteredMyBanks.map((bank) => {
                  const collapsed = collapsedBanks.has(bank.bankName);
                  return (
                    <div key={bank.bankName} className="library-bank-group">
                      <button
                        type="button"
                        className="library-bank-name"
                        onClick={() => toggleBankCollapsed(bank.bankName)}
                        title={`${bank.slices.length} slice(s) — click to ${collapsed ? "expand" : "collapse"}`}
                      >
                        <span className="library-bank-collapse-arrow">{collapsed ? "▸" : "▾"}</span>
                        {bank.bankName}
                        {collapsed ? ` (${bank.slices.length})` : ""}
                      </button>
                      {!collapsed &&
                        bank.slices.map((s) => (
                          <SoundChip
                            key={s.id}
                            name={playableName(s)}
                            onPreview={onPreviewSound}
                            onEdit={canEdit ? () => editSound(s) : undefined}
                            selected={selectedForMerge.has(s.id)}
                            onToggleSelected={canEdit ? () => toggleMergeSelected(s.id) : undefined}
                          />
                        ))}
                    </div>
                  );
                })}
                {filteredMySingles.map((s) => (
                  <SoundChip
                    key={s.id}
                    name={playableName(s)}
                    onPreview={onPreviewSound}
                    onEdit={canEdit ? () => editSound(s) : undefined}
                    selected={selectedForMerge.has(s.id)}
                    onToggleSelected={canEdit ? () => toggleMergeSelected(s.id) : undefined}
                  />
                ))}
              </div>
            </div>
          )}
          <span className="library-section-label">all sounds</span>
          <div className="library-sound-list">
            {registeredSounds.length === 0 && <p className="library-empty">loading sounds…</p>}
            {filteredSounds.map((s) => (
              <SoundChip key={s.name} name={s.name} onPreview={onPreviewSound} />
            ))}
          </div>
        </div>
      )}

      {tab === "tracks" && (
        <div className="library-tracks">
          {tracks.length === 0 && <p className="library-empty">no saved tracks yet</p>}
          {tracks.map((t) => (
            <div
              key={t.id}
              className="library-track-row"
              draggable
              onDragStart={(e) => setTrackDragData(e, { id: t.id, title: t.title, code: t.code })}
            >
              <span className="library-track-title">{t.title}</span>
              {onLoadTrack && (
                <button type="button" className="secondary" onClick={() => onLoadTrack(t)}>
                  load
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Kept mounted (just hidden) rather than unmounted on tab switch — SampleEditor's
          own decode/analysis/upload-progress state shouldn't vanish because someone
          glanced at another tab mid-edit. */}
      {canEdit && (
        <div style={{ display: tab === "edit" ? "block" : "none" }}>
          <SampleEditor
            ref={editorRef}
            onUploadSlice={onUploadSlice!}
            onRenameBank={onRenameBank!}
            onSeparateStems={onSeparateStems}
          />
        </div>
      )}
    </div>
  );
}
