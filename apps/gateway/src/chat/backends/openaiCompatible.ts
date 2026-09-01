// The second backend: anything that speaks the OpenAI chat-completions protocol.
//
// That protocol is the one thing nearly every other runtime agrees on — Ollama, vLLM,
// LM Studio, llama.cpp's server, OpenRouter, Together, and OpenAI itself all expose
// POST {base}/chat/completions with the same tool-calling shape — so implementing it once
// is what makes "run this room off a local Llama" a config change instead of a rewrite.
//
// Raw fetch rather than a vendor SDK, deliberately: adding the `openai` package would pin
// this to one vendor's client for a protocol half a dozen non-OpenAI servers implement, and
// the whole surface used here is one POST and a loop. The Claude path is the opposite call —
// it uses the official Anthropic SDK (see anthropic.ts), because there it exists and is the
// supported way in.

import {
  type BackendRequest,
  CHAT_REQUEST_TIMEOUT_MS,
  type ChatBackend,
  type ChatTool,
  guardTool,
} from "../types.js";

const MAX_TOKENS = 8000;

/** Only the fields this loop reads. The servers above agree on these and differ past them. */
interface WireToolCall {
  id?: string;
  function: { name: string; arguments: string | Record<string, unknown> };
}

interface WireMessage {
  role: string;
  content?: string | null;
  tool_calls?: WireToolCall[];
}

interface WireResponse {
  choices?: Array<{ message?: WireMessage; finish_reason?: string }>;
  error?: { message?: string };
}

function toWireTool(tool: ChatTool) {
  return {
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

/**
 * Arguments arrive as a JSON *string* per the spec, but Ollama (and a few others) send an
 * already-parsed object instead. Accepting both costs three lines; assuming one and getting
 * the other is a tool that silently never runs.
 */
function parseToolArguments(raw: string | Record<string, unknown>): unknown {
  if (typeof raw !== "string") return raw;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export function createOpenAiCompatibleBackend({
  baseUrl,
  apiKey,
  model,
  disableThinking,
}: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /**
   * Ask the server to render the chat template with thinking off, for reasoning models
   * that would otherwise spend most of a turn on tokens nobody in the room ever sees.
   *
   * Off by default because it is not part of the OpenAI protocol — it is a passthrough to
   * the *template*, understood by vLLM, MLX and Ollama, and a server that doesn't know the
   * field may reject the whole request rather than ignore it. So it is opt-in per
   * deployment (CHAT_DISABLE_THINKING=true) rather than something every backend sends.
   */
  disableThinking?: boolean;
}): ChatBackend {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  // Qwen-family template flag; harmless on templates that don't read it.
  const templateKwargs = disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {};

  return {
    model,
    async run({ system, messages, tools, maxIterations }: BackendRequest) {
      const guarded = new Map(tools.map((tool) => [tool.name, guardTool(tool)]));
      const wireTools = tools.map(toWireTool);

      // The system prompt is a message here rather than a top-level field — the other half
      // of what the Anthropic backend passes as `system`.
      const history: Array<Record<string, unknown>> = [
        { role: "system", content: system },
        ...messages.map((message) => ({ role: message.role, content: message.content })),
      ];

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        // Both failure modes below reach a human: this error becomes the "the bot couldn't
        // answer: ..." line in the chat panel. Unwrapped, a timeout surfaces as a bare
        // DOMException and a refused connection as "fetch failed" — neither of which tells
        // anyone which server was being talked to or what to do about it.
        let res: Response;
        try {
          res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              // Omitted entirely when there's no key: a local Ollama rejects nothing, but
              // sending `Bearer undefined` is a 401 against servers that do check.
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
              model,
              max_tokens: MAX_TOKENS,
              messages: history,
              tools: wireTools,
              tool_choice: "auto",
              ...templateKwargs,
            }),
            signal: AbortSignal.timeout(CHAT_REQUEST_TIMEOUT_MS),
          });
        } catch (err) {
          const name = err instanceof Error ? err.name : "";
          if (name === "TimeoutError" || name === "AbortError") {
            throw new Error(
              `chat backend ${endpoint} (${model}) didn't respond within ${
                CHAT_REQUEST_TIMEOUT_MS / 1000
              }s — a local model may just be slow for this prompt`,
            );
          }
          throw new Error(
            `chat backend ${endpoint} is unreachable: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (!res.ok) {
          // Body first, status second: an OpenAI-compatible error body names the actual
          // problem ("model not found"), which a bare 404 does not.
          const detail = (await res.text().catch(() => "")).slice(0, 500);
          throw new Error(`chat backend ${endpoint} returned ${res.status}${detail ? `: ${detail}` : ""}`);
        }

        const body = (await res.json()) as WireResponse;
        if (body.error?.message) throw new Error(`chat backend error: ${body.error.message}`);

        const message = body.choices?.[0]?.message;
        if (!message) throw new Error("chat backend returned no choices");

        const toolCalls = message.tool_calls ?? [];
        if (toolCalls.length === 0) {
          return (message.content ?? "").trim();
        }

        // Echoed back verbatim — the server has to see its own tool_calls to match the tool
        // results that follow.
        history.push(message as unknown as Record<string, unknown>);

        // Sequential rather than parallel: these tools write to the room's shared buffer, and
        // two set_pattern calls racing would leave whichever lost the race on everyone's
        // screen. Ordering the room's edits is worth more here than a few hundred ms.
        for (const [index, call] of toolCalls.entries()) {
          // Some servers omit the id; the loop still has to pair result with call, so
          // synthesise one and use the same value on both sides.
          const id = call.id ?? `call_${iteration}_${index}`;
          const tool = guarded.get(call.function?.name);
          let content: string;
          if (!tool) {
            content = `Error: no such tool ${call.function?.name}`;
          } else {
            try {
              content = await tool.run(parseToolArguments(call.function.arguments));
            } catch (err) {
              // guardTool already catches what the tool itself throws, so reaching here means
              // the *arguments* didn't parse — which is the model's mistake to correct.
              content = `Error: could not read arguments for ${tool.name}: ${
                err instanceof Error ? err.message : String(err)
              }`;
            }
          }
          history.push({ role: "tool", tool_call_id: id, name: call.function?.name, content });
        }
      }

      // Out of iterations with a tool call still pending. Deliberately not another request:
      // the caller reports what the tools already did to the room, which is the part the
      // humans need to know about.
      return "";
    },
  };
}
