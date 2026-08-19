import { useCallback, useRef } from "react";

// Standard hardware-knob geometry: min sits at -135°, max at +135°, a 270° sweep with a
// dead zone at the bottom — matches the physical knobs this is standing in for.
const START_DEG = -135;
const SWEEP_DEG = 270;
// How many vertical drag pixels cover the knob's whole min..max range. Fixed rather than
// scaled to the knob's own range, so every knob feels equally sensitive to drag by feel,
// not by pixels-per-unit.
const DRAG_RANGE_PX = 150;

interface KnobProps {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  size?: number;
}

/**
 * A drag-to-adjust rotary knob — vertical drag (up increases, down decreases), same feel
 * as a real hardware knob, standing in for a range slider anywhere the mixer's controls
 * are meant to read as knobs rather than faders (everything in Deck.tsx's fx section).
 * Deliberately not an <input type="range"> under the hood — the point was to *not* look
 * or drag like one.
 */
export function Knob({ value, min, max, disabled, onChange, size = 32 }: KnobProps) {
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);

  const frac = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const angle = START_DEG + frac * SWEEP_DEG;

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const deltaY = drag.startY - e.clientY;
      const next = drag.startValue + (deltaY / DRAG_RANGE_PX) * (max - min);
      onChange(Math.min(max, Math.max(min, next)));
    },
    [max, min, onChange],
  );

  const stopDrag = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", stopDrag);
  }, [handlePointerMove]);

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startValue: value };
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopDrag);
    },
    [disabled, value, handlePointerMove, stopDrag],
  );

  return (
    <div
      className={`knob${disabled ? " knob--disabled" : ""}`}
      style={{ width: size, height: size }}
      onPointerDown={startDrag}
    >
      <div className="knob-dial" style={{ transform: `rotate(${angle}deg)` }}>
        <div className="knob-indicator" />
      </div>
    </div>
  );
}
