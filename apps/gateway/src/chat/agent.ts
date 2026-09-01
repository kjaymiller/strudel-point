// One turn of the in-room chatbot: take what someone typed, let a model use the room tools
// in tools.ts until it's done, and hand back the reply for the route to broadcast.
//
// Which model that is, is config (see resolveBackend). Claude via the official Anthropic SDK
// is the default and the one the prompt below is tuned for; CHAT_PROVIDER=openai-compatible
// points the same tools at anything speaking chat-completions — a local Ollama, vLLM,
// LM Studio, OpenRouter, OpenAI. The seam is in types.ts; everything above it is shared.
//
// Stateless by construction. Nothing about a conversation is kept here between calls — the
// client sends the transcript it can already see (every browser in the room receives every
// chat:message event, so they all hold the same one), which is what lets any gateway
// instance serve any turn, exactly like every other request this service handles.

import { CHAT_HISTORY_LIMIT, type ChatStatus, type ChatTurn } from "@strudel-point/shared";
import { readAutosave } from "../autosaveBuffer.js";
import { env } from "../env.js";
import { createAnthropicBackend } from "./backends/anthropic.js";
import { createOpenAiCompatibleBackend } from "./backends/openaiCompatible.js";
import { retrieveDocs } from "./retrieval.js";
import { vocabularyBlock } from "./vocabulary.js";
import { buildChatTools, type ChatToolContext } from "./tools.js";
import type { ChatBackend, ChatMessage } from "./types.js";

/**
 * A bounded loop matters more here than in a CLI agent: a turn holds an HTTP request open
 * and every iteration is a paid call, so a bot that talks itself into a tool loop would
 * spend real money against a hung browser tab. Ten is far more than any of these tools
 * need — read the buffer, look at the sounds, write it back.
 */
const MAX_ITERATIONS = 10;

/** Only meaningful for the Anthropic backend; the other provider has no model we can guess. */
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

const SYSTEM_PROMPT = `You are strudelbot, a live-coding collaborator in a strudel-point room —
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
  and method chaining like .gain(), .lpf(), .room(), .fast(), .slow(), .every().
- Strudel's own documentation for this request is included below, selected for what was asked
  and for what the buffer already uses. It is the real API — prefer it over recollection.
  Anything you cannot name from it or from the buffer is a guess, and a guess that parses will
  throw for everyone in the room. Say you're not sure rather than inventing a function.
- setcpm sets CYCLES per minute, not beats. One cycle is a bar, so for N bpm in 4/4 write
  setcpm(N/4): 120bpm is setcpm(30). HALVING the tempo means a SMALLER number, doubling a larger
  one. Getting this backwards is the single most common mistake here.
- Built-in drum samples: bd sd hh oh cp rim lt mt ht. Built-in synths: sine square triangle sawtooth.
  Anything else must come from list_sounds — never invent a sample name, it will silently not play.
- Keep patterns short and legible. A human is going to edit what you write, live, in front of people.

Replies are shown in a narrow chat panel: a couple of sentences, no code fences unless someone
explicitly asked to see code in chat rather than in the buffer.`;

type BackendResolution = { backend: ChatBackend } | { backend: null; model: string; reason: string };

/**
 * Turns env into either a working backend or the reason there isn't one.
 *
 * Returning the reason rather than throwing is what lets GET /api/chat/status explain itself
 * ("CHAT_PROVIDER=openai-compatible needs CHAT_BASE_URL") instead of the panel discovering
 * the misconfiguration on someone's first message. Running with no bot at all is a supported
 * state, so "not configured" must never read like a crash.
 */
function resolveBackend(): BackendResolution {
  if (env.chatProvider === "openai-compatible") {
    if (!env.chatBaseUrl) {
      return {
        backend: null,
        model: env.chatModel ?? "",
        reason: "CHAT_PROVIDER=openai-compatible needs CHAT_BASE_URL (e.g. http://ollama:11434/v1)",
      };
    }
    if (!env.chatModel) {
      // No default is possible here: the model names depend entirely on what's loaded into
      // whichever server CHAT_BASE_URL points at.
      return {
        backend: null,
        model: "",
        reason: "CHAT_PROVIDER=openai-compatible needs CHAT_MODEL (e.g. llama3.1 or gpt-4o)",
      };
    }
    return {
      backend: createOpenAiCompatibleBackend({
        baseUrl: env.chatBaseUrl,
        apiKey: env.chatApiKey,
        model: env.chatModel,
        disableThinking: env.chatDisableThinking,
      }),
    };
  }

  const model = env.chatModel ?? DEFAULT_ANTHROPIC_MODEL;
  if (!env.anthropicApiKey) {
    return { backend: null, model, reason: "the gateway has no ANTHROPIC_API_KEY" };
  }
  return { backend: createAnthropicBackend({ apiKey: env.anthropicApiKey, model }) };
}

