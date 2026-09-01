import { afterEach, describe, expect, it, vi } from "vitest";
import { insecureContextWarning, isStrudelProblem, STRUDEL_LOG_EVENT } from "./strudel";

afterEach(() => vi.unstubAllGlobals());

// Errors raised while a pattern is *playing* never reach evaluate()'s caller: cyclist
// catches them in its own loop and logs them (cyclist.mjs:79). This DOM event is the only
// channel they travel on, and the app went a long time without listening to it — so
// `sound.partial(...)` reached a room and the only trace was a line in the browser console.
describe("surfacing Strudel's own errors", () => {
  it("listens on the channel Strudel actually dispatches on", () => {
    // logger.key in @strudel/core/logger.mjs. A typo here is silent: no error, no events.
    expect(STRUDEL_LOG_EVENT).toBe("strudel.log");
  });

  it("shows the errors raised while a pattern is playing", () => {
    // What cyclist logs — note it carries no `type`, only the prefix errorLogger adds.
    expect(isStrudelProblem({ message: "[cyclist] error: sound.partial is not a function" })).toBe(true);
    expect(isStrudelProblem({ message: "[getTrigger] error: no sound found" })).toBe(true);
  });

  it("shows anything explicitly typed as a problem", () => {
    expect(isStrudelProblem({ message: "something", type: "error" })).toBe(true);
    expect(isStrudelProblem({ message: "something", type: "warning" })).toBe(true);
  });

  // These carry no `type` and share no wording with each other. A filter written as a list
  // of problem phrases missed three of the four, which is how `[voicing]: unknown chord`
  // silences a pattern with nothing shown anywhere.
  it("shows the problems that arrive with no type and no common wording", () => {
    for (const message of [
      '[voicing]: unknown chord "Zz9"',
      "[core] Modulation type undefined not found. Please use one of 'lfo', 'env', 'bmod'",
      "[warn]: Can't do arithmetic on control pattern.",
      "[cyclist] error: sound.partial is not a function",
    ]) {
      expect(isStrudelProblem({ message })).toBe(true);
    }
  });

  // The other half: a banner that fires on every log is a banner people stop reading, which
  // would put us back where we started.
  it("stays quiet for ordinary progress", () => {
    for (const message of [
      "🌀 @strudel/core loaded 🌀",
      "[cyclist] start",
      "[cyclist] stop",
      "[cyclist] pause",
      "[eval] code updated",
      "[webaudio] preloading",
      "[webaudio] start rendering",
    ]) {
      expect(isStrudelProblem({ message })).toBe(false);
    }
    expect(isStrudelProblem(undefined)).toBe(false);
    expect(isStrudelProblem({ message: "" })).toBe(false);
  });

  it("reads the shape Strudel really dispatches", () => {
    let seen: string | undefined;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string; type?: string }>).detail;
      if (isStrudelProblem(detail)) seen = detail.message;
    };
    document.addEventListener(STRUDEL_LOG_EVENT, handler);
    // Exactly what logger() constructs.
    document.dispatchEvent(
      new CustomEvent(STRUDEL_LOG_EVENT, {
        detail: { message: "[cyclist] error: x.partial is not a function", type: undefined, data: {} },
      }),
    );
    document.removeEventListener(STRUDEL_LOG_EVENT, handler);
    expect(seen).toBe("[cyclist] error: x.partial is not a function");
  });
});

// superdough builds `new AudioWorkletNode(...)`, and AudioWorklet is secure-context-only.
// Over plain HTTP from a LAN or tailnet address the global doesn't exist, and the failure
// names a browser internal rather than the origin — so it reads as a bug in the pattern.
describe("insecure origins", () => {
  // RFC 5737 documentation address — any non-localhost host over plain http.
  const origin = "http://192.0.2.10:8088";

  it("says audio can't work, and why, before anyone presses play", () => {
    vi.stubGlobal("window", { isSecureContext: false, location: { origin } });
    const warning = insecureContextWarning();
    expect(warning).toContain(origin);
    expect(warning).toMatch(/https/);
    // The rest of the app is fine, and saying so stops this reading as "everything is broken".
    expect(warning).toMatch(/chat/i);
  });

  it("stays quiet where audio does work", () => {
    vi.stubGlobal("window", { isSecureContext: true, location: { origin: "https://strudel.example" } });
    expect(insecureContextWarning()).toBeNull();
    // localhost over plain http is a secure context, which is why this never fires in dev.
    vi.stubGlobal("window", { isSecureContext: true, location: { origin: "http://localhost:5173" } });
    expect(insecureContextWarning()).toBeNull();
  });
});
