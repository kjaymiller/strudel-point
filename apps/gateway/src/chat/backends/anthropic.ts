// The default backend: Claude, through the official @anthropic-ai/sdk.
//
// This is the path the app is built around and the one the room prompt in agent.ts is
// written for. The SDK's tool runner drives the loop — request, run the tools it asked for,
// feed the results back — so the only thing this file really does is translate between the
// neutral ChatTool shape and the SDK's, in both directions.

import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import {
  type BackendRequest,
  CHAT_REQUEST_TIMEOUT_MS,
  type ChatBackend,
  type ChatTool,
  guardTool,
} from "../types.js";

/**
 * Generous: the room prompt asks for a couple of sentences, but a tool turn also carries
 * whole patterns as arguments, and truncating one mid-`stack(` would put broken source in
 * front of everyone in the room.
 */
const MAX_TOKENS = 8000;

/**
 * betaTool infers its `run` argument type from a schema it can see as a literal. Ours are
 * erased to ToolInputSchema by the time they get here (that's the whole point of the seam),
 * so the inference has nothing to work with and the cast puts it back. defineTool already
 * paired the schema with a typed run on the other side of the boundary.
 */
function toSdkTool(tool: ChatTool) {
  const guarded = guardTool(tool);
  return betaTool({
    name: guarded.name,
    description: guarded.description,
    inputSchema: guarded.inputSchema as unknown as { type: "object" },
    run: (input) => guarded.run(input),
  });
}

export function createAnthropicBackend({ apiKey, model }: { apiKey: string; model: string }): ChatBackend {
  const client = new Anthropic({ apiKey, timeout: CHAT_REQUEST_TIMEOUT_MS });

  return {
    model,
    async run({ system, messages, tools, maxIterations }: BackendRequest) {
      // Thinking is left unset on purpose: Claude Opus 5 runs adaptive thinking by default,
      // which is what you want for "read the room's buffer, then write a pattern that fits
      // it". Pinning a mode here would be a worse default the moment CHAT_MODEL changes.
      const final = await client.beta.messages.toolRunner({
        model,
        max_tokens: MAX_TOKENS,
        max_iterations: maxIterations,
        system,
        tools: tools.map(toSdkTool),
        messages: messages.map((message) => ({ role: message.role, content: message.content })),
      });

      return final.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    },
  };
}
