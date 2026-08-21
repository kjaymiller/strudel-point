import { PanelColorSwatch } from "./PanelColorSwatch";

interface ModuleHeaderProps {
  kindLabel: string;
  name: string;
  onNameChange: (name: string) => void;
  colorId: string;
  onRemove?: () => void;
}

/** The header every module card shares: a drag handle (see App.tsx's moveModule — reorder
 * only ever touches the modules array's display order, never the cables list, so nothing
 * gets unplugged by rearranging the rack), an editable instance name (so "VCF 1" vs "VCF
 * 2" stay distinguishable once you've got more than one of a kind), the module *kind* as
 * a small fixed label next to it, a color swatch (same per-module faceplate tint every
 * other panel here has), and a remove button — omitted for the one module that's a
 * singleton and can't be removed (the master Output, see App.tsx).
 *
 * `colorId` doubles as the drag payload — every caller already passes `module.id` for it
 * (see PanelColorSwatch's own per-module tint), so no extra prop is needed just to know
 * which module is being dragged. */
export function ModuleHeader({ kindLabel, name, onNameChange, colorId, onRemove }: ModuleHeaderProps) {
  return (
    <div className="module-header">
      <span
        className="module-drag-handle"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", colorId);
          e.dataTransfer.effectAllowed = "move";
        }}
        title="drag to reorder this module in the rack"
        aria-label="drag to reorder"
      >
        ⠿
      </span>
      <input
        className="module-name-input"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        aria-label="module name"
        title="rename this module"
      />
      <span className="module-kind-label">{kindLabel}</span>
      <PanelColorSwatch panelId={colorId} />
      {onRemove && (
        <button
          type="button"
          className="secondary module-remove"
          onClick={onRemove}
          title="remove this module"
        >
          ×
        </button>
      )}
    </div>
  );
}
