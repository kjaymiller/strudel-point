// Per-panel color overrides — a cosmetic, per-browser preference (same "not room-shared
// state" reasoning as presets.ts), so localStorage is enough here too.
const STORAGE_KEY = "strudel-point:patch-panel:panel-colors";

export function loadPanelColors(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function savePanelColor(panelId: string, color: string): void {
  const colors = loadPanelColors();
  colors[panelId] = color;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
}

export function clearPanelColor(panelId: string): void {
  const colors = loadPanelColors();
  delete colors[panelId];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
}
