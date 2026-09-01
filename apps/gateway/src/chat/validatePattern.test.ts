import { describe, expect, it } from "vitest";
import { validatePattern } from "./validatePattern.js";

describe("validatePattern", () => {
  it("passes ordinary Strudel", () => {
    expect(
      validatePattern('stack(\n  s("bd hh sd hh").gain(0.9),\n  n("0 2 4").scale("c3:minor"),\n)'),
    ).toEqual({
      unknownCalls: [],
      unknownMethods: [],
      unknownSounds: [],
      suggestions: {},
    });
  });

  it("passes setcpm and samples, which are free calls people actually write", () => {
    expect(validatePattern('setcpm(120/4)\ns("bd*4").bank("RolandTR909")').unknownCalls).toEqual([]);
  });

  // `$: s("bd")` is Strudel's multi-pattern syntax and happens to be a JavaScript labelled
  // statement, so the syntax gate must not reject it.
  it("passes Strudel's $: pattern labels", () => {
    expect(validatePattern('$: s("bd sd")\n$: n("0 3").sound("triangle")').syntaxError).toBeUndefined();
  });

  it("rejects an unbalanced stack the model got halfway through", () => {
    expect(validatePattern('stack(\n  s("bd"),\n').syntaxError).toBeTruthy();
  });

  // Verbatim from mlx-community/Ornith-1.5-9B-OptiQ-4bit, reaching for a looping API Strudel
  // doesn't have. This one doesn't even parse — an object literal can't hold bare call
  // expressions — so the hard gate is what stops it.
  it("rejects the invented-API output that started all this", () => {
    expect(
      validatePattern('loop({\n  s("bd hh sd hh").room(.7),\n  wait(2)\n}, 8)').syntaxError,
    ).toBeTruthy();
  });

  // The same mistake one step luckier: syntactically fine, so only the free-call check sees
  // it. Note `loop` is NOT flagged — it is a real Strudel control (sample looping). Only
  // `wait` is actually absent, and an allowlist that got that wrong is what this check used
  // to be.
  it("flags invented functions that do parse as JavaScript", () => {
    const { syntaxError, unknownCalls } = validatePattern('loop(s("bd hh"), 8)\nwait(2)');
    expect(syntaxError).toBeUndefined();
    expect(unknownCalls).toEqual(["wait"]);
  });

  // The regression that motivated generating the index. `beat` is real —
  // s("bd").beat("0,7,10", 16) — but the hand-written allowlist didn't have it, so the bot
  // was told its correct code was wrong and rewrote it until it ran out of iterations.
  // False positives here are worse than misses: they actively make the output worse.
  it("does not flag real functions that a hand-written allowlist would have missed", () => {
    for (const code of [
      "beat(30, 4)",
      's("bd").beat("0,7,10", 16)',
      's("casio").loop(1)',
      'n("0 2 4").scale("c:major").ribbon(1, 2)',
      's("bd*4").bank("RolandTR909").postgain(0.8)',
      'note("c a f e").chunk(4, fast(2))',
    ]) {
      expect(validatePattern(code)).toEqual({
        unknownCalls: [],
        unknownMethods: [],
        unknownSounds: [],
        suggestions: {},
      });
    }
  });

  it("offers the closest real name when one exists, and stays quiet when none does", () => {
    expect(validatePattern("gian(0.8)").suggestions.gian).toContain("gain");
    expect(validatePattern("setCPM(30)").suggestions.setCPM).toContain("setcpm");
    // Nothing in a 1,000-name index is close to this, and inventing a suggestion would
    // teach the model that the suggestions aren't worth reading.
    expect(validatePattern("wait(2)").suggestions.wait ?? []).not.toContain("gain");
  });

  // The false positive that would matter most: euclid mini-notation puts `bd(3,8)` inside a
  // string, and a scanner that doesn't strip literals calls `bd` an unknown function on some
  // of the most ordinary patterns there are.
  it("does not mistake mini-notation inside a string for a call", () => {
    expect(validatePattern('s("bd(3,8) hh(5,8)")').unknownCalls).toEqual([]);
    expect(validatePattern('s("bd") // sometimes(x => x.fast(2))').unknownCalls).toEqual([]);
    expect(validatePattern('/* stack(nope()) */ s("bd")').unknownCalls).toEqual([]);
  });

  it("does not flag method-chain calls, only free ones", () => {
    // .someNewThingStrudelAdded() must not warn — the chain vocabulary is the long tail.
    expect(validatePattern('s("bd").someNewThingStrudelAdded(2).gain(0.8)').unknownCalls).toEqual([]);
  });

  it("does not flag a helper the source defines for itself", () => {
    expect(validatePattern('const kick = () => s("bd*4")\nstack(kick())').unknownCalls).toEqual([]);
    expect(validatePattern('function kick() { return s("bd") }\nkick()').unknownCalls).toEqual([]);
  });

  it("reports each unknown name once, however often it appears", () => {
    expect(validatePattern("bogus(1)\nbogus(2)\nbogus(3)").unknownCalls).toEqual(["bogus"]);
  });

  it("survives an escaped quote without losing track of where the string ends", () => {
    // The escaped quotes sit in .bank(), not in s() — s()'s argument is checked by the
    // mini-notation parser, which would reject `say "hi"` and short-circuit before the
    // free-call scan this test is actually about.
    expect(validatePattern('s("bd").bank("say \\"hi\\"")\nnope()').unknownCalls).toEqual(["nope"]);
  });
  // Mini-notation is checked with Strudel's own krill parser, so a pass means valid rather
  // than probably-valid. The JavaScript gate cannot see any of this: `s("bd*")` is perfectly
  // good JavaScript that throws the instant the room evaluates it.
  describe("mini-notation", () => {
    it("rejects mini-notation the real parser rejects", () => {
      expect(validatePattern('s("bd*")').miniNotationError).toBeTruthy();
      expect(validatePattern('stack(s("[bd sd"), n("0 2"))').miniNotationError).toBeTruthy();
      expect(validatePattern('n("<0 2")').miniNotationError).toBeTruthy();
    });

    it("passes every mini-notation form people actually write", () => {
      for (const code of [
        's("bd*4")',
        's("~ hh ~ hh")',
        's("[bd sd]*2 <hh oh>")',
        's("bd(3,8)")',
        's("bd@3 sd!2")',
        's("bd*4, hh*8")',
        'n("0 .. 7").scale("c3:minor")',
        's("bd:3 sd:2")',
      ]) {
        expect(validatePattern(code).miniNotationError).toBeUndefined();
      }
    });

    // Only the pattern sources are checked. samples() takes a URL and bank() takes a bank
    // name; neither is mini-notation, and parsing them would reject correct code.
    it("does not treat every string argument as mini-notation", () => {
      expect(
        validatePattern('samples("https://example.com/strudel.json")').miniNotationError,
      ).toBeUndefined();
      expect(validatePattern('s("bd").bank("RolandTR909")').miniNotationError).toBeUndefined();
    });
  });

  // The gap the other two gates leave: a name that is valid JavaScript, valid mini-notation,
  // and resolves to no audio. Silence is the hardest failure to debug from inside a room.
  describe("sound names", () => {
    it("catches the sound name that is really a number", () => {
      // s("4*4") is what a 9B model produced when asked for four-on-the-floor. `4` is a
      // legal mini-notation word and loads nothing.
      expect(validatePattern('s("4*4").note("c1")').unknownSounds).toEqual(["4"]);
    });

    it("does not mistake an operator's operand for a sound name", () => {
      // `bd*4` puts 4 in an operator, not in the pattern — reporting it would be a warning
      // on correct code, which is the failure that made the old allowlist worse than none.
      for (const code of [
        's("bd*4, hh*8")',
        's("bd@3 sd!2")',
        's("bd(3,8)")',
        's("bd:3")',
        's("[bd sd]*2")',
      ]) {
        expect(validatePattern(code).unknownSounds).toEqual([]);
      }
    });

    it("accepts numeric sample names that really exist", () => {
      expect(validatePattern('s("808 909")').unknownSounds).toEqual([]);
    });

    it("accepts the room's own uploads, which no built-in list can know", () => {
      expect(validatePattern('s("mykick*4 bd")', new Set(["mykick"])).unknownSounds).toEqual([]);
      expect(validatePattern('s("mykick")').unknownSounds).toEqual(["mykick"]);
    });

    it("leaves note and degree patterns alone", () => {
      expect(validatePattern('n("0 2 4").scale("c3:minor")').unknownSounds).toEqual([]);
      expect(validatePattern('note("c3 eb3 g3")').unknownSounds).toEqual([]);
    });
  });
  // Verified against Strudel's own transpiler, not assumed:
  //   s("bd*4")\ns("hh*8")     -> s(m('bd*4')); return s(m('hh*8'));
  //   s("bd*4"), s("hh*8")     -> return s(m('bd*4')), s(m('hh*8'));
  // Both compute the first pattern and throw it away. Nothing errors; the room just hears
  // half of what was written, which from inside a room is indistinguishable from the model
  // having written the wrong thing.
  describe("silently dropped patterns", () => {
    it("catches the comma that looks like a stack but isn't", () => {
      // Verbatim from the bot, once its sample names were finally right.
      const code = 's("bd hh").every(2).sound("808"), s("hh*4").every(2)';
      expect(validatePattern(code).droppedPatterns).toMatch(/comma operator/);
    });

    it("catches patterns written as separate top-level statements", () => {
      expect(validatePattern('s("bd*4")\ns("hh*8")').droppedPatterns).toMatch(/only the last one/);
    });

    it("leaves the supported multi-pattern form alone", () => {
      // $: is exactly how Strudel says "play this one too" — the transpiler gives each a
      // .p('$') rather than dropping any.
      expect(validatePattern('$: s("bd*4")\n$: s("hh*8")').droppedPatterns).toBeUndefined();
    });

    it("does not flag calls whose value is meant to be discarded", () => {
      // setcpm and samples have already done their work by the time the value is thrown
      // away, so they are not dropped patterns however many precede the real one.
      expect(validatePattern('setcpm(30)\ns("bd*4")').droppedPatterns).toBeUndefined();
      expect(
        validatePattern('samples("github:a/b")\nsetcpm(30)\nstack(s("bd"))').droppedPatterns,
      ).toBeUndefined();
      expect(validatePattern("hush()").droppedPatterns).toBeUndefined();
    });

    it("does not flag a pattern assigned to a name and used once", () => {
      expect(
        validatePattern('const kick = s("bd*4")\nstack(kick, s("hh*8"))').droppedPatterns,
      ).toBeUndefined();
    });

    it("leaves ordinary single patterns alone", () => {
      for (const code of [
        's("bd*4").room(0.4)',
        'stack(s("bd*4"), s("hh*8"))',
        'n("0 2 4").scale("c3:minor")',
      ]) {
        expect(validatePattern(code).droppedPatterns).toBeUndefined();
      }
    });
  });
  // The gate that catches a runtime throw rather than a parse failure or a silent drop.
  // Strudel's rule lives in register() and is a property of *arity*, not of the signature:
  //   if (arity === 2 && args.length !== 1) { args = [sequence(...args)]; }
  //   else if (arity !== args.length + 1) { throw `.name() expects N inputs` }
  // so arity-2 methods swallow any number of arguments and everything else demands exactly
  // one number of them. Nothing in a parameter list predicts which is which.
  describe("argument counts", () => {
    it("catches the call that is right in every way except how many arguments it got", () => {
      // What the bot wrote once the other four gates were in place.
      expect(validatePattern('s("bd hh*2").every(2)').arityError).toMatch(/exactly 2 arguments and got 1/);
      expect(validatePattern('s("bd").off(1/8)').arityError).toBeTruthy();
    });

    it("accepts the correct forms", () => {
      expect(validatePattern('s("bd hh*2").every(2, (x) => x.fast(2))').arityError).toBeUndefined();
      expect(validatePattern('stack(s("bd"), s("hh")).every(3, rev)').arityError).toBeUndefined();
    });

    // 147 of Strudel's 210 chain methods take any number of arguments, including none, and
    // flagging those would be a warning on correct code — the failure this whole file exists
    // to avoid repeating.
    it("leaves the methods Strudel does not enforce alone", () => {
      // Note `s("bd").fast()` is deliberately absent: it takes any number of arguments *and*
      // silences the pattern at zero, which the next test covers.
      for (const code of [
        's("bd").fast(2, 3)',
        's("bd").room(0.4)',
        's("bd").jux(rev)',
        's("bd").every(2, rev)',
      ]) {
        expect(validatePattern(code).arityError).toBeUndefined();
      }
    });

    it("only looks at chains rooted in a pattern", () => {
      // `filter` is a Strudel name and an Array method. Checking every `.filter(` would
      // reject ordinary JavaScript that happens to appear in a pattern.
      expect(validatePattern("[1, 2].filter((x) => x)").arityError).toBeUndefined();
      expect(validatePattern('const xs = [1].map((x) => x)\ns("bd")').arityError).toBeUndefined();
    });

    it("does not guess when the arguments are spread", () => {
      expect(validatePattern('s("bd").every(...args)').arityError).toBeUndefined();
    });

    // The other half of the same rule, and the quieter half. register() folds a missing
    // argument into sequence(), which is silence, so `s("bd hh").fast()` queries to zero
    // events — Strudel raises nothing and the pattern is simply inaudible. Measured, because
    // `.room()` and `.gain()` with no arguments are perfectly fine and nothing in their
    // signatures says which is which.
    it("catches a zero-argument call that silences the whole pattern", () => {
      expect(validatePattern('s("bd hh").fast()').arityError).toMatch(/silences the whole pattern/);
      expect(validatePattern('s("bd").jux()').arityError).toMatch(/silences the whole pattern/);
    });

    it("leaves the zero-argument calls that are harmless", () => {
      expect(validatePattern('s("bd").room()').arityError).toBeUndefined();
      expect(validatePattern('s("bd").gain()').arityError).toBeUndefined();
    });
  });
  // Reported from a real room: `sound.partial(...)` reached the buffer, and the only trace
  // was a TypeError in the browser console. Free-call scanning deliberately skips anything
  // after a dot, so nothing looked at it.
  //
  // That skip was right while the method list was hand-written — warning about a long tail
  // nobody had enumerated would have flagged `.gain()` constantly. It stopped being right
  // once the index was generated from Pattern.prototype and complete: 960 chain methods.
  describe("chained methods that don't exist", () => {
    it("catches the one that got through", () => {
      expect(validatePattern('sound.partial("bd")').unknownMethods).toEqual(["partial"]);
      expect(validatePattern('s("bd").sound.partial(2)').unknownMethods).toEqual(["partial"]);
    });

    it("offers the near miss", () => {
      expect(validatePattern('sound.partial("bd")').suggestions.partial).toContain("partials");
    });

    // The index was missing 700 of its 960 chain methods until the generator read
    // Pattern.prototype *after* every package had registered onto it — and every one of
    // these would have been a false rejection of correct code.
    it("does not flag the chain vocabulary people actually use", () => {
      for (const code of [
        's("bd*4").gain(0.9).room(0.4).lpf(500)',
        'n("0 2 4").scale("c3:minor").note()',
        's("bd").bank("RolandTR909").postgain(0.8)',
        's("bd").every(3, rev).jux(rev).ply(2)',
        'note("c e g").chord("C").voicing()',
        's("bd").pianoroll()',
      ]) {
        expect(validatePattern(code).unknownMethods).toEqual([]);
      }
    });

    it("leaves JavaScript's own objects alone", () => {
      expect(validatePattern('s("bd").gain(Math.random())').unknownMethods).toEqual([]);
      expect(validatePattern('s("bd").gain(JSON.parse("1"))').unknownMethods).toEqual([]);
      expect(validatePattern('const xs = [1, 2].map((x) => x)\ns("bd")').unknownMethods).toEqual([]);
    });

    it("does not flag a helper the source defines for itself", () => {
      expect(validatePattern('const f = { mine: () => 1 }\ns("bd").gain(f.mine())').unknownMethods).toEqual(
        [],
      );
    });
  });
  // Reported from a room, with the error verbatim: "e is not a function". It comes from
  // inside a minified bundle, so the name means nothing and the line number points at
  // Strudel rather than at the pattern — the least actionable error in the system.
  describe("values where a function belongs", () => {
    it("catches the call that produced `e is not a function`", () => {
      expect(validatePattern('s("sd clubkick").every(16, 3)').arityError).toMatch(
        /needs a function in argument 2/,
      );
      expect(validatePattern('s("bd").off(1/8, 3)').arityError).toBeTruthy();
    });

    // Only literals are certain. An identifier, a call or a member expression can all
    // evaluate to a function, and assuming otherwise rejects the correct forms below.
    it("accepts everything that could actually be a function", () => {
      for (const code of [
        's("sd").every(16, rev)',
        's("sd").every(16, (x) => x.fast(2))',
        's("sd").every(16, fast(2))',
        's("bd").off(1/8, (x) => x.add(7))',
        's("bd").superimpose(rev)',
      ]) {
        expect(validatePattern(code).arityError).toBeUndefined();
      }
    });
  });

  // `kick = s("bd*4")` parses, so the syntax gate accepts it — `new Function` never runs the
  // body, and this only fails when it runs. Strudel evaluates in strict mode (safeEval in
  // evaluate.mjs), so it throws ReferenceError instead of creating a global.
  describe("undeclared assignment", () => {
    it("catches an assignment with no declaration", () => {
      expect(validatePattern('kick = s("bd*4")\nstack(kick)').undeclaredAssignment).toMatch(/strict mode/);
    });

    // Every one of these would have been rejected while the collection pass was silently
    // being stripped from the build — see the note on bindName in validatePattern.ts.
    it("accepts every way of actually declaring something", () => {
      for (const code of [
        'const kick = s("bd*4")\nstack(kick)',
        'let k = s("bd")\nk = s("hh")\nstack(k)',
        'var hats = s("hh").fast(2)\nvar drums = s("sd")\nstack(hats, drums)',
        'const f = (x) => { x = 2; return x }\ns("bd")',
        'function g(y) { y = 1 }\ns("bd")',
        'const { a } = obj\na = 1\ns("bd")',
      ]) {
        expect(validatePattern(code).undeclaredAssignment).toBeUndefined();
      }
    });
  });
  // Reported from a room. The error arrives far from the cause and points somewhere else:
  //   [getTrigger] error: expected hap.value to be an object, but got "Object".
  //   Hint: append .note() or .s() to the end
  // The actual problem is a `+` several lines earlier.
  describe("arithmetic between patterns", () => {
    it("catches the plus that looks like layering", () => {
      const code = 'var bed = s("triangle").gain(.5) + s("sine").gain(.5)\nstack(bed)';
      expect(validatePattern(code).patternArithmetic).toMatch(/not layering/);
    });

    // `patternA + patternB` is JavaScript string concatenation: it produces
    // "[object Object][object Object]", which reify() then treats as a literal value.
    it("names what to use instead", () => {
      const { patternArithmetic } = validatePattern('s("bd") + s("hh")');
      expect(patternArithmetic).toMatch(/stack\(a, b\)/);
      expect(patternArithmetic).toMatch(/\.add\(n\)/);
    });

    it("leaves arithmetic on numbers alone, which is most arithmetic", () => {
      for (const code of [
        'setcpm(120/4)\ns("bd")',
        's("bd").off(1/8, rev)',
        's("bd").gain(0.5 + 0.2)',
        'n("0 2").add(7)',
        'stack(s("triangle").gain(.5), s("sine").gain(.5))',
      ]) {
        expect(validatePattern(code).patternArithmetic).toBeUndefined();
      }
    });
  });
});
