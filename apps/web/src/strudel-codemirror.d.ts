// @strudel/codemirror ships no types. This is strudel.cc's own slider(...) widget
// mechanism — see slider.mjs in the package for the real implementation this wraps.
//
// Imported from the slider.mjs submodule directly, not the package barrel (index.mjs) —
// the barrel re-exports vim/emacs keybindings, autocomplete, and every bundled theme,
// none of which we use; pulling it in nearly tripled the production bundle size
// (measured: 230KB -> 512KB gzipped) for code that never runs. slider.mjs itself only
// imports @strudel/core and @codemirror/view+state, both already dependencies.
declare module "@strudel/codemirror/slider.mjs" {
  import type { Extension } from "@codemirror/state";
  import type { EditorView } from "@codemirror/view";

  export interface SliderWidgetConfig {
    from: number;
    to: number;
    value: string;
    min: number;
    max: number;
    step?: number;
    type: "slider";
  }

  /** CodeMirror extension rendering slider(...) calls as inline <input type=range> widgets. */
  export const sliderPlugin: Extension;

  /** Pushes new widget positions/values into the plugin — call after every evaluate. */
  export function updateSliderWidgets(view: EditorView, widgets: SliderWidgetConfig[]): void;

  /**
   * The runtime half: `slider(value, min, max)` in evaluated code is rewritten by
   * @strudel/transpiler into `sliderWithID(id, value, min, max)` — this is that function.
   * @strudel/web doesn't bundle it (confirmed: absent from its dist bundle), so it has to
   * be exposed as a global manually — see strudel.ts.
   */
  export function sliderWithID(id: string, value: number, min?: number, max?: number): unknown;
}
