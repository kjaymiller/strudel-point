// A small, generic CodeMirror 6 view for showing Strudel source with some ranges marked as
// "not understood" — the shared piece behind pads/patch-panel's "load a session" flow (see
// each app's own importPads.ts/importPatch.ts): those parsers turn as much of a loaded
// Track's code as they recognize into that app's own visual model (pad grid / module rack)
// and report whatever they couldn't as character ranges, which this component marks red so
// the code stays fully visible instead of silently vanishing.
//
// Deliberately much smaller than apps/web's own Editor.tsx: no slider(...) widgets, no
// mini-notation playhead highlighting, no eval/hush keymap — this only ever needs to show
// code (read-only, or editable when `onChange` is given) and highlight ranges. Classless of
// any particular visual language, same convention as LibraryTray/LibraryDrawer: the one CSS
// rule this needs (`.cm-strudel-unmatched`'s actual color) is left to whichever app renders
// it, same as apps/web's own `.cm-strudel-active` already is.

import { javascript } from "@codemirror/lang-javascript";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface CodeRange {
  start: number;
  end: number;
}

export interface CodeSessionViewHandle {
  getCode: () => string;
}

export interface CodeSessionViewProps {
  code: string;
  /** Omit for a read-only view — matches Editor.tsx's own "no handler, no editing" absence
   * of a prop rather than a separate `readOnly` flag that could disagree with it. */
  onChange?: (code: string) => void;
  /** Character ranges (into `code`) to mark with the `cm-strudel-unmatched` class — see this
   * file's own doc comment. */
  unmatchedRanges?: CodeRange[];
  className?: string;
}

const setUnmatchedRanges = StateEffect.define<CodeRange[]>();

const unmatchedRangesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setUnmatchedRanges)) {
        const docLength = tr.state.doc.length;
        const marks = effect.value
          .filter((r) => r.start >= 0 && r.start < r.end && r.end <= docLength)
          .sort((a, b) => a.start - b.start)
          .map((r) => Decoration.mark({ class: "cm-strudel-unmatched" }).range(r.start, r.end));
        return Decoration.set(marks);
      }
    }
    // Not a range update — just keep decorations aligned with any doc edits since.
    return deco.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const CodeSessionView = forwardRef<CodeSessionViewHandle, CodeSessionViewProps>(
  function CodeSessionView({ code, onChange, unmatchedRanges, className }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const applyingRemote = useRef(false);

    useImperativeHandle(ref, () => ({ getCode: () => viewRef.current?.state.doc.toString() ?? "" }));

    useEffect(() => {
      if (!containerRef.current) return;
      const view = new EditorView({
        parent: containerRef.current,
        state: EditorState.create({
          doc: code,
          extensions: [
            basicSetup,
            javascript(),
            oneDark,
            unmatchedRangesField,
            EditorView.editable.of(Boolean(onChange)),
            EditorView.updateListener.of((update) => {
              if (update.docChanged && !applyingRemote.current) onChange?.(update.state.doc.toString());
            }),
          ],
        }),
      });
      viewRef.current = view;
      return () => view.destroy();
      // Built once on mount, same as Editor.tsx — `code`/`unmatchedRanges` updates below are
      // pushed into the already-live view rather than tearing it down and losing scroll/
      // selection on every prop change.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onChange, code]);

    // Keeps the doc in sync when `code` changes from outside (a freshly loaded Track) — same
    // "diff against the live doc, replace only if actually different" guard Editor.tsx's own
    // applyRemoteContent uses, so this doesn't fight a user's own typing/cursor/undo history.
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === code) return;
      applyingRemote.current = true;
      view.dispatch({ changes: { from: 0, to: current.length, insert: code } });
      applyingRemote.current = false;
    }, [code]);

    useEffect(() => {
      viewRef.current?.dispatch({ effects: setUnmatchedRanges.of(unmatchedRanges ?? []) });
    }, [unmatchedRanges]);

    return <div ref={containerRef} className={className ?? "code-session-view"} />;
  },
);
