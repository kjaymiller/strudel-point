// A collapsible side drawer wrapping <LibraryTray> — the tray's own content stays a
// pure, embeddable component (see LibraryTray.tsx) so an app that already has a fuller
// bespoke browser (apps/web's SoundBank+CustomSamples, apps/pads' SampleShelf) can still
// import the tray's underlying pieces (dnd.ts, banks.ts) without this chrome; most other
// apps just want it tucked out of the way by default so it doesn't eat into the play
// space, which is what this adds — once, here, rather than every app rigging up its own
// slide-in panel.
//
// Geometry (position, slide transform/transition, width, stacking) is inline since a
// drawer that isn't actually *positioned* isn't a drawer at all; everything about how it
// *looks* (background, border, colors, font) is left to the app's own CSS via the class
// names below — same split LibraryTray itself already uses for its own content.
//
// The toggle and the panel slide together as one rigid unit (the transform lives on the
// outer flex row, not on the panel alone) — closed, that unit is shifted by exactly the
// panel's own width, which tucks the panel off-screen *and* lands the toggle flush
// against the true viewport edge in the same motion, so a closed drawer reserves no
// visible space at all; open, the same transform resolves to zero and the panel sits at
// the edge with the toggle right beside it, still reachable to close again.
import { useState, type CSSProperties } from "react";
import { LibraryTray, type LibraryTrayProps } from "./LibraryTray";

const PANEL_WIDTH = 320;

export interface LibraryDrawerProps extends LibraryTrayProps {
  /** Which edge of the viewport the drawer lives on and slides in from. */
  side?: "left" | "right";
  /** Uncontrolled by default (the drawer owns its own open/closed state, starting
   * closed) — pass both to drive it from outside instead (e.g. a keyboard shortcut
   * elsewhere in the app). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function LibraryDrawer({ side = "right", open: openProp, onOpenChange, ...trayProps }: LibraryDrawerProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };

  const sideStyle: CSSProperties = side === "right" ? { right: 0 } : { left: 0 };
  const hiddenTransform = side === "right" ? `translateX(${PANEL_WIDTH}px)` : `translateX(-${PANEL_WIDTH}px)`;

  return (
    <div
      className={`library-drawer library-drawer-${side}${open ? " open" : ""}`}
      style={{
        position: "fixed",
        top: 0,
        height: "100vh",
        zIndex: 100,
        display: "flex",
        pointerEvents: "none",
        transform: open ? "translateX(0)" : hiddenTransform,
        transition: "transform 200ms ease",
        ...sideStyle,
      }}
    >
      <button
        type="button"
        className="library-drawer-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? "close library" : "open library"}
        title={open ? "close library" : "open library"}
        style={{ pointerEvents: "auto", alignSelf: "flex-start", marginTop: 56, order: side === "right" ? 0 : 1 }}
      >
        {open ? (side === "right" ? "›" : "‹") : side === "right" ? "‹" : "›"} library
      </button>
      <div
        className="library-drawer-panel"
        style={{
          width: PANEL_WIDTH,
          height: "100%",
          overflowY: "auto",
          pointerEvents: "auto",
          order: side === "right" ? 1 : 0,
        }}
      >
        <LibraryTray {...trayProps} />
      </div>
    </div>
  );
}
