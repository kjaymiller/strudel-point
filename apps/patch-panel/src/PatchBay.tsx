import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { compatibleDestinationRoles, isSourceRole, type JackRole, moduleIdOfAddress } from "./modules";

const HIT_RADIUS_PX = 26;

// A fixed, curated palette rather than anything computed from theme colors — cables need
// to read as visually *distinct* from each other above all else, more like a patch bay's
// actual multicolor cable set than a design-system palette. Order doesn't matter; only
// which color a given cable lands on, which cableColor below makes stable.
const CABLE_COLORS = [
  "#f2a33d", // amber
  "#5fd0e0", // cyan
  "#e5578a", // magenta
  "#7ee787", // green
  "#c792ea", // violet
  "#ff8b6b", // coral
  "#6ea8fe", // blue
  "#e0d95f", // yellow-green
];

/** A stable color for a given cable — keyed off the cable itself (its `from->to`
 * string), not its position in any list, so adding/removing/reordering other cables (or
 * the modules they connect) never reshuffles a cable that's already there. Plain djb2
 * string hash; the exact distribution doesn't matter, only that it's deterministic. */
function cableColor(key: string): string {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = (hash * 33 + key.charCodeAt(i)) | 0;
  return CABLE_COLORS[Math.abs(hash) % CABLE_COLORS.length];
}

/** What a registered <Jack> tells the patch bay about itself — its own role decides
 * source vs. destination (see isSourceRole), and its capacity (see modules.ts's
 * jackCapacity, computed by whichever module card owns this jack) caps how many cables
 * it may carry at once. */
interface JackMeta {
  el: HTMLElement;
  role: JackRole;
  capacity: number;
}

interface PatchBayApi {
  connections: Set<string>;
  isConnected: (source: string, destination: string) => boolean;
  /** Whether this exact jack has any cable plugged into it — drives the `.connected` CSS
   * class on <Jack>, regardless of which specific partner(s) it's connected to. */
  isPlugged: (address: string) => boolean;
  registerJack: (address: string, role: JackRole, capacity: number, el: HTMLElement | null) => void;
  beginDrag: (source: string, e: React.PointerEvent) => void;
}

const PatchBayContext = createContext<PatchBayApi | null>(null);

export function usePatchBay(): PatchBayApi {
  const ctx = useContext(PatchBayContext);
  if (!ctx) throw new Error("usePatchBay() must be used inside <PatchBayProvider>");
  return ctx;
}

/** A small round jack, rendered inline inside whichever module card owns that connection
 * point. `address` is a globally-unique "moduleId:jackId" string (see modules.ts's
 * jackAddress) — this is a free-patch rack, not a fixed wiring table, so every jack is
 * just data the patch bay learns about as it mounts, not a member of some closed set.
 * Sources start a drag on pointerdown; destinations are just drop targets (see
 * PatchBayProvider's drag handling). */
export function Jack({
  address,
  role,
  capacity,
  label,
}: {
  address: string;
  role: JackRole;
  /** How many cables this jack may carry at once — always `jackCapacity(kind, role)` for
   * whichever module kind owns this jack (see modules.ts). Required rather than
   * defaulted: a caller that forgets it would otherwise silently get "capped at 1",
   * which is wrong for the handful of jacks that are meant to sum multiple cables (a
   * VCF/VCO's CV inputs, the master Output's audio-in) — better that show up as a
   * missing-prop type error than as a quietly-too-strict patch bay. */
  capacity: number;
  label: string;
}) {
  const { registerJack, beginDrag, isPlugged } = usePatchBay();
  const source = isSourceRole(role);
  return (
    <button
      type="button"
      ref={(el) => registerJack(address, role, capacity, el)}
      className={`jack jack-${source ? "source" : "destination"}${isPlugged(address) ? " plugged" : ""}`}
      title={label}
      aria-label={label}
      onPointerDown={(e) => source && beginDrag(address, e)}
    />
  );
}

interface PatchBayProviderProps {
  children: ReactNode;
  /** Which cables are patched, as `cableKey(from, to)` strings (see cables.ts) —
   * controlled by the caller rather than owned here, so App.tsx's rack state is the one
   * source of truth. */
  connections: Set<string>;
  onConnectionsChange: (next: Set<string>) => void;
}

/**
 * Owns the drag interaction for a free-patch rack: drag from any source jack, drop on any
 * *compatible* (matching signal domain, opposite direction — see compatibleDestinationRoles),
 * *available* (under its capacity — see modules.ts's jackCapacity) destination jack
 * within HIT_RADIUS_PX to connect; anywhere else cancels. Dragging from a source jack
 * *always* starts a new cable, never unplugs one — sources fan out freely now (same mult/
 * splitter idea a real modular rig has), so there's no single "the" existing cable a drag
 * could unambiguously mean to pull. To remove one specific cable, click its rendered line
 * in the overlay instead (see the `onClick` on each `<path>` below) — that works
 * regardless of how many cables share either of its endpoints. Unlike a fixed wiring
 * table, there's no single "the" destination for a given source either — the nearest
 * legal one wins, exactly like reaching for a jack on a real patch bay.
 *
 * Cable/drag-line positions are pushed straight into the DOM via refs on every
 * animationframe rather than through React state — jack positions can shift for reasons
 * that have nothing to do with the connection data itself (window resize, scroll, a knob
 * value changing a label's width), so re-deriving them every frame is simpler than trying
 * to invalidate a cached position on every possible cause, and skipping React re-renders
 * for a 60fps loop is the right call anyway.
 */
