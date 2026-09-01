// A sanity check on Strudel source before the bot drops it into a room's shared buffer.
//
// Two different failures, deliberately treated differently, because a shared buffer makes a
// bad write everyone's problem rather than the asker's:
//
//   1. It isn't valid JavaScript. Certain, so it's rejected outright and the model is told
//      why — nothing lands in the room.
//   2. It calls a function Strudel doesn't have. The code lands, the model is warned with
//      the nearest real names, and playback is withheld.
//
// The second check used to run off a hand-written allowlist, and that was a mistake worth
// recording: the list omitted real functions (`beat`, `loop`, and hundreds more), so the
// bot got told its *correct* code was wrong, rewrote it into something worse, and looped
// until it ran out of iterations. A check that cries wolf is worse than no check.
//
// It now runs off strudelApi.json, generated from the installed @strudel packages by
// scripts/build-strudel-api.ts — 1,000+ names, so an unknown name really is unknown.
//
// Claude gets the same treatment; the check is about the code, not who wrote it.

import * as acorn from "acorn";
import * as krill from "@strudel/mini/krill-parser.js";
import {
  FREE_NAMES,
  FUNCTION_ARGS,
  METHOD_NAMES,
  REQUIRED_ARGS,
  SILENT_WITH_NO_ARGS,
  suggest,
} from "./strudelApi.js";
import { SAMPLES } from "./vocabulary.js";

/** Statement keywords that are followed by `(` and are not calls. */
const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "typeof",
  "new",
  "function",
  "await",
  "yield",
  "do",
  "else",
  "delete",
  "void",
  "in",
  "of",
  "instanceof",
  "throw",
  "super",
]);

/**
 * Blanks out string and template contents and drops comments.
 *
 * Non-negotiable before scanning for call syntax: Strudel's euclid mini-notation puts
 * `bd(3,8)` *inside a string*, so a scanner that doesn't strip literals reports `bd` as an
 * unknown function on some of the most ordinary patterns there are.
 */
