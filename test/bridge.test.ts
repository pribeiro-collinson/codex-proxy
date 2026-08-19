import { describe, expect, test } from "bun:test";
import { bridgeEvents } from "../src/responses/bridge.ts";
import { parseResponsesRequest } from "../src/responses/parse.ts";
import type { AdapterEvent } from "../src/types.ts";

async function collect(events: AdapterEvent[]): Promise<string> {
  const parsed = parseResponsesRequest({
    model: "xai/grok-4",
    tools: [{ type: "custom", name: "apply_patch" }],
    input: "hi",
  });
  let out = "";
  for await (const chunk of bridgeEvents(parsed, events, "resp_test")) out += chunk;
  return out;
}

function eventsOf(sse: string): string[] {
  return [...sse.matchAll(/^event: (.+)$/gm)].map((match) => match[1] ?? "");
}

describe("bridgeEvents", () => {
  test("emits a complete text lifecycle", async () => {
    const sse = await collect([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } },
      { type: "done" },
    ]);
    expect(eventsOf(sse)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(sse).toContain("Hello world");
    expect(sse).toContain("\"input_tokens\":10");
  });

  test("rewrites apply_patch function calls as custom_tool_call", async () => {
    const sse = await collect([
      { type: "tool_call_start", id: "call_1", name: "apply_patch", kind: "function" },
      { type: "tool_call_delta", id: "call_1", arguments: "{\"input\":\"*** Begin Patch\"}" },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ]);
    expect(sse).toContain("custom_tool_call");
    expect(sse).toContain("*** Begin Patch");
    expect(sse).not.toContain("\"arguments\"");
  });

  test("failed upstream becomes response.failed", async () => {
    const sse = await collect([{ type: "error", message: "nope", status: 429 }]);
    expect(sse).toContain("response.failed");
    expect(sse).toContain("nope");
  });
});
