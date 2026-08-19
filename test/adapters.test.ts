import { describe, expect, test } from "bun:test";
import { toAnthropicBody } from "../src/adapters/anthropic.ts";
import { openaiChatAdapter, toChatBody } from "../src/adapters/openai-chat.ts";
import { parseResponsesRequest } from "../src/responses/parse.ts";
import type { ResolvedProvider } from "../src/types.ts";

function parsed(extra: Record<string, unknown> = {}) {
  return parseResponsesRequest({
    model: "openrouter/anthropic/claude-sonnet-4.6",
    instructions: "Be precise",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "c1", output: "a.ts" },
    ],
    tools: [
      { type: "custom", name: "apply_patch" },
      { type: "function", name: "shell", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
    ],
    reasoning: { effort: "medium" },
    ...extra,
  });
}

describe("openai-chat adapter", () => {
  test("builds a chat-completions body with tools and history", () => {
    const body = toChatBody(parsed(), "anthropic/claude-sonnet-4.6");
    expect(body.model).toBe("anthropic/claude-sonnet-4.6");
    expect(body.stream).toBe(true);
    expect(body.reasoning_effort).toBe("medium");
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[1]).toMatchObject({ role: "user" });
    expect(messages[2]).toMatchObject({ role: "assistant" });
    expect((messages[2]?.tool_calls as unknown[])?.length).toBe(1);
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    const tools = body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name)).toEqual(["apply_patch", "shell"]);
  });

  test("parses a streamed tool call", async () => {
    const adapter = openaiChatAdapter();
    const response = new Response(
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"ls\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "done",
    ]);
  });
});

describe("anthropic adapter", () => {
  test("puts system out of band and tool results on user turns", () => {
    const body = toAnthropicBody(parsed(), "claude-sonnet-4-6");
    expect(body.system).toBe("Be precise");
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[2]?.role).toBe("user");
    const results = messages[2]?.content as Array<{ type: string; tool_use_id: string }>;
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
  });
});

describe("adapter request URL", () => {
  test("openai-chat joins /chat/completions", () => {
    const provider: ResolvedProvider = {
      id: "openrouter",
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test",
      headers: {},
      model: { id: "anthropic/claude-sonnet-4.6" },
      slug: "openrouter/anthropic/claude-sonnet-4.6",
    };
    const request = openaiChatAdapter().buildRequest(parsed(), provider);
    expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer sk-test");
  });
});
