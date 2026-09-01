// Exercises the real OpenAI-compatible backend against a live server, with stand-in tools
// that carry the *real* schemas from chat/tools.ts but write to memory instead of Kafka and
// Postgres. Proves the wire handling and that the model actually drives the room tools,
// without needing the rest of the stack up.
//
// A manual smoke test, not part of `bun run test` — it needs a live server and costs a real
// inference. The unit tests (chat/backends/openaiCompatible.test.ts) stub fetch and cover the
// protocol; this covers the thing they can't: whether a given model actually drives these
// tools, with these descriptions, and returns tool calls in the shape the loop expects.
//
// Run: fnox exec -- sh -c 'CHAT_API_KEY=$OMLX_KEY bun scripts/chat-probe.ts "your prompt"'
// Reads CHAT_BASE_URL / CHAT_MODEL from the environment, falling back to the values below.

import { createOpenAiCompatibleBackend } from "../apps/gateway/src/chat/backends/openaiCompatible.js";
import { defineTool } from "../apps/gateway/src/chat/types.js";
import { validatePattern } from "../apps/gateway/src/chat/validatePattern.js";

const BASE_URL = process.env.CHAT_BASE_URL ?? "http://localhost:11434/v1";
const MODEL = process.env.CHAT_MODEL ?? "mlx-community/Ornith-1.5-9B-OptiQ-4bit";

let buffer = 's("bd hh sd hh")';
const called: string[] = [];
const rejections: string[] = [];

const tools = [
  defineTool({
    name: "get_pattern",
    description:
      "Read the Strudel code currently in the room's shared editor. Call this before editing so you " +
      "build on what the room is actually playing rather than replacing it blind.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      called.push("get_pattern");
      return buffer;
    },
  }),
  defineTool<{ code: string; evaluate?: boolean }>({
    name: "set_pattern",
    description:
      "Replace the room's shared editor buffer with new Strudel code, for everyone at once. Send the " +
      "complete pattern, not a fragment or a diff — this overwrites the buffer. Set evaluate=true to " +
      "also start it playing in every browser in the room; leave it false to stage code the humans " +
      "can read and run themselves.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The complete Strudel source for the buffer." },
        evaluate: {
          type: "boolean",
          description: "Whether to play it immediately in every browser in the room. Default false.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    run: async ({ code, evaluate }) => {
      called.push("set_pattern");
      // Same gate as the real tool (chat/tools.ts) — the whole point of this probe is to see
      // what a given model does when its output is rejected, so it has to reject.
      const { syntaxError, unknownCalls } = validatePattern(code);
      if (syntaxError) {
        rejections.push(`syntax: ${syntaxError}`);
        return `Rejected: that isn't valid JavaScript, so it would fail for everyone in the room (${syntaxError}). Nothing was changed — fix it and call set_pattern again.`;
      }
      buffer = code;
      if (unknownCalls.length > 0) {
        rejections.push(`unknown calls: ${unknownCalls.join(", ")}`);
        return `Buffer replaced, but NOT played: ${unknownCalls.join(", ")} ${
          unknownCalls.length === 1 ? "is not a function" : "are not functions"
        } Strudel has, so this would throw on evaluate. Rewrite it using only Strudel's own API and call set_pattern again.`;
      }
      return evaluate
        ? "Buffer replaced and now playing in the room."
        : "Buffer replaced. Nobody has run it yet.";
    },
  }),
  defineTool({
    name: "list_sounds",
    description:
      "List the custom samples uploaded to this room, with the names they play under. Strudel's " +
      "built-in sounds (bd, sd, hh, oh, cp, rim, lt, mt, ht, and the synths sine/square/triangle/" +
      "sawtooth) are always available and are not listed here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      called.push("list_sounds");
      return "This room has no custom samples — built-in sounds only.";
    },
  }),
];

const SYSTEM = `You are strudelbot, a live-coding collaborator in a strudel-point room —
a shared Strudel (strudel.cc) editor that everyone present hears at once.

Room rules that follow from that:
- The editor buffer is shared. Editing it changes what everyone is looking at, and evaluating
  changes what everyone hears. Read the buffer before you rewrite it, and don't replace someone's
  in-progress work on a vague request — offer, or add to it.
- Only evaluate when the request clearly means "play it". Staging code someone can read and run
  is the polite default.
- Multiple people are in the room; each user message is prefixed with who said it.

Writing Strudel:
- Use current Strudel mini-notation: s("bd hh sd hh"), n("0 2 4").scale("c3:minor"), stack(...),
  setcpm(bpm/4), and method chaining like .gain(), .lpf(), .room(), .fast(), .slow(), .every().
- Built-in drum samples: bd sd hh oh cp rim lt mt ht. Built-in synths: sine square triangle sawtooth.
  Anything else must come from list_sounds — never invent a sample name, it will silently not play.
- Keep patterns short and legible. A human is going to edit what you write, live, in front of people.

Replies are shown in a narrow chat panel: a couple of sentences, no code fences unless someone
explicitly asked to see code in chat rather than in the buffer.`;

const prompt = process.argv[2] ?? "add an open hat on the offbeat and put it in the buffer";

const backend = createOpenAiCompatibleBackend({
  baseUrl: BASE_URL,
  apiKey: process.env.CHAT_API_KEY,
  model: MODEL,
});

console.log(`→ ${MODEL} @ ${BASE_URL}`);
console.log(`→ buffer before: ${buffer}`);
console.log(`→ asking: ${prompt}\n`);

const started = Date.now();
const reply = await backend.run({
  system: SYSTEM,
  messages: [{ role: "user", content: `kjay: ${prompt}` }],
  tools,
  maxIterations: 10,
});

console.log(`reply (${((Date.now() - started) / 1000).toFixed(1)}s): ${reply || "(empty)"}`);
console.log(`tools called: ${called.length ? called.join(", ") : "(none)"}`);
console.log(`set_pattern pushback: ${rejections.length ? rejections.join(" | ") : "(none)"}`);
console.log(`buffer after:\n${buffer}`);
