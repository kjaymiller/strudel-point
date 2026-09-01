// The chatbot's hands. Everything the bot can do to a room is in this file, and every one
// of these tools is scoped to a single channel by the closure below — there is no tool
// that takes a channelId, so a prompt-injected "now edit room `lobby`" has nothing to call.
//
// Written against the provider-neutral shape in types.ts, not against any SDK's: these
// descriptions and schemas are the same work whichever model is reading them, and each
// backend adapts them to its own wire format. Descriptions are load-bearing — a smaller
// local model leans on them harder than Claude does, so they say what a tool *does to the
// room*, not just what it takes.
//
// The bot never writes to a socket. It changes a room the same way a human client does: by
// publishing a ChannelEvent to Kafka, which the consumer loop in index.ts fans back out to
// every connected client on every instance. That means a bot edit and a human edit are
// indistinguishable downstream, and the bot works from any gateway instance regardless of
// which one holds the asking user's socket.

import { BOT_USER_ID, bytesToSequence, type ChannelEvent } from "@strudel-point/shared";
import { readAutosave, writeAutosave } from "../autosaveBuffer.js";
import { pool } from "../db.js";
import { publishChannelEvent } from "../kafka.js";
import { getSampleBytes } from "../storage.js";
import { STRUDEL_VERSIONS } from "./strudelApi.js";
import { type ChatTool, defineTool } from "./types.js";
import { validatePattern } from "./validatePattern.js";

/** The one pane the web client renders. Kept here so a multi-pane future has one place to change. */
const PANE_ID = "main";

/** Cap on what `sonify_bytes` will pull out of object storage and fold into a pattern. */
const MAX_SONIFY_BYTES = 16 * 1024 * 1024;

export interface ChatToolContext {
  channelId: string;
  /** Appended to in call order, so the reply can report what the bot actually touched. */
  toolsUsed: string[];
  /** Strudel functions retrieved into the prompt for this turn (see retrieval.ts). */
  docsRetrieved?: string[];
}

/**
 * Distributes over the ChannelEvent union rather than collapsing it — a plain
 * `Omit<ChannelEvent, ...>` keeps only the keys every member shares, which drops `paneId`
 * and `content` and would let a malformed event through.
 */
type UnstampedEvent<E extends ChannelEvent = ChannelEvent> = E extends ChannelEvent
  ? Omit<E, "userId" | "ts">
  : never;

/** Stamps an event as the bot's and puts it on the topic — the only way the bot touches a room. */
function publish(event: UnstampedEvent) {
  return publishChannelEvent({ ...event, userId: BOT_USER_ID, ts: Date.now() } as ChannelEvent);
}

