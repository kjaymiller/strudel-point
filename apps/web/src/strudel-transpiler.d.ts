// @strudel/transpiler ships no types. We only use this directly to extract slider(...)
// widget positions from source text — same AST walk @strudel/web uses internally for
// actual evaluation, just called standalone so the editor can render widgets even before
// (or regardless of) the pattern itself evaluating cleanly.
declare module "@strudel/transpiler" {
  import type { SliderWidgetConfig } from "@strudel/codemirror/slider.mjs";

  /** Not just sliders — other widget methods (registerWidgetType) share this array too,
   * distinguished only by `type` at runtime; narrow to SliderWidgetConfig by checking it. */
  export type WidgetConfig = { type: string } & Partial<SliderWidgetConfig>;

  export interface TranspileResult {
    output: string;
    miniLocations: Array<{ start: number; end: number }>;
    widgets: WidgetConfig[];
  }

  export function transpiler(
    input: string,
    options?: {
      wrapAsync?: boolean;
      addReturn?: boolean;
      emitMiniLocations?: boolean;
      emitWidgets?: boolean;
    },
  ): TranspileResult;
}
