import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup } from "codemirror";
// This is the real slider(...) widget mechanism strudel.cc itself uses (see App.tsx for
// where the widget configs come from).
import {
  sliderPlugin,
  updateSliderWidgets,
  type SliderWidgetConfig,
} from "@strudel/codemirror/slider.mjs";
import { installKnobDecorations } from "../knobs";

export type { SliderWidgetConfig };

export interface EditorHandle {
  getCode: () => string;
  applyRemoteContent: (content: string) => void;
  /** Inserts text at the current cursor (replacing any selection) and refocuses the editor. */
  insertText: (text: string) => void;
  flash: () => void;
  /** Highlights exactly these character ranges (replacing any previous highlight) — see
   * the "note highlight" driver in App.tsx, which recomputes this every animation frame
   * from whichever mini-notation tokens are currently sounding. */
  setHighlightRanges: (ranges: Array<{ start: number; end: number }>) => void;
  /** Re-renders slider(...) widgets at their current source positions — call after every
   * evaluate (App.tsx extracts these via @strudel/transpiler, independent of playback). */
  updateSliders: (widgets: SliderWidgetConfig[]) => void;
}

interface EditorProps {
  initialContent: string;
  onLocalChange: (content: string) => void;
  onEvaluate: (code: string) => void;
  onHush: () => void;
}

const setActiveRanges = StateEffect.define<Array<{ start: number; end: number }>>();

const activeRangesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setActiveRanges)) {
        const docLength = tr.state.doc.length;
        const marks = effect.value
          .filter((r) => r.start >= 0 && r.start < r.end && r.end <= docLength)
          .sort((a, b) => a.start - b.start)
          .map((r) => Decoration.mark({ class: "cm-strudel-active" }).range(r.start, r.end));
        return Decoration.set(marks);
      }
    }
    // Not a highlight update — just keep decorations aligned with any doc edits since.
    return deco.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Ctrl/Cmd+Enter evaluates, Ctrl/Cmd+. hushes — same defaults as strudel.cc and flok.cc.
export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  { initialContent, onLocalChange, onEvaluate, onHush },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const applyingRemote = useRef(false);

  useImperativeHandle(ref, () => ({
    getCode: () => viewRef.current?.state.doc.toString() ?? "",
    applyRemoteContent: (content) => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === content) return;
      applyingRemote.current = true;
      view.dispatch({ changes: { from: 0, to: current.length, insert: content } });
      applyingRemote.current = false;
    },
    insertText: (text) => {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      // Not a "remote" change, so the updateListener below fires onLocalChange as usual —
      // no need to call it here too.
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      view.focus();
    },
    flash: () => {
      const el = containerRef.current;
      if (!el) return;
      el.classList.add("evaluating");
      setTimeout(() => el.classList.remove("evaluating"), 200);
    },
    setHighlightRanges: (ranges) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ effects: setActiveRanges.of(ranges) });
    },
    updateSliders: (widgets) => {
      const view = viewRef.current;
      if (!view) return;
      updateSliderWidgets(view, widgets);
    },
  }));

  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          // basicSetup already bundles history()/defaultKeymap/historyKeymap — including
          // defaultKeymap's own "Mod-Enter" -> insertBlankLine binding, which would
          // otherwise swallow our evaluate shortcut below before it ever runs. Prec.highest
          // guarantees our bindings are checked first regardless of extension order.
          basicSetup,
          javascript(),
          oneDark,
          activeRangesField,
          sliderPlugin,
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: (v) => {
                  onEvaluate(v.state.doc.toString());
                  return true;
                },
              },
              {
                key: "Mod-.",
                run: () => {
                  onHush();
                  return true;
                },
              },
            ]),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applyingRemote.current) {
              onLocalChange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });

    viewRef.current = view;
    // sliderPlugin renders plain <input type=range> widgets; this overlays the rotating
    // knob visual on top of them (see knobs.ts — purely decorative, doesn't touch the
    // widget's own drag/value-sync logic).
    const uninstallKnobs = installKnobDecorations(view.scrollDOM);
    return () => {
      uninstallKnobs();
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="cm-container" />;
});
