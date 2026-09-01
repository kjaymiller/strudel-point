import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatTool, ToolInputSchema } from "../types.js";
import { createOpenAiCompatibleBackend } from "./openaiCompatible.js";

const SCHEMA: ToolInputSchema = {
  type: "object",
  properties: { code: { type: "string" } },
  required: ["code"],
  additionalProperties: false,
};

function tool(overrides: Partial<ChatTool> = {}): ChatTool {
  return {
    name: "set_pattern",
    description: "replaces the buffer",
    inputSchema: SCHEMA,
    run: async () => "ok",
    ...overrides,
  };
}

/** Queues one canned HTTP response per call, in order, and records what was sent. */
function stubFetch(bodies: unknown[]) {
  const sent: any[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    const body = bodies.shift();
    return { ok: true, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { sent, fetchMock };
}

const assistant = (content: string) => ({ choices: [{ message: { role: "assistant", content } }] });
const wantsTool = (calls: unknown[]) => ({
  choices: [{ message: { role: "assistant", content: null, tool_calls: calls } }],
});

const backend = (model = "llama3.1") =>
  createOpenAiCompatibleBackend({ baseUrl: "http://ollama:11434/v1/", model });

const turn = (tools: ChatTool[]) => ({
  system: "you are strudelbot",
  messages: [{ role: "user" as const, content: "kjay: give me a beat" }],
  tools,
  maxIterations: 5,
});

afterEach(() => vi.unstubAllGlobals());

describe("createOpenAiCompatibleBackend", () => {
  it("returns the reply when the model asks for no tools", async () => {
    stubFetch([assistant("  here you go  ")]);
    expect(await backend().run(turn([tool()]))).toBe("here you go");
  });

  it("normalises the base URL rather than posting to a doubled slash", async () => {
    const { fetchMock } = stubFetch([assistant("hi")]);
    await backend().run(turn([tool()]));
    expect(fetchMock.mock.calls[0][0]).toBe("http://ollama:11434/v1/chat/completions");
  });

  it("sends the system prompt as the first message, which is where this protocol wants it", async () => {
    const { sent } = stubFetch([assistant("hi")]);
    await backend().run(turn([tool()]));
    expect(sent[0].messages[0]).toEqual({ role: "system", content: "you are strudelbot" });
    expect(sent[0].tools[0].function.parameters).toEqual(SCHEMA);
  });

  it("runs a requested tool and feeds the result back for a second pass", async () => {
    const run = vi.fn(async () => "Buffer replaced.");
    const { sent } = stubFetch([
      wantsTool([{ id: "call_1", function: { name: "set_pattern", arguments: '{"code":"s(\\"bd\\")"}' } }]),
      assistant("done — it's in the buffer"),
    ]);

    expect(await backend().run(turn([tool({ run })]))).toBe("done — it's in the buffer");
    expect(run).toHaveBeenCalledWith({ code: 's("bd")' });

    // The second request has to carry the assistant's own tool_calls turn *and* the result,
    // in that order — a server that can't see its own call has nothing to match the result to.
    const [assistantTurn, toolTurn] = sent[1].messages.slice(-2);
    expect(assistantTurn.tool_calls[0].id).toBe("call_1");
    expect(toolTurn).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "Buffer replaced." });
  });

  // Ollama and friends send arguments as an already-parsed object rather than the JSON
  // string the spec calls for. Assuming one and getting the other is a tool that never runs.
  it("accepts tool arguments as an object as well as a JSON string", async () => {
    const run = vi.fn(async () => "ok");
    stubFetch([
      wantsTool([{ id: "c", function: { name: "set_pattern", arguments: { code: 's("hh")' } } }]),
      assistant("ok"),
    ]);
    await backend().run(turn([tool({ run })]));
    expect(run).toHaveBeenCalledWith({ code: 's("hh")' });
  });

  it("pairs results with calls even when the server omits tool call ids", async () => {
    const { sent } = stubFetch([
      wantsTool([{ function: { name: "set_pattern", arguments: "{}" } }]),
      assistant("ok"),
    ]);
    await backend().run(turn([tool()]));
    // Synthesised, but present: a tool message with no tool_call_id is rejected outright by
    // some servers and silently dropped by others.
    expect(sent[1].messages.at(-1).tool_call_id).toBeTruthy();
  });

  it("tells the model when it asked for a tool that doesn't exist, instead of throwing", async () => {
    const { sent } = stubFetch([
      wantsTool([{ id: "c", function: { name: "make_coffee", arguments: "{}" } }]),
      assistant("my mistake"),
    ]);
    expect(await backend().run(turn([tool()]))).toBe("my mistake");
    const toolResult = sent[1].messages.at(-1);
    expect(toolResult.role).toBe("tool");
    expect(toolResult.content).toContain("no such tool make_coffee");
  });

  it("reports unparseable arguments back to the model as a tool result", async () => {
    const { sent } = stubFetch([
      wantsTool([{ id: "c", function: { name: "set_pattern", arguments: "{not json" } }]),
      assistant("let me retry"),
    ]);
    await backend().run(turn([tool()]));
    expect(sent[1].messages.at(-1).content).toContain("could not read arguments");
  });

  // guardTool's contract, exercised through the backend: a tool that throws is the model's
  // problem to route around, not a 500 that loses the whole turn.
  it("surfaces a throwing tool as a tool result", async () => {
    const { sent } = stubFetch([
      wantsTool([{ id: "c", function: { name: "set_pattern", arguments: "{}" } }]),
      assistant("that sample is gone"),
    ]);
    const run = async () => {
      throw new Error("postgres is down");
    };
    expect(await backend().run(turn([tool({ run })]))).toBe("that sample is gone");
    expect(sent[1].messages.at(-1).content).toContain("postgres is down");
  });

  it("stops at maxIterations instead of looping on a model that only ever calls tools", async () => {
    const forever = () => wantsTool([{ id: "c", function: { name: "set_pattern", arguments: "{}" } }]);
    const { fetchMock } = stubFetch([forever(), forever(), forever(), forever(), forever(), forever()]);
    // Empty reply is the signal agent.ts turns into "ran set_pattern but stopped before answering".
    expect(await backend().run({ ...turn([tool()]), maxIterations: 3 })).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // Both of these reach a human as "the bot couldn't answer: ..." in the chat panel, so the
  // raw DOMException / "fetch failed" that fetch throws is not good enough on its own.
  it("names the endpoint and the timeout when the server doesn't answer in time", async () => {
    const timeout = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeout;
      }),
    );
    await expect(backend().run(turn([tool()]))).rejects.toThrow(/didn't respond within 120s/);
  });

  it("says which server is unreachable when the connection fails outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(backend().run(turn([tool()]))).rejects.toThrow(
      /http:\/\/ollama:11434\/v1\/chat\/completions is unreachable/,
    );
  });

  it("puts the server's own error text in the thrown message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => ({ ok: false, status: 404, text: async () => "model 'llama9' not found" }) as Response,
      ),
    );
    await expect(backend().run(turn([tool()]))).rejects.toThrow("model 'llama9' not found");
  });
  // Reasoning models can spend most of a turn on tokens nobody in the room ever sees. The
  // flag is a chat-template passthrough rather than part of the OpenAI protocol, so a
  // server that doesn't know it may reject the whole request — hence opt-in, and hence a
  // test that the default request stays clean.
  it("says nothing about thinking unless it was asked to", async () => {
    const { sent } = stubFetch([assistant("hi")]);
    await backend().run(turn([tool()]));
    expect(sent[0]).not.toHaveProperty("chat_template_kwargs");
  });

  it("asks the server to render the template with thinking off when told to", async () => {
    const { sent } = stubFetch([assistant("hi")]);
    await createOpenAiCompatibleBackend({
      baseUrl: "http://ollama:11434/v1/",
      model: "qwen3.5",
      disableThinking: true,
    }).run(turn([tool()]));
    expect(sent[0].chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
