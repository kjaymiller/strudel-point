// The provider-neutral half of the chatbot: what a tool is, what a turn is, and what any
// backend has to be able to do. Nothing in this file knows which model is answering.
//
// The seam exists because the tools are the valuable part. `set_pattern` publishing a
// doc:update to Kafka is the same work regardless of who decided to call it, so the tool
// definitions live once (tools.ts) and each backend adapts them to its own wire format —
// rather than one copy per provider, drifting apart the first time a description changes.

/**
 * The subset of JSON Schema both wire formats accept unchanged: Anthropic's `input_schema`
 * and OpenAI's `function.parameters` are both plain draft-07 object schemas. Deliberately
 * narrow — anything fancier (oneOf, $ref) is where the two stop agreeing.
 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: readonly string[];
  additionalProperties: false;
}

export interface ChatTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /**
   * Returns whatever the model should read back. `input` is unknown because it arrives
   * parsed from JSON the model produced — see defineTool for how the typed view is kept.
   */
  run: (input: unknown) => Promise<string>;
}

/**
 * Declares a tool with a typed `run` while still storing it in the erased `ChatTool` shape
 * the backends consume.
 *
 * The cast here is the one place the type system stops helping: `I` and `inputSchema` are
 * asserted to agree, not checked. That's the price of a runtime-neutral tool list, and it's
 * cheap to keep honest — the schema sits three lines above the destructure that reads it,
 * and guardTool below turns a mismatch into a tool-result string the model can react to
 * rather than a 500.
 */
export function defineTool<I>(tool: {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  run: (input: I) => Promise<string>;
}): ChatTool {
  return tool as ChatTool;
}

/**
 * Makes a tool's failure the model's problem instead of the request's.
 *
 * Both backends map through this, so a thrown tool — bad input, Postgres down, an expired
 * object in storage — comes back as a tool result the model can read and route around
 * ("that sample's gone, want me to use the built-in one?"), which is a better outcome than
 * a 500 that loses the turn. The one thing it must not do is swallow the detail silently,
 * hence the console.error: an operator watching logs still sees every failure.
 */
export function guardTool(tool: ChatTool): ChatTool {
  return {
    ...tool,
    run: async (input) => {
      try {
        return await tool.run(input);
      } catch (err) {
        console.error(`chat tool ${tool.name} failed`, err);
        return `Error running ${tool.name}: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/** A turn in the visible conversation. Tool calls never appear here — they're backend-internal. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface BackendRequest {
  system: string;
  messages: ChatMessage[];
  tools: ChatTool[];
  /** Hard stop on the tool loop. Every iteration is a paid call against a held-open request. */
  maxIterations: number;
}

export interface ChatBackend {
  /** For logs and GET /api/chat/status — what's actually answering. */
  readonly model: string;
  /** Runs the tool loop to completion and returns the model's final text. */
  run(request: BackendRequest): Promise<string>;
}

/**
 * Ceiling on one backend call. The Anthropic SDK defaults to 10 minutes and a self-hosted
 * OpenAI-compatible server defaults to nothing at all — either way a browser tab is holding
 * this request open, so both backends are pinned to something a person will wait for.
 */
export const CHAT_REQUEST_TIMEOUT_MS = 120_000;
