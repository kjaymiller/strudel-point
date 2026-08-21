import { useState } from "react";
import type { Preset } from "../presets";

interface PresetBarProps {
  presets: Preset[];
  activeName: string | null;
  onLoad: (preset: Preset) => void;
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
}

export function PresetBar({ presets, activeName, onLoad, onSave, onDelete }: PresetBarProps) {
  const [nameInput, setNameInput] = useState("");

  return (
    <div className="preset-bar">
      <select
        value={activeName ?? ""}
        onChange={(e) => {
          const preset = presets.find((p) => p.name === e.target.value);
          if (preset) onLoad(preset);
        }}
      >
        <option value="" disabled>
          load preset…
        </option>
        {presets.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
      <input
        type="text"
        placeholder="preset name"
        value={nameInput}
        onChange={(e) => setNameInput(e.target.value)}
      />
      <button
        className="secondary"
        onClick={() => {
          const name = nameInput.trim();
          if (!name) return;
          onSave(name);
          setNameInput("");
        }}
      >
        save preset
      </button>
      <button className="secondary" disabled={!activeName} onClick={() => activeName && onDelete(activeName)}>
        delete
      </button>
    </div>
  );
}
