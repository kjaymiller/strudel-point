import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { hueForBank } from "../color";

export interface ShelfBank {
  bankName: string;
  /** e.g. ["kicks:0", "kicks:1", ...] — already ordered by bankIndex. */
  slices: string[];
}

interface SampleShelfProps {
  banks: ShelfBank[];
  /** Click previews the slice in place — same superdough-direct trigger the pad grid uses,
   * so it doesn't touch (or restart) whatever pattern (if any) is playing in the room. */
  onPreview: (ref: string) => void;
  /** Press-and-hold a bank's name to audition it: plays through its slices one after
   * another for as long as it's held. Start/stop rather than a single call, since the
   * sequence itself takes real time and needs to be interruptible on release. */
  onPreviewBankStart: (bankName: string) => void;
  onPreviewBankStop: () => void;
}

function matchesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query);
}

/**
 * Every bank slice in this room, as small draggable chips — the drag source for PadGrid.
 * The only place a single slice (a specific cycle out of a bank) is browsable and
 * grabbable on its own, rather than as a whole bank.
 *
 * Every bank starts collapsed to just its header — same ▸/▾ chevron convention
 * apps/web/src/components/CustomSamples.tsx uses for its own bank groups, useful here for
 * the same reason: once a room has a few banks of several slices each, the shelf gets long
 * fast, and defaulting to collapsed is what actually makes the search box below worth
 * having (searching a shelf that's already all expanded wouldn't save you much). Kept as
 * the chevron alone (not the whole header row, like CustomSamples does) since the bank
 * name here is already both a drag source and a press-and-hold preview trigger — making
 * the whole row a third, competing click target would fight those. A search match expands
 * its bank regardless of the stored collapsed state, so results are never hidden behind a
 * chevron you'd have to click separately.
 */
export function SampleShelf({ banks, onPreview, onPreviewBankStart, onPreviewBankStop }: SampleShelfProps) {
  // Seeded from whatever banks exist on first render, and every bank not already known
  // gets added (collapsed) as it shows up later too — see the effect-free "seen so far"
  // merge below, so a freshly uploaded/dragged-in bank still starts collapsed rather than
  // this Set simply not knowing about it (and thus rendering it expanded by omission).
  const [collapsedBanks, setCollapsedBanks] = useState<Set<string>>(() => new Set(banks.map((b) => b.bankName)));
  useEffect(() => {
    setCollapsedBanks((prev) => {
      const unseen = banks.filter((b) => !prev.has(b.bankName));
      if (unseen.length === 0) return prev;
      const next = new Set(prev);
      for (const b of unseen) next.add(b.bankName);
      return next;
    });
  }, [banks]);

  const [query, setQuery] = useState("");

  const toggleBankCollapsed = useCallback((bankName: string) => {
    setCollapsedBanks((prev) => {
      const next = new Set(prev);
      if (next.has(bankName)) next.delete(bankName);
      else next.add(bankName);
      return next;
    });
  }, []);

  // Search matches by bank name too — a bank-name hit shows all of its slices (you're
  // clearly looking for that whole bank), while a slice-only hit narrows down to just the
  // slices that matched, so a big bank doesn't drown out the handful you actually searched
  // for.
  const trimmedQuery = query.trim().toLowerCase();
  const visibleBanks = useMemo(() => {
    if (!trimmedQuery) return banks.map((b) => ({ bank: b, slices: b.slices, forceExpanded: false }));
    return banks
      .map((b) => {
        const bankMatches = matchesQuery(b.bankName, trimmedQuery);
        const slices = bankMatches ? b.slices : b.slices.filter((ref) => matchesQuery(ref, trimmedQuery));
        return { bank: b, slices, forceExpanded: true };
      })
      .filter(({ slices }) => slices.length > 0);
  }, [banks, trimmedQuery]);

  if (banks.length === 0) {
    return (
      <p className="hint" style={{ margin: "0 0 16px" }}>
        no sound banks in this room yet — drop a loop above to cut one, then drag its
        slices onto the pads below.
      </p>
    );
  }

  return (
    <div className="sample-shelf-wrap">
      <input
        type="search"
        className="sample-shelf-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search banks & slices…"
      />
      {trimmedQuery && visibleBanks.length === 0 && (
        <p className="hint" style={{ margin: "0 0 16px" }}>
          nothing in this room's sound banks matches "{query.trim()}".
        </p>
      )}
      <div className="sample-shelf">
        {visibleBanks.map(({ bank: b, slices, forceExpanded }) => {
          const collapsed = !forceExpanded && collapsedBanks.has(b.bankName);
          return (
            <div
              key={b.bankName}
              className="sample-shelf-bank"
              style={{ "--bank-hue": hueForBank(b.bankName) } as CSSProperties}
            >
              <div className="bank-header">
                <span
                  className="bank-collapse-arrow"
                  onClick={() => toggleBankCollapsed(b.bankName)}
                  title={collapsed ? "expand" : "collapse"}
                >
                  {collapsed ? "▸" : "▾"}
                </span>
                <button
                  className="sample-shelf-bank-name"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", b.bankName)}
                  onPointerDown={() => onPreviewBankStart(b.bankName)}
                  onPointerUp={onPreviewBankStop}
                  onPointerLeave={onPreviewBankStop}
                  title={`${b.bankName} — drag onto the pad grid to load all ${b.slices.length} slice${b.slices.length === 1 ? "" : "s"} at once, or press & hold to preview in sequence`}
                >
                  {b.bankName}
                  {collapsed ? ` (${b.slices.length})` : ""}
                </button>
              </div>
              {!collapsed && (
                <div className="sample-shelf-chips">
                  {slices.map((ref) => (
                    <button
                      key={ref}
                      className="sample-chip"
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData("text/plain", ref)}
                      onClick={() => onPreview(ref)}
                      title={`${ref} · drag onto a pad, or click to preview`}
                    >
                      {ref}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
