import { useCallback, useMemo, useRef, useState } from "react";
import type { CustomSample } from "@strudel-point/shared";
import { groupSampleBanks, playableName } from "@strudel-point/library";
import { setSoundDragData } from "../sampleDnd";

// Re-exported under its original name so App.tsx's existing `import { CustomSamples,
// playableName } from "./components/CustomSamples"` keeps working unchanged — the real
// implementation now lives in @strudel-point/library, shared by every strudel-point app.
export { playableName };

interface CustomSamplesProps {
  samples: CustomSample[];
  onUpload: (file: File, name: string) => void;
  onDelete: (sample: CustomSample) => void;
  /** Single click on a sample: audition it in place — doesn't touch the editor or the loop. */
  onPreview: (name: string) => void;
  /** Double click on a sample: insert its name into the editor at the cursor. */
  onPick: (name: string) => void;
  onRenameBank: (oldName: string, newName: string) => void;
  /**
   * Sends one or more existing sounds to the sample editor below (@strudel-point/library's
   * SampleEditor, via its `loadFromSamples`) to be re-scrubbed/chopped, or — when more than one is passed —
   * merged end-to-end first and then chopped. Never mutates `samples` itself; editing
   * always produces a new bank.
   */
  onEditSamples: (samples: CustomSample[]) => void;
}

export function suggestName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 64) || "sample";
}

/**
 * Click-to-edit rename control for a bank's shared name — the "parent dir" of its slices —
 * plus the collapse/expand toggle for that header, since they share the same row.
 */
function BankNameEditor({
  bankName,
  sliceCount,
  collapsed,
  onToggleCollapsed,
  onRename,
  onDeleteBank,
}: {
  bankName: string;
  sliceCount: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onRename: (newName: string) => void;
  onDeleteBank: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(bankName);

  if (!editing) {
    return (
      <div className="bank-header" onClick={onToggleCollapsed} title={collapsed ? "expand" : "collapse"}>
        <span className="bank-collapse-arrow">{collapsed ? "▸" : "▾"}</span>
        <span className="title">
          "{bankName}"{collapsed ? ` (${sliceCount})` : ""}
        </span>
        <button
          className="secondary"
          onClick={(e) => {
            e.stopPropagation();
            setValue(bankName);
            setEditing(true);
          }}
        >
          rename
        </button>
        <button
          className="secondary"
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm(`delete all ${sliceCount} sample(s) in "${bankName}"?`)) {
              onDeleteBank();
            }
          }}
        >
          delete
        </button>
      </div>
    );
  }

  const commit = () => {
    const trimmed = value.trim();
    setEditing(false);
    if (trimmed && trimmed !== bankName) onRename(trimmed);
  };

  return (
    <div className="bank-header" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        style={{ flex: 1 }}
      />
      <button onClick={commit}>save</button>
      <button className="secondary" onClick={() => setEditing(false)}>
        cancel
      </button>
    </div>
  );
}

