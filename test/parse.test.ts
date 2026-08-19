import { describe, expect, test } from "bun:test";
import { parseResponsesRequest } from "../src/responses/parse.ts";
import { encodeCompactionSummary } from "../src/responses/compact.ts";

const base = {
  model: "openrouter/anthropic/claude-sonnet-4.6",
  stream: true,
};

describe("parseResponsesRequest", () => {
  test("string input becomes a user message", () => {
    const parsed = parseResponsesRequest({ ...base, input: "hello" });
    expect(parsed.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  test("instructions become a system message", () => {
    const parsed = parseResponsesRequest({
      ...base,
      instructions: "You are Codex",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(parsed.messages[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "You are Codex" }],
    });
  });

  test("developer role maps to system", () => {
    const parsed = parseResponsesRequest({
      ...base,
      input: [{ type: "message", role: "developer", content: "be brief" }],
    });
    expect(parsed.messages[0]?.role).toBe("system");
  });

  test("coalesces consecutive function calls onto one assistant message", () => {
    const parsed = parseResponsesRequest({
      ...base,
      input: [
        { type: "function_call", call_id: "c1", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
        { type: "function_call", call_id: "c2", name: "shell", arguments: "{\"cmd\":\"pwd\"}" },
        { type: "function_call_output", call_id: "c1", output: "a" },
      ],
    });
    const assistant = parsed.messages[0];
    expect(assistant?.role).toBe("assistant");
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.toolCalls?.map((call) => call.id)).toEqual(["c1", "c2"]);
    expect(parsed.messages[1]).toMatchObject({ role: "tool", toolCallId: "c1", content: "a" });
  });

  test("custom apply_patch tools are flagged", () => {
    const parsed = parseResponsesRequest({
      ...base,
      tools: [
        { type: "custom", name: "apply_patch", description: "Apply a patch" },
        { type: "web_search" },
        {
          type: "function",
          name: "shell",
          parameters: { type: "object", properties: {} },
        },
      ],
      input: [],
    });
    expect(parsed.customToolNames.has("apply_patch")).toBe(true);
    expect(parsed.tools.map((tool) => tool.name)).toEqual(["apply_patch", "shell"]);
  });

  test("compaction_trigger sets v2", () => {
    const parsed = parseResponsesRequest({
      ...base,
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "compaction_trigger" },
      ],
    });
    expect(parsed.compactionV2).toBe(true);
  });

  test("decodes our compaction envelope back into text", () => {
    const parsed = parseResponsesRequest({
      ...base,
      input: [
        { type: "compaction", encrypted_content: encodeCompactionSummary("we picked bun") },
      ],
    });
    const user = parsed.messages[0];
    expect(user?.role).toBe("user");
    if (user?.role !== "user") throw new Error("expected user");
    expect(user.content[0]).toMatchObject({ type: "text" });
    if (user.content[0]?.type !== "text") throw new Error("expected text");
    expect(user.content[0].text).toContain("we picked bun");
  });

  test("rejects a missing model", () => {
    expect(() => parseResponsesRequest({ input: "x" })).toThrow("model is required");
  });
});
