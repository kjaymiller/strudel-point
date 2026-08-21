import { useCallback, useRef } from "react";

// A real rotary knob — drag vertically to turn it, same convention as every hardware
// synth and every DAW plugin knob (dragging in a circle is neat in theory but far less
// precise/discoverable than "up = more, down = less"). Arrow keys nudge by one `step` for
// keyboard/accessibility access. Sweeps -135deg..+135deg, the standard analog-knob range.
const SWEEP_DEG = 270;
const DRAG_PX_PER_SWEEP = 160; // dragging this many px covers the full min..max range

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
  /** How many decimal places to show in the readout — defaults based on step size. */
  precision?: number;
}

export function Knob({ label, value, min, max, step = 0.01, unit = "", onChange, precision }: KnobProps) {
  const places = precision ?? (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);

  const clampAndQuantize = useCallback(
    (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step)),
    [min, max, step],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startY: e.clientY, startValue: value };
    },
    [value],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      const dy = dragRef.current.startY - e.clientY; // dragging up = increase
      const delta = (dy / DRAG_PX_PER_SWEEP) * (max - min);
      onChange(clampAndQuantize(dragRef.current.startValue + delta));
    },
    [max, min, onChange, clampAndQuantize],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
        e.preventDefault();
        onChange(clampAndQuantize(value + step));
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
        e.preventDefault();
        onChange(clampAndQuantize(value - step));
      }
    },
    [value, step, onChange, clampAndQuantize],
  );

  const pct = (value - min) / (max - min);
  const angle = -SWEEP_DEG / 2 + pct * SWEEP_DEG;

  return (
    <div className="knob">
      <span className="knob-label">{label}</span>
      <div
        className="knob-dial"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className="knob-indicator" style={{ transform: `rotate(${angle}deg)` }} />
      </div>
      <span className="knob-value">
        {value.toFixed(places)}
        {unit}
      </span>
    </div>
  );
}