/** What GET /api/chat/status reports — see the route for why the UI needs it up front. */
export function chatStatus(): ChatStatus {
  const resolved = resolveBackend();
  return resolved.backend
    ? { enabled: true, provider: env.chatProvider, model: resolved.backend.model }
    : { enabled: false, provider: env.chatProvider, model: resolved.model, reason: resolved.reason };
}

export function chatEnabled(): boolean {
  return resolveBackend().backend !== null;
}

export interface ChatTurnInput {
  channelId: string;
  username: string;
  message: string;
  history: ChatTurn[];
}

export interface ChatTurnResult {
  reply: string;
  toolsUsed: string[];
}

/**
 * Names are part of the content, not a separate field either wire format has: the model has
 * to be able to tell "make it faster" from user A apart from user B's earlier request, and a
 * room where everyone's messages arrive anonymous reads as one confused person.
 */
function renderTurn(turn: ChatTurn): ChatMessage {
  if (turn.role === "assistant") return { role: "assistant", content: turn.content };
  return { role: "user", content: turn.username ? `${turn.username}: ${turn.content}` : turn.content };
}

export async function runChatTurn({
  channelId,
  username,
  message,
  history,
}: ChatTurnInput): Promise<ChatTurnResult> {
  const resolved = resolveBackend();
  if (!resolved.backend) throw new Error(`the chatbot is not configured — ${resolved.reason}`);

  const ctx: ChatToolContext = { channelId, toolsUsed: [] };
  const messages: ChatMessage[] = [
    // Trimmed here as well as client-side: `history` is whatever a browser posted, so the
    // limit has to hold on the side that pays for the tokens.
    ...history.slice(-CHAT_HISTORY_LIMIT).map(renderTurn),
    renderTurn({ role: "user", content: message, username }),
  ];

  // Retrieval, not a tool call. The documentation is a local index — every question the
  // model would have asked it costs a round trip against MAX_ITERATIONS, and a turn that
  // spends six iterations looking things up has none left to answer with. Scoring the whole
  // index against the request takes a few milliseconds and costs no iterations at all.
  //
  // The room's current buffer is part of the query: what is already playing determines
  // which functions matter, and a "make it faster" that arrives without the docs for what
  // the pattern already uses is how an edit turns into an accidental rewrite.
  const current = await readAutosave(channelId).catch(() => null);
  const { context, names } = retrieveDocs({
    query: [...history.slice(-3).map((turn) => turn.content), message].join("\n"),
    code: current?.code ?? "",
  });
  ctx.docsRetrieved = names;

  // Mini-notation and sample names, which are a grammar and a dataset rather than functions
  // and so appear nowhere in the retrieved reference — and which is where a small model's
  // mistakes have actually landed.
  const vocabulary = vocabularyBlock({ query: message, code: current?.code ?? "" });

  const reply = await resolved.backend.run({
    system: [SYSTEM_PROMPT, vocabulary, context].filter(Boolean).join("\n\n"),
    messages,
    tools: buildChatTools(ctx),
    maxIterations: MAX_ITERATIONS,
  });

  // A turn that ran out of iterations mid-tool-call, or that only made tool calls, has no
  // text for the panel to render. Say so rather than broadcasting an empty chat bubble —
  // the tools it did run have already taken effect in the room, and the user needs to know.
  if (!reply) {
    return {
      reply: ctx.toolsUsed.length
        ? `(ran ${ctx.toolsUsed.join(", ")} but stopped before answering — ask again if that didn't do it)`
        : "(no reply)",
      toolsUsed: ctx.toolsUsed,
    };
  }

  return { reply, toolsUsed: ctx.toolsUsed };
}