export function PatchBayProvider({ children, connections, onConnectionsChange }: PatchBayProviderProps) {
  const jackMetaRef = useRef<Map<string, JackMeta>>(new Map());
  const cablePathsRef = useRef<Map<string, SVGPathElement>>(new Map());
  const dragPathRef = useRef<SVGPathElement>(null);
  const dragStateRef = useRef<{ source: string; x: number; y: number } | null>(null);

  const registerJack = useCallback(
    (address: string, role: JackRole, capacity: number, el: HTMLElement | null) => {
      if (el) jackMetaRef.current.set(address, { el, role, capacity });
      else jackMetaRef.current.delete(address);
    },
    [],
  );

  const cableKeyOf = (from: string, to: string) => `${from}->${to}`;

  const isConnected = useCallback(
    (source: string, destination: string) => connections.has(cableKeyOf(source, destination)),
    [connections],
  );
  const isPlugged = useCallback(
    (address: string) => {
      for (const key of connections) {
        const i = key.indexOf("->");
        if (key.slice(0, i) === address || key.slice(i + 2) === address) return true;
      }
      return false;
    },
    [connections],
  );

  const countCables = useCallback(
    (address: string, asSource: boolean) => {
      let n = 0;
      for (const key of connections) {
        const i = key.indexOf("->");
        if ((asSource ? key.slice(0, i) : key.slice(i + 2)) === address) n++;
      }
      return n;
    },
    [connections],
  );

  const removeCable = useCallback(
    (key: string) => {
      const next = new Set(connections);
      next.delete(key);
      onConnectionsChange(next);
    },
    [connections, onConnectionsChange],
  );

  const jackCenter = useCallback((address: string): { x: number; y: number } | null => {
    const meta = jackMetaRef.current.get(address);
    if (!meta) return null;
    const r = meta.el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, []);

  // A gentle downward sag in the middle, like a real cable — not just a straight line.
  const cablePath = useCallback((a: { x: number; y: number }, b: { x: number; y: number }) => {
    const midX = (a.x + b.x) / 2;
    const sag = 24 + Math.abs(b.x - a.x) * 0.08;
    return `M ${a.x} ${a.y} Q ${midX} ${(a.y + b.y) / 2 + sag} ${b.x} ${b.y}`;
  }, []);

  const beginDrag = useCallback(
    (source: string, e: React.PointerEvent) => {
      const sourceMeta = jackMetaRef.current.get(source);
      if (!sourceMeta) return;
      const wantRoles = compatibleDestinationRoles(sourceMeta.role);
      const sourceModuleId = moduleIdOfAddress(source);

      dragStateRef.current = { source, x: e.clientX, y: e.clientY };

      function onMove(ev: PointerEvent) {
        if (!dragStateRef.current) return;
        dragStateRef.current.x = ev.clientX;
        dragStateRef.current.y = ev.clientY;
      }
      function onUp(ev: PointerEvent) {
        dragStateRef.current = null;
        if (dragPathRef.current) dragPathRef.current.setAttribute("d", "");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);

        // The nearest compatible, available destination jack within range — no fixed
        // "the" destination here, since any number of matching-role jacks may exist.
        let best: { address: string; dist: number } | null = null;
        for (const [address, meta] of jackMetaRef.current) {
          if (!wantRoles.includes(meta.role)) continue;
          if (moduleIdOfAddress(address) === sourceModuleId) continue; // no self-patching
          if (countCables(address, false) >= meta.capacity) continue;
          const r = meta.el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy);
          if (dist <= HIT_RADIUS_PX && (!best || dist < best.dist)) best = { address, dist };
        }
        if (best) onConnectionsChange(new Set(connections).add(cableKeyOf(source, best.address)));
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [connections, onConnectionsChange, countCables],
  );

  // The always-on render loop — draws every connected cable plus the in-progress drag
  // line, straight into the SVG via refs (see the function comment above for why this
  // bypasses React state).
  useEffect(() => {
    let raf: number;
    const tick = () => {
      for (const [key, path] of cablePathsRef.current) {
        if (!connections.has(key)) {
          path.setAttribute("d", "");
          continue;
        }
        const i = key.indexOf("->");
        const a = jackCenter(key.slice(0, i));
        const b = jackCenter(key.slice(i + 2));
        path.setAttribute("d", a && b ? cablePath(a, b) : "");
      }
      const drag = dragStateRef.current;
      if (drag && dragPathRef.current) {
        const a = jackCenter(drag.source);
        if (a) dragPathRef.current.setAttribute("d", cablePath(a, { x: drag.x, y: drag.y }));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [connections, jackCenter, cablePath]);

  const api = useMemo<PatchBayApi>(
    () => ({ connections, isConnected, isPlugged, registerJack, beginDrag }),
    [connections, isConnected, isPlugged, registerJack, beginDrag],
  );

  return (
    <PatchBayContext.Provider value={api}>
      {children}
      <svg className="patchbay-overlay">
        {Array.from(connections).map((key) => (
          <path
            key={key}
            ref={(el) => {
              if (el) cablePathsRef.current.set(key, el);
              else cablePathsRef.current.delete(key);
            }}
            className="cable"
            style={{ "--cable-color": cableColor(key) } as React.CSSProperties}
            onClick={() => removeCable(key)}
          >
            <title>click to unplug this cable</title>
          </path>
        ))}
        <path ref={dragPathRef} className="cable cable-dragging" />
      </svg>
    </PatchBayContext.Provider>
  );
}
