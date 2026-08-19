import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { createHandler } from "../src/server.ts";
import { parseSse } from "../src/responses/sse.ts";

const config = parseConfig({
  listen: "127.0.0.1:18789",
  defaultProvider: "openrouter",
  providers: {
    openrouter: {
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test",
      models: [{ id: "anthropic/claude-sonnet-4.6", displayName: "Claude" }],
    },
  },
});

function chatSse(content: string): Response {
  return new Response(
    [
      `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}\n\n`,
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("createHandler", () => {
  test("healthz does not require a token on loopback", async () => {
    const handler = createHandler(config);
    const response = await handler(new Request("http://127.0.0.1/healthz"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("lists routed models", async () => {
    const handler = createHandler(config);
    const response = await handler(new Request("http://127.0.0.1/v1/models"));
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((item) => item.id)).toEqual(["openrouter/anthropic/claude-sonnet-4.6"]);
  });

  test("translates Responses streaming through chat completions", async () => {
    const handler = createHandler(config, {
      fetch: async (input) => {
        const url = String(input);
        expect(url).toContain("/chat/completions");
        return chatSse("Hello from Claude");
      },
    });
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openrouter/anthropic/claude-sonnet-4.6",
          input: "hi",
          stream: true,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    let text = "";
    const events: string[] = [];
    for await (const block of parseSse(response.body)) {
      if (block.event) events.push(block.event);
      if (block.event === "response.output_text.delta") {
        const data = JSON.parse(block.data) as { delta?: string };
        text += data.delta ?? "";
      }
    }
    expect(text).toBe("Hello from Claude");
    expect(events).toContain("response.completed");
  });

  test("rejects websocket upgrades so Codex falls back to SSE", async () => {
    const handler = createHandler(config);
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(426);
  });

  test("returns 404 for an unknown model", async () => {
    const handler = createHandler(config, { fetch: async () => new Response("no") });
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "nope", input: "x" }),
      }),
    );
    expect(response.status).toBe(404);
  });
});