function stripLiterals(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const char = code[i];
    const next = code[i + 1];

    if (char === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i++;
      while (i < code.length && code[i] !== quote) {
        // Skip the escaped character too, so \" doesn't look like the closing quote.
        i += code[i] === "\\" ? 2 : 1;
      }
      i++;
      // Keep a placeholder so `s("bd")` still reads as a call to `s`.
      out += '""';
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/** Names the source defines for itself — a helper someone wrote is not an unknown function. */
function locallyDefined(code: string): Set<string> {
  const names = new Set<string>();
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  return names;
}

export interface PatternCheck {
  /** Set when the code isn't valid JavaScript. The caller must not write it anywhere. */
  syntaxError?: string;
  /** Free calls that aren't anywhere in the Strudel API, in source order, deduped. */
  unknownCalls: string[];
  /** Chained calls — `.name(...)` — that Strudel has no such method for. */
  unknownMethods: string[];
  /** Mini-notation that Strudel's own parser rejects. Like syntaxError, this is certain. */
  miniNotationError?: string;
  /** Sound names in s(...) that resolve to no audio. Soft: the room may have its own. */
  unknownSounds: string[];
  /** Patterns written so that Strudel evaluates and then discards them. Certain. */
  droppedPatterns?: string;
  /** A chained method called with the wrong number of arguments. Throws on evaluate. */
  arityError?: string;
  /** Assignment to a name that was never declared. Throws on evaluate — Strudel is strict. */
  undeclaredAssignment?: string;
  /** `patternA + patternB`, which JavaScript turns into a string. Certain. */
  patternArithmetic?: string;
  /** For each unknown name, the closest real ones — so a warning names the way out. */
  suggestions: Record<string, string[]>;
}

/**
 * Functions whose first string argument is mini-notation.
 *
 * Deliberately a short list of the pattern *sources* rather than everything that takes a
 * string: `samples("https://…")` and `.bank("RolandTR909")` also take strings, and a URL is
 * not mini-notation. Checking only where the answer is unambiguous keeps this a hard gate
 * without it ever being wrong — the same reason the syntax check is `new Function` and not
 * a guess about what Strudel accepts.
 */
const MINI_NOTATION_SOURCES = new Set(["s", "sound", "n", "note", "freq"]);

/**
 * Runs Strudel's own krill parser over the mini-notation inside the pattern sources.
 *
 * The JavaScript syntax gate can't see any of this: `s("bd*")` and `s("[bd sd")` are
 * perfectly good JavaScript containing a string, and they throw only when the room
 * evaluates them. This is the same parser the browser will use, so a pass here means the
 * mini-notation is genuinely valid rather than probably valid.
 */
function checkMiniNotation(code: string): string | undefined {
  // name("...") or name('...'), taking the first string argument only.
  const calls = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(\s*(["'])((?:\\.|(?!\2).)*)\2/g;
  for (const match of code.matchAll(calls)) {
    const [, name, , literal] = match;
    if (!MINI_NOTATION_SOURCES.has(name)) continue;
    try {
      // krill's input grammar includes the quotes.
      (krill as { parse(input: string): unknown }).parse(JSON.stringify(literal));
    } catch (err) {
      const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
      return `${name}("${literal}") — ${detail}`;
    }
  }
  return undefined;
}

/**
 * Free calls that do something rather than *be* a pattern. Discarding their value is
 * harmless — `setcpm(30)` has already taken effect by the time its result is thrown away —
 * so they must not count as a dropped pattern.
 */
const CONTROL_CALLS = new Set([
  "setcpm",
  "setcps",
  "setCpm",
  "setCps",
  "samples",
  "hush",
  "all",
  "register",
  "aliasBank",
  "initStrudel",
]);

/** The name a member chain is rooted at: `s("bd").fast(2).room(.3)` -> `s`. */
function rootCallee(node: acorn.Expression): string | undefined {
  let current: acorn.Expression = node;
  for (;;) {
    if (current.type === "CallExpression") current = current.callee as acorn.Expression;
    else if (current.type === "MemberExpression") current = current.object as acorn.Expression;
    else if (current.type === "Identifier") return current.name;
    else return undefined;
  }
}

function isPatternExpression(node: acorn.Expression): boolean {
  const root = rootCallee(node);
  return root !== undefined && FREE_NAMES.has(root) && !CONTROL_CALLS.has(root);
}

/**
 * JavaScript arithmetic between patterns.
 *
 * `s("triangle").gain(.5) + s("sine").gain(.5)` looks like layering and is neither. `+` is
 * the JavaScript operator: it stringifies both patterns and produces
 * `"[object Object][object Object]"`. stack() then reifies that string as a literal value,
 * and the failure surfaces much later and somewhere else entirely:
 *
 *   [getTrigger] error: expected hap.value to be an object, but got "Object".
 *   Hint: append .note() or .s() to the end
 *
 * — a hint that points at the wrong thing, in a message that never mentions the `+`.
 *
 * Layering is stack(a, b); arithmetic on a pattern's values is .add(n).
 */
function checkPatternArithmetic(program: acorn.Program, code: string): string | undefined {
  let found: string | undefined;

  const visit = (node: acorn.AnyNode | null | undefined) => {
    if (found || !node || typeof node !== "object") return;
    if (node.type === "BinaryExpression" && ["+", "-", "*", "/", "%"].includes(node.operator)) {
      const left = node.left as acorn.Expression;
      const right = node.right as acorn.Expression;
      // Only when a side is genuinely a pattern. `setcpm(120/4)` and `.off(1/8, f)` are
      // arithmetic on numbers and must stay legal.
      if (isPatternExpression(left) || isPatternExpression(right)) {
        const written = code.slice(node.start, node.end).replace(/\s+/g, " ");
        found =
          `\`${written.length > 60 ? `${written.slice(0, 60)}...` : written}\` uses JavaScript's ` +
          `\`${node.operator}\` on a pattern. That is not layering: it converts both sides to text and ` +
          'produces "[object Object][object Object]", which fails later as "expected hap.value to be ' +
          'an object". Use stack(a, b) to play patterns together, or .add(n) for arithmetic on values';
        return;
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) visit(item as acorn.AnyNode);
      else if (value && typeof value === "object" && "type" in value) visit(value as acorn.AnyNode);
    }
  };
  visit(program as unknown as acorn.AnyNode);
  return found;
}

/**
 * Assignment to a name nothing declares.
 *
 * `kick = s("bd*4")` is valid JavaScript, and the syntax gate accepts it for a structural
 * reason: `new Function` only *parses*: the body never runs, and an undeclared assignment
 * fails at run time rather than at parse time. Strudel evaluates in strict mode
 * (`"use strict";return (...)` — safeEval in evaluate.mjs), where it throws
 * `ReferenceError: kick is not defined` instead of quietly creating a global.
 *
 * Certain, so it's a hard gate. Every declaration form counts, and reassigning something
 * already declared is legal and not flagged.
 */
function checkUndeclaredAssignments(program: acorn.Program): string | undefined {
  const declared = new Set<string>();
  let found: string | undefined;

  // NOT named `declare`: that is a TypeScript contextual keyword, and a statement beginning
  // with it is parsed as an ambient declaration and *stripped by the transpiler*. Every
  // `declare(node.id)` call silently vanished at build time, leaving this set empty and the
  // check rejecting every correct `const`/`let`/`var` in the language. No error anywhere —
  // it typechecks, it builds, the calls are simply not in the output.
  const bindName = (node: acorn.Pattern | null | undefined) => {
    if (!node) return;
    if (node.type === "Identifier") declared.add(node.name);
    else if (node.type === "ObjectPattern") {
      for (const property of node.properties) {
        bindName(property.type === "Property" ? (property.value as acorn.Pattern) : property.argument);
      }
    } else if (node.type === "ArrayPattern") {
      for (const element of node.elements) bindName(element);
    } else if (node.type === "AssignmentPattern") bindName(node.left);
    else if (node.type === "RestElement") bindName(node.argument);
  };

  // Declarations are collected in a separate pass first, because JavaScript hoists: a
  // pattern may legitimately assign on a line above the `let` that declares the name.
  const collect = (node: acorn.AnyNode | null | undefined) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "VariableDeclarator") bindName(node.id);
    else if (node.type === "FunctionDeclaration" && node.id) declared.add(node.id.name);
    if ("params" in node && Array.isArray(node.params)) {
      for (const param of node.params) bindName(param as acorn.Pattern);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) collect(item as acorn.AnyNode);
      else if (value && typeof value === "object" && "type" in value) collect(value as acorn.AnyNode);
    }
  };
  collect(program as unknown as acorn.AnyNode);

  const visit = (node: acorn.AnyNode | null | undefined) => {
    if (found || !node || typeof node !== "object") return;
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
      const name = node.left.name;
      // A Strudel or JS global is a real binding, so assigning to it is legal (if unwise).
      // This check is about names that exist nowhere at all.
      if (!declared.has(name) && !FREE_NAMES.has(name) && !METHOD_NAMES.has(name)) {
        found =
          `\`${name} = ...\` assigns to a name nothing declares. Strudel evaluates in strict mode, ` +
          `so this throws "ReferenceError: ${name} is not defined" rather than creating a variable — ` +
          `write \`const ${name} = ...\``;
        return;
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) visit(item as acorn.AnyNode);
      else if (value && typeof value === "object" && "type" in value) visit(value as acorn.AnyNode);
    }
  };
  visit(program as unknown as acorn.AnyNode);
  return found;
}

/**
 * Standard-library objects whose members are JavaScript, not Strudel. `Math.random()` inside
 * a pattern is ordinary and must never be reported as a missing Strudel method.
 */
const JS_GLOBAL_OBJECTS = new Set(["Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Date"]);

/**
 * Chained calls to methods Strudel does not have.
 *
 * This check did not exist until `sound.partial("bd")` reached a room: it is valid
 * JavaScript, valid mini-notation, one pattern, and a TypeError the moment it runs. Nothing
 * caught it, because free-call scanning deliberately skips anything preceded by a dot.
 *
 * That skip was correct when the only list available was hand-written — warning about a
 * long tail of chain methods nobody had enumerated would have flagged `.gain()` constantly.
 * It stopped being correct once the index was generated from Pattern.prototype and actually
 * complete: 960 chain methods, and `partial` is not one of them.
 *
 * Soft, not hard. The prototype is a snapshot of the packages the generator imports, and
 * the browser's REPL can register more, so an unknown method is strong evidence rather than
 * proof — the code lands and playback is withheld.
 */
function checkMethods(program: acorn.Program, defined: ReadonlySet<string>): string[] {
  const unknown = new Set<string>();

  const visit = (node: acorn.AnyNode | null | undefined) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
      const callee = node.callee;
      const object = callee.object as acorn.Expression;
      const isJsGlobal = object.type === "Identifier" && JS_GLOBAL_OBJECTS.has(object.name);
      if (!callee.computed && callee.property.type === "Identifier" && !isJsGlobal) {
        const name = callee.property.name;
        if (
          !METHOD_NAMES.has(name) &&
          !FREE_NAMES.has(name) &&
          !defined.has(name) &&
          isPatternExpression(object)
        ) {
          unknown.add(name);
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) visit(item as acorn.AnyNode);
      else if (value && typeof value === "object" && "type" in value) visit(value as acorn.AnyNode);
    }
  };

  visit(program as unknown as acorn.AnyNode);
  return [...unknown];
}