export function buildChatTools(ctx: ChatToolContext): ChatTool[] {
  const used = (name: string) => ctx.toolsUsed.push(name);

  const getPattern = defineTool({
    name: "get_pattern",
    description:
      "Read the Strudel code currently in the room's shared editor. Call this before editing so you " +
      "build on what the room is actually playing rather than replacing it blind.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      used("get_pattern");
      const doc = await readAutosave(ctx.channelId);
      return doc?.code ? doc.code : "(the editor is empty)";
    },
  });

  const setPattern = defineTool<{ code: string; evaluate?: boolean }>({
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
      used("set_pattern");
      // The room's own uploads count as real sound names — the built-in list can't know them.
      const { rows: customRows } = await pool.query(`select name from custom_samples where channel_id = $1`, [
        ctx.channelId,
      ]);
      const knownSounds = new Set<string>(customRows.map((row) => String(row.name)));
      const {
        syntaxError,
        unknownCalls,
        unknownSounds,
        miniNotationError,
        droppedPatterns,
        arityError,
        undeclaredAssignment,
        patternArithmetic,
        unknownMethods,
        suggestions,
      } = validatePattern(code, knownSounds);

      // Nothing is written. A shared buffer makes a bad write everyone's problem, and a parse
      // failure is certain rather than heuristic — so this is the one hard gate.
      if (syntaxError) {
        return `Rejected: that isn't valid JavaScript, so it would fail for everyone in the room (${syntaxError}). Nothing was changed — fix it and call set_pattern again.`;
      }

      // Second hard gate, and certain for the same reason: this is the parser the browser
      // runs. `s("bd*")` is fine JavaScript and throws the moment anyone evaluates it.
      if (miniNotationError) {
        return `Rejected: the mini-notation inside the quotes doesn't parse — ${miniNotationError}. Nothing was changed. Check it against the mini-notation table you were given and call set_pattern again.`;
      }

      // Third hard gate. Unlike the first two this code *runs* — it just throws half of
      // itself away, so the room hears one part of the pattern and no error at all.
      if (droppedPatterns) {
        return `Rejected: ${droppedPatterns}. Nothing was changed — this one is worth reading twice, because it would not have errored, it would just have been quietly missing half the pattern. Fix it and call set_pattern again.`;
      }

      // `a + b` between patterns is string concatenation, and the failure surfaces much
      // later as "expected hap.value to be an object".
      if (patternArithmetic) {
        return `Rejected: ${patternArithmetic}. Nothing was changed — fix it and call set_pattern again.`;
      }

      // Strudel evaluates in strict mode, so this is a ReferenceError rather than a global.
      if (undeclaredAssignment) {
        return `Rejected: ${undeclaredAssignment}. Nothing was changed — fix it and call set_pattern again.`;
      }

      // Fourth hard gate: Strudel raises this itself, on evaluate, in front of the room.
      if (arityError) {
        return `Rejected: ${arityError}, so Strudel would throw the moment anyone ran it. Nothing was changed — the reference above shows what each function takes. Fix it and call set_pattern again.`;
      }

      // Same order the web client uses on evaluate: persist first, then tell the room. A
      // client that reloads mid-turn should never come back to a buffer older than what it
      // just saw arrive over the socket.
      await writeAutosave(ctx.channelId, code, { code, version: 1 });
      await publish({ type: "doc:update", channelId: ctx.channelId, paneId: PANE_ID, content: code });

      // Invented API: the code lands so the humans can see and fix it, but it is deliberately
      // not *played*, however clearly the request asked for playback. Writing anyway costs
      // someone a keystroke; evaluating a pattern that throws is what the whole room notices.
      //
      // The message names the nearest real functions rather than just refusing, because a
      // bare "that's wrong" leaves the model nothing to do but guess again — which is
      // precisely how a turn burns ten iterations and answers nobody.
      // Silence is the hardest failure to debug from inside a room — nothing throws, nothing
      // logs, the pattern just doesn't make a sound and nobody can hear why. Soft, because
      // the room's uploads are only as complete as the query above.
      if (unknownSounds.length > 0) {
        return (
          `Buffer replaced, but NOT played: ${unknownSounds.join(", ")} ` +
          `${unknownSounds.length === 1 ? "is not a sound name" : "are not sound names"} that resolves here, ` +
          "so it would load no audio and play silence — the failure nobody in the room can hear the cause " +
          "of. Use a name from the sample list you were given, or list_sounds for this room's own uploads, " +
          "then call set_pattern again."
        );
      }

      // `sound.partial("bd")` is valid JavaScript, valid mini-notation, one pattern, and a
      // TypeError the moment it runs — it reached a room before this check existed.
      if (unknownMethods.length > 0) {
        const detail = unknownMethods
          .map((name) => {
            const close = suggestions[name];
            return close?.length
              ? `.${name}() (did you mean ${close.map((c) => `.${c}()`).join(", ")}?)`
              : `.${name}()`;
          })
          .join("; ");
        return (
          `Buffer replaced, but NOT played: Strudel has no ${detail}, so this would throw for everyone in ` +
          "the room the moment it ran. Use a method from the reference above and call set_pattern again."
        );
      }

      if (unknownCalls.length > 0) {
        const detail = unknownCalls
          .map((name) => {
            const close = suggestions[name];
            return close?.length ? `${name} (did you mean ${close.join(", ")}?)` : name;
          })
          .join("; ");
        return (
          `Buffer replaced, but NOT played. Strudel ${Object.values(STRUDEL_VERSIONS)[0] ?? ""} has no ` +
          `${unknownCalls.length === 1 ? "function" : "functions"} ${detail}, so this would throw for ` +
          "everyone in the room. Use only what the reference above lists or what the buffer " +
          "already uses, and call set_pattern again — don't guess a third time."
        );
      }

      if (evaluate) {
        await publish({ type: "eval", channelId: ctx.channelId, paneId: PANE_ID, code });
      }
      return evaluate
        ? "Buffer replaced and now playing in the room."
        : "Buffer replaced. Nobody has run it yet.";
    },
  });

  const hush = defineTool({
    name: "hush",
    description: "Stop all sound in every browser in the room. The buffer is left untouched.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      used("hush");
      await publish({ type: "hush", channelId: ctx.channelId, paneId: PANE_ID });
      return "Everyone's playback stopped.";
    },
  });

  const listSounds = defineTool({
    name: "list_sounds",
    description:
      "List the custom samples uploaded to this room, with the names they play under. Bank slices are " +
      'played as bankName:index (e.g. s("mybreak:3")); everything else plays under its own name. ' +
      "Strudel's built-in sounds (bd, sd, hh, oh, cp, rim, lt, mt, ht, and the synths sine/square/" +
      "triangle/sawtooth) are always available and are not listed here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      used("list_sounds");
      const { rows } = await pool.query(
        `select id, name, bank_name, bank_index, size_bytes from custom_samples
         where channel_id = $1 order by created_at desc limit 200`,
        [ctx.channelId],
      );
      if (rows.length === 0) return "This room has no custom samples — built-in sounds only.";
      return JSON.stringify(
        rows.map((row) => ({
          sampleId: row.id,
          playsAs: row.bank_name ? `${row.bank_name}:${row.bank_index}` : row.name,
          bank: row.bank_name ?? undefined,
          sizeBytes: row.size_bytes,
        })),
      );
    },
  });

  const listTracks = defineTool({
    name: "list_tracks",
    description: "List the tracks saved in this room. Use load_track to read one's code.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      used("list_tracks");
      const { rows } = await pool.query(
        `select id, title, author, created_at from tracks where channel_id = $1
         order by created_at desc limit 50`,
        [ctx.channelId],
      );
      if (rows.length === 0) return "No saved tracks in this room yet.";
      return JSON.stringify(
        rows.map((row) => ({
          trackId: row.id,
          title: row.title,
          author: row.author ?? "anonymous",
          savedAt: row.created_at,
        })),
      );
    },
  });

  const loadTrack = defineTool<{ trackId: string }>({
    name: "load_track",
    description:
      "Read a saved track's Strudel code by id. This only reads it — call set_pattern if the room " +
      "should actually switch to it.",
    inputSchema: {
      type: "object",
      properties: { trackId: { type: "string", description: "An id from list_tracks." } },
      required: ["trackId"],
      additionalProperties: false,
    },
    run: async ({ trackId }) => {
      used("load_track");
      // Scoped by channel as well as id: the bot must not be able to read another room's
      // work just because someone pasted an id into chat.
      const { rows } = await pool.query(`select code from tracks where id = $1 and channel_id = $2`, [
        trackId,
        ctx.channelId,
      ]);
      if (rows.length === 0) return "No track with that id in this room.";
      return rows[0].code;
    },
  });

  const sonifyBytes = defineTool<{ sampleId: string; steps?: number; range?: number; rest?: number }>({
    name: "sonify_bytes",
    description:
      "Turn the raw bytes of an uploaded sample into a Strudel number sequence — a deterministic " +
      "reading of the file itself, not an analysis of how it sounds. Returns bare numbers and rests, " +
      'like n("3 5 ~ 2 4 ~ 1 1"), so you can point it at any instrument: add .scale(), .sound(), ' +
      ".note(), whatever fits what the room is already playing. Call set_pattern if it should land in " +
      "the buffer. The same mapping runs in the browser when someone drops a file onto the chat panel, " +
      "so if a human just did that, this is the sequence they got.",
    inputSchema: {
      type: "object",
      properties: {
        sampleId: { type: "string", description: "A sampleId from list_sounds." },
        steps: {
          type: "integer",
          description: "Fix the sequence length, 1-64. Omit to let the bytes choose it (8-32).",
        },
        range: {
          type: "integer",
          description: "Numbers run 0..range-1. Default 8 — an octave of scale degrees.",
        },
        rest: {
          type: "number",
          description: "Share of steps that come out as rests, 0-1. Default 0.25. 0 means no rests.",
        },
      },
      required: ["sampleId"],
      additionalProperties: false,
    },
    run: async ({ sampleId, steps, range, rest }) => {
      used("sonify_bytes");
      const { rows } = await pool.query(
        `select name, size_bytes from custom_samples where id = $1 and channel_id = $2`,
        [sampleId, ctx.channelId],
      );
      if (rows.length === 0) return "No sample with that id in this room.";
      if (rows[0].size_bytes > MAX_SONIFY_BYTES) {
        return `That sample is ${rows[0].size_bytes} bytes, past the ${MAX_SONIFY_BYTES}-byte sonification limit.`;
      }
      const bytes = await getSampleBytes(sampleId);
      if (!bytes) return "That sample's audio has expired out of object storage.";
      return bytesToSequence(new Uint8Array(bytes), { steps, range, rest, label: rows[0].name }).code;
    },
  });

  return [getPattern, setPattern, hush, listSounds, listTracks, loadTrack, sonifyBytes];
}