/** Drag-and-drop zone + management list for audio files a user has dropped into this channel. */
export function CustomSamples({
  samples,
  onUpload,
  onDelete,
  onPreview,
  onPick,
  onRenameBank,
  onEditSamples,
}: CustomSamplesProps) {
  const [dragOver, setDragOver] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Bank names currently collapsed to just their header — client-side only, so it resets
  // on reload rather than needing to round-trip through the server.
  const [collapsedBanks, setCollapsedBanks] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleBankCollapsed = useCallback((bankName: string) => {
    setCollapsedBanks((prev) => {
      const next = new Set(prev);
      if (next.has(bankName)) next.delete(bankName);
      else next.add(bankName);
      return next;
    });
  }, []);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("audio/")) continue;
        onUpload(file, suggestName(file.name));
      }
    },
    [onUpload],
  );

  const handleDeleteBank = useCallback(
    (slices: CustomSample[]) => {
      for (const s of slices) onDelete(s);
    },
    [onDelete],
  );

  // Group slices by bankName ("the parent dir") so a bank shows as one header + its
  // slices, rather than N unrelated-looking rows repeating the same bank name — the same
  // grouping every strudel-point app now shares (see @strudel-point/library's banks.ts).
  const { banks, singles } = useMemo(() => groupSampleBanks(samples), [samples]);

  return (
    <div>
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
          handleFiles(e.dataTransfer.files);
        }}
      >
        drop audio files here (or click to browse)
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {samples.length === 0 && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>no custom sounds yet</p>
      )}

      {selected.size > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 12 }}>
          <span style={{ color: "var(--muted)" }}>{selected.size} selected</span>
          <button
            onClick={() => {
              onEditSamples(samples.filter((s) => selected.has(s.id)));
              setSelected(new Set());
            }}
            title={
              selected.size === 1
                ? "send to the sample editor below to re-scrub/chop"
                : "merge the selected sounds end-to-end, then send to the sample editor below to chop"
            }
          >
            {selected.size === 1 ? "scrub/chop" : `merge & chop ${selected.size}`}
          </button>
          <button className="secondary" onClick={() => setSelected(new Set())}>
            clear
          </button>
        </div>
      )}

      {banks.map(({ bankName, slices }) => {
        const collapsed = collapsedBanks.has(bankName);
        return (
        <div key={bankName} className="bank-group">
          <BankNameEditor
            bankName={bankName}
            sliceCount={slices.length}
            collapsed={collapsed}
            onToggleCollapsed={() => toggleBankCollapsed(bankName)}
            onRename={(newName) => onRenameBank(bankName, newName)}
            onDeleteBank={() => handleDeleteBank(slices)}
          />
          {!collapsed && slices.map((s) => (
            <div
              key={s.id}
              className="track custom-sample bank-slice"
              onClick={() => onPreview(playableName(s))}
              onDoubleClick={() => onPick(playableName(s))}
              draggable
              onDragStart={(e) =>
                setSoundDragData(e, { name: playableName(s), url: s.url, label: playableName(s) })
              }
            >
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={selected.has(s.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSelected(s.id)}
                  style={{ marginTop: 3 }}
                  title="select for merge/chop"
                />
                <div style={{ flex: 1 }}>
                  <div className="title">{playableName(s)}</div>
                  <div className="meta">
                    {s.fileName} · {(s.sizeBytes / 1024).toFixed(0)}kb
                  </div>
                </div>
              </div>
              <div className="sample-actions">
                <button
                  className="secondary"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditSamples([s]);
                  }}
                  title="scrub & chop this sound into a new bank"
                >
                  chop
                </button>
                <button
                  className="secondary"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(s);
                  }}
                >
                  delete
                </button>
              </div>
            </div>
          ))}
        </div>
        );
      })}

      {singles.map((s) => (
        <div
          key={s.id}
          className="track custom-sample"
          onClick={() => onPreview(playableName(s))}
          onDoubleClick={() => onPick(playableName(s))}
          draggable
          onDragStart={(e) =>
            setSoundDragData(e, { name: playableName(s), url: s.url, label: playableName(s) })
          }
        >
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input
              type="checkbox"
              checked={selected.has(s.id)}
              onClick={(e) => e.stopPropagation()}
              onChange={() => toggleSelected(s.id)}
              style={{ marginTop: 3 }}
              title="select for merge/chop"
            />
            <div style={{ flex: 1 }}>
              <div className="title">{playableName(s)}</div>
              <div className="meta">
                {s.fileName} · {(s.sizeBytes / 1024).toFixed(0)}kb
              </div>
            </div>
          </div>
          <div className="sample-actions">
            <button
              className="secondary"
              onClick={(e) => {
                e.stopPropagation();
                onEditSamples([s]);
              }}
              title="scrub & chop this sound into a new bank"
            >
              chop
            </button>
            <button
              className="secondary"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s);
              }}
            >
              delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