/**
 * Chained calls with the wrong number of arguments.
 *
 * `s("bd hh*2").every(2)` is a real function, correct mini-notation, correct sample names
 * and a single pattern — every other gate passes it — and it throws the instant anyone
 * evaluates: `.every() expects 2 inputs but got 1.` It is what this bot wrote once the
 * other four gates were in place.
 *
 * Only methods whose requirement Strudel actually enforces are checked (63 of them; the
 * other 147 accept any number of arguments), and only on chains rooted at a pattern
 * function — so `[1, 2].filter(f)` is never mistaken for Strudel's `filter`.
 */
function checkArity(program: acorn.Program, code: string): string | undefined {
  let found: string | undefined;

  const visit = (node: acorn.AnyNode | null | undefined) => {
    if (found || !node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
      const callee = node.callee;
      const property = callee.property;
      if (!callee.computed && property.type === "Identifier") {
        const required = REQUIRED_ARGS.get(property.name);
        const spread = node.arguments.some((argument) => argument.type === "SpreadElement");
        const onPattern = isPatternExpression(callee.object as acorn.Expression);
        const written = () => code.slice(callee.object.end, node.end).replace(/\s+/g, " ");

        if (required !== undefined && !spread && node.arguments.length !== required && onPattern) {
          found =
            `\`${written()}\` — .${property.name}() takes exactly ${required} ` +
            `${required === 1 ? "argument" : "arguments"} and got ${node.arguments.length}`;
          return;
        }

        // A value where a pattern *transform* belongs. `.every(16, 3)` throws
        // `e is not a function. (In 'e(n)', 'e' is 3)` — a minified name and a line number
        // inside Strudel, which is about as much help as an error can decline to be.
        const functionPositions = FUNCTION_ARGS.get(property.name);
        if (functionPositions && onPattern) {
          for (const position of functionPositions) {
            const argument = node.arguments[position];
            // Only literals are certain. An identifier, a call or a member expression could
            // all evaluate to a function, and assuming otherwise would reject `every(4, rev)`.
            const isLiteral =
              argument &&
              (argument.type === "Literal" ||
                argument.type === "TemplateLiteral" ||
                argument.type === "ArrayExpression" ||
                argument.type === "ObjectExpression");
            if (isLiteral) {
              found =
                `\`${written()}\` — .${property.name}() needs a function in argument ` +
                `${position + 1} (something like rev, or x => x.fast(2)), not a value. Strudel calls it, ` +
                'so this throws "is not a function" the moment it runs';
              return;
            }
          }
        }

        // Strudel permits a zero-argument call here and folds it into sequence(), which is
        // silence — so the whole pattern queries to nothing. No error, no sound, and from
        // inside a room no way to see why.
        if (node.arguments.length === 0 && SILENT_WITH_NO_ARGS.has(property.name) && onPattern) {
          found =
            `\`${written()}\` — .${property.name}() with no arguments silences the whole pattern ` +
            "(Strudel folds the missing argument into silence rather than raising an error)";
          return;
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) visit(item as acorn.AnyNode);
      else if (value && typeof value === "object" && "type" in value) visit(value as acorn.AnyNode);
    }
  };

  visit(program as unknown as acorn.AnyNode);
  return found;
}

/**
 * Patterns that Strudel will evaluate and then throw away.
 *
 * Two forms, both verified against Strudel's own transpiler rather than assumed:
 *
 *   s("bd*4")           ->  s(m('bd*4')); return s(m('hh*8'));
 *   s("hh*8")
 *
 *   s("bd*4"), s("hh*8") ->  return s(m('bd*4')), s(m('hh*8'));
 *
 * In both, only the last pattern survives — the rest are computed and discarded. Nothing
 * throws, nothing logs; half the pattern is simply inaudible, which from inside a room is
 * indistinguishable from having written it wrong. `$:` labels are the supported way to
 * play several at once and are left alone:
 *
 *   $: s("bd*4")        ->  s(m('bd*4')).p('$'); return s(m('hh*8')).p('$');
 *   $: s("hh*8")
 */
function checkDroppedPatterns(code: string): string | undefined {
  let program: acorn.Program;
  try {
    program = acorn.parse(code, { ecmaVersion: "latest" });
  } catch {
    return undefined; // The syntax gate already rejected this and said so.
  }

  const unlabelled: string[] = [];
  for (const statement of program.body) {
    // `$: s("bd")` is a labelled statement, which is how Strudel says "play this too".
    if (statement.type === "LabeledStatement") continue;
    if (statement.type !== "ExpressionStatement") continue;

    const expression = statement.expression;
    if (expression.type === "SequenceExpression") {
      const dropped = expression.expressions.slice(0, -1).filter(isPatternExpression);
      if (dropped.length > 0) {
        return (
          `the comma in \`a, b\` is JavaScript's comma operator, not a way to layer patterns — ` +
          `${dropped.length === 1 ? "the pattern" : `${dropped.length} patterns`} before the last one ` +
          "would be evaluated and thrown away, and only the final one would make a sound. Use " +
          "stack(a, b) to play them together, or put each on its own line with a $: label"
        );
      }
    } else if (isPatternExpression(expression)) {
      unlabelled.push(rootCallee(expression) ?? "?");
    }
  }

  if (unlabelled.length > 1) {
    return (
      `${unlabelled.length} patterns are written as separate top-level statements ` +
      `(${unlabelled.join(", ")}), and Strudel keeps only the last one — the others are ` +
      "evaluated and discarded, silently. Wrap them in stack(...), or prefix each line with " +
      "$: which is how Strudel plays several at once"
    );
  }
  return undefined;
}

const BUILT_IN_SOUNDS = new Set(SAMPLES);

/**
 * Sound names used in `s(...)` that will load no audio.
 *
 * This is the check that catches `s("4*4")` — the one failure the other two gates let
 * through, because `4` is valid mini-notation and valid JavaScript, and simply resolves to
 * nothing. A pattern that plays silence is the worst outcome to debug from inside a room:
 * nobody can hear the reason.
 *
 * Soft, and only ever soft, for one reason: a room can upload its own samples, so the
 * built-in list is necessarily incomplete. `knownSounds` carries the channel's custom names
 * (see tools.ts), and anything still unrecognised is reported as a warning rather than a
 * refusal.
 */
function checkSounds(code: string, knownSounds: ReadonlySet<string>): string[] {
  const unknown = new Set<string>();
  const calls = /(?:^|[^.\w$])(s|sound)\s*\(\s*(["'])((?:\\.|(?!\2).)*)\2/g;

  for (const match of code.matchAll(calls)) {
    let ast: unknown;
    try {
      ast = (krill as { parse(input: string): unknown }).parse(JSON.stringify(match[3]));
    } catch {
      return []; // Already reported by checkMiniNotation; don't say it twice.
    }
    for (const name of soundAtoms(ast)) {
      if (name === "~" || name === "-") continue;
      if (BUILT_IN_SOUNDS.has(name) || knownSounds.has(name)) continue;
      unknown.add(name);
    }
  }
  return [...unknown];
}

/**
 * The atoms that name a sound, from a parsed mini-notation tree.
 *
 * Walks `source_` only, never `options_` or `arguments_`. That distinction is the whole
 * point: in `bd*4` the parser puts `bd` in source_ and the `4` in an operator's arguments,
 * so a scan that treats every token alike reports the multiplier as a missing sample —
 * which is a warning on correct code, the failure mode that made the old allowlist worse
 * than nothing.
 */
function soundAtoms(node: unknown): string[] {
  if (node === null || typeof node !== "object") return [];
  const record = node as { type_?: string; source_?: unknown };
  if (record.type_ === "atom") {
    return typeof record.source_ === "string" ? [record.source_.split(":")[0]] : [];
  }
  const source = record.source_;
  if (Array.isArray(source)) return source.flatMap(soundAtoms);
  return soundAtoms(source);
}

export function validatePattern(code: string, knownSounds: ReadonlySet<string> = new Set()): PatternCheck {
  // Parses without running. `new Function` is enough here: Strudel source *is* JavaScript
  // (mini-notation lives inside ordinary strings, and `$: s("bd")` is a labelled statement),
  // so anything that fails to parse here would have failed in every browser in the room.
  try {
    new Function(code);
  } catch (err) {
    return {
      syntaxError: err instanceof Error ? err.message : String(err),
      unknownCalls: [],
      unknownMethods: [],
      unknownSounds: [],
      suggestions: {},
    };
  }

  // Second hard gate, and certain for the same reason as the first: this is the parser the
  // browser runs, so anything it rejects would have thrown for everyone in the room.
  const miniNotationError = checkMiniNotation(code);
  if (miniNotationError)
    return { miniNotationError, unknownCalls: [], unknownMethods: [], unknownSounds: [], suggestions: {} };

  // Third hard gate. Also certain, and verified against Strudel's own transpiler: these
  // forms compute a pattern and discard it, so the failure is silence rather than an error.
  const droppedPatterns = checkDroppedPatterns(code);
  if (droppedPatterns)
    return { droppedPatterns, unknownCalls: [], unknownMethods: [], unknownSounds: [], suggestions: {} };

  // Fourth hard gate. Certain in the same way: Strudel raises this itself, on evaluate, in
  // front of the whole room.
  let parsed: acorn.Program | undefined;
  try {
    parsed = acorn.parse(code, { ecmaVersion: "latest" });
  } catch {
    parsed = undefined;
  }
  const arityError = parsed ? checkArity(parsed, code) : undefined;
  if (arityError)
    return { arityError, unknownCalls: [], unknownMethods: [], unknownSounds: [], suggestions: {} };

  // Fifth hard gate, and invisible to `new Function` for a structural reason: that parses
  // the body without running it, and this one only fails when it runs.
  const patternArithmetic = parsed ? checkPatternArithmetic(parsed, code) : undefined;
  if (patternArithmetic) {
    return { patternArithmetic, unknownCalls: [], unknownMethods: [], unknownSounds: [], suggestions: {} };
  }

  const undeclaredAssignment = parsed ? checkUndeclaredAssignments(parsed) : undefined;
  if (undeclaredAssignment) {
    return { undeclaredAssignment, unknownCalls: [], unknownMethods: [], unknownSounds: [], suggestions: {} };
  }

  const stripped = stripLiterals(code);
  const defined = locallyDefined(stripped);
  const unknown = new Set<string>();

  // `name(` not preceded by a dot — i.e. a free call rather than a method in a chain.
  for (const match of stripped.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[2];
    if (KEYWORDS.has(name) || FREE_NAMES.has(name) || defined.has(name)) continue;
    unknown.add(name);
  }

  const unknownCalls = [...unknown];
  const unknownMethods = parsed ? checkMethods(parsed, defined) : [];
  const suggestions: Record<string, string[]> = {};
  for (const name of [...unknownCalls, ...unknownMethods]) {
    const close = suggest(name);
    if (close.length > 0) suggestions[name] = close;
  }
  return { unknownCalls, unknownMethods, unknownSounds: checkSounds(code, knownSounds), suggestions };
}
