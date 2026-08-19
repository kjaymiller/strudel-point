// Turns @strudel/codemirror's slider widgets into rotary knobs. The value commit path —
// programmatically set input.value, then dispatch a real "input" event — is deliberately
// the *only* way values change here, because @strudel/codemirror's SliderWidget already
// has its own native "input" listener wired up (writes the new value into the code text,
// posts the message that updates the live-playing pattern's value). Dispatching through
// that listener means we never have to re-derive that sync logic ourselves — we just have
// to drive the input's value via whatever gesture we want.
//
// That gesture is custom, not the native horizontal thumb-drag: the widget's own native
// range track is only ~16px wide (this being an inline decoration, not a toolbar), so
// dragging it directly means a couple pixels of mouse movement sweeps the entire
// min..max range — there's no way to land on a precise value. Vertical drag decouples
// "how far you drag" from "how wide the widget is" — the sensitivity constants below set
// how many pixels of vertical drag correspond to the full range, independent of the 16px
// visual. That also means it can't fight the native horizontal-drag behavior: a vertical
// gesture doesn't trigger the browser's own thumb-slide at all.

const MIN_ANGLE = -135;
const MAX_ANGLE = 135;

// Drag this many px (vertically) to sweep the whole min..max range. Hold Shift for
// FINE_MULTIPLIER times that — i.e. the same drag distance now covers a much smaller
// slice of the range, for precise adjustment near a specific value.
const DRAG_PX_FOR_FULL_RANGE = 150;
const FINE_MULTIPLIER = 8;

// One un-shifted wheel tick moves by one `step`; shift+wheel moves by WHEEL_FAST_STEPS
// steps at once, for covering a lot of range quickly without switching to drag.
const WHEEL_FAST_STEPS = 10;

function stepOf(input: HTMLInputElement): number {
  const step = Number(input.step);
  return step > 0 ? step : (Number(input.max) - Number(input.min)) / 1000;
}

function clampToStep(input: HTMLInputElement, value: number): number {
  const min = Number(input.min);
  const max = Number(input.max);
  const step = stepOf(input);
  const stepped = Math.round((value - min) / step) * step + min;
  return Math.min(max, Math.max(min, stepped));
}

function commit(input: HTMLInputElement, value: number) {
  input.value = String(clampToStep(input, value));
  // Not a user-generated event as far as the browser's concerned, so `bubbles: true` is
  // what makes SliderWidget's own listener (attached on this exact element) see it.
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function angleFor(input: HTMLInputElement): number {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 1;
  const value = Number(input.value);
  const t = max > min ? (value - min) / (max - min) : 0;
  return MIN_ANGLE + t * (MAX_ANGLE - MIN_ANGLE);
}

function attachDrag(input: HTMLInputElement) {
  let startY = 0;
  let startValue = 0;

  const onPointerMove = (e: PointerEvent) => {
    const min = Number(input.min);
    const max = Number(input.max);
    const sensitivity = e.shiftKey ? DRAG_PX_FOR_FULL_RANGE * FINE_MULTIPLIER : DRAG_PX_FOR_FULL_RANGE;
    const deltaY = startY - e.clientY; // dragging up increases the value
    commit(input, startValue + (deltaY / sensitivity) * (max - min));
  };

  const onPointerUp = (e: PointerEvent) => {
    input.releasePointerCapture(e.pointerId);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };

  input.addEventListener("pointerdown", (e) => {
    // Suppresses the native horizontal thumb-drag starting on the same gesture — without
    // this, a diagonal flick could trigger both paths and fight over the value.
    e.preventDefault();
    input.focus(); // preventDefault can suppress default focus-on-click too; keep it
    startY = e.clientY;
    startValue = Number(input.value);
    input.setPointerCapture(e.pointerId);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  });

  input.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const steps = e.shiftKey ? WHEEL_FAST_STEPS : 1;
      const dir = e.deltaY < 0 ? 1 : -1; // scroll up = increase, matching a physical knob
      commit(input, Number(input.value) + dir * steps * stepOf(input));
    },
    { passive: false },
  );

  // Exact value entry — the ultimate in "granular", for when even fine-drag isn't
  // precise enough. prompt() is blocking and ugly, but it's one line instead of a whole
  // floating text-input component for something used rarely.
  input.addEventListener("dblclick", () => {
    const next = window.prompt(`value (${input.min}-${input.max}):`, input.value);
    if (next === null) return;
    const parsed = Number(next);
    if (!Number.isNaN(parsed)) commit(input, parsed);
  });

  // Keyboard (arrow keys/PageUp/PageDown/Home/End) is the native range input's own
  // built-in behavior — untouched, still works once the input has focus (see above).
}

function decorate(wrap: HTMLElement) {
  const input = wrap.querySelector("input[type=range]") as HTMLInputElement | null;
  if (!input || wrap.querySelector(".cm-knob-face")) return; // already decorated

  wrap.classList.add("cm-knob");
  const face = document.createElement("span");
  face.className = "cm-knob-face";
  wrap.prepend(face);

  const updateFace = () => {
    face.style.transform = `rotate(${angleFor(input)}deg)`;
  };
  updateFace();
  input.addEventListener("input", updateFace);

  attachDrag(input);
}

/**
 * Watches `container` (the CodeMirror scroll DOM) for slider widgets as they're created
 * — @strudel/codemirror re-renders a fresh DOM node per widget on every evaluate (its
 * SliderWidget.eq() always returns false), so this has to keep watching, not just run
 * once on mount. Returns a cleanup function.
 */
export function installKnobDecorations(container: HTMLElement): () => void {
  // Catch anything already present (e.g. widgets restored on remote doc sync before this
  // observer attached) in addition to whatever the observer catches going forward.
  container.querySelectorAll<HTMLElement>(".cm-slider").forEach(decorate);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches(".cm-slider")) decorate(node);
        node.querySelectorAll?.(".cm-slider").forEach((el) => decorate(el as HTMLElement));
      });
    }
  });
  observer.observe(container, { childList: true, subtree: true });
  return () => observer.disconnect();
}
