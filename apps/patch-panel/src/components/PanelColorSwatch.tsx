import { useEffect, useRef, useState } from "react";
import { clearPanelColor, loadPanelColors, savePanelColor } from "../panelColors";

interface PanelColorSwatchProps {
  panelId: string;
}

/** A small corner control that tints the *background* of the panel it's dropped into,
 * like picking a different faceplate color for one Eurorack module — click to pick a
 * color (a native <input type="color">), double-click to go back to the default. Doesn't
 * touch knob indicators, toggle-button highlights, or titles — those stay the app's one
 * global accent color regardless, so a "selected" state always reads the same everywhere.
 *
 * Applies the color as a CSS custom property directly on the nearest .panel ancestor via
 * DOM (see styles.css's --panel-accent, mixed into the panel's background gradient),
 * rather than threading color state through every panel component's props — every
 * panel's own markup stays untouched; this just needs to be dropped in next to a title. */
export function PanelColorSwatch({ panelId }: PanelColorSwatchProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [color, setColor] = useState<string | null>(() => loadPanelColors()[panelId] ?? null);

  useEffect(() => {
    const panel = ref.current?.closest<HTMLElement>(".panel");
    if (!panel) return;
    if (color) panel.style.setProperty("--panel-accent", color);
    else panel.style.removeProperty("--panel-accent");
  }, [color]);

  return (
    <input
      ref={ref}
      type="color"
      className="panel-color-swatch"
      value={color ?? "#f2a33d"}
      onChange={(e) => {
        setColor(e.target.value);
        savePanelColor(panelId, e.target.value);
      }}
      onDoubleClick={() => {
        setColor(null);
        clearPanelColor(panelId);
      }}
      title="panel color (double-click to reset)"
    />
  );
}
