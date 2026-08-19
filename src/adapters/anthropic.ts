import { joinUrl } from "../env.ts";
import { parseSse } from "../responses/sse.ts";
import { textOf } from "../responses/parse.ts";
import type {
  Adapter,
  AdapterEvent,
  AdapterRequest,
  ContentPart,
  ParsedRequest,
  ResolvedProvider,
} from "../types.ts";

const THINKING_BUDGET: Record<string, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 31999,
  max: 31999,
};

function imageBlock(url: string): Record<string, unknown> | undefined {
  const match = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (match) {
    return {
      type: "image",
      source: { type: "base64", media_type: match[1], data: match[2] },
    };
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return { type: "image", source: { type: "url", url } };
  }
  return undefined;
}

function userContent(parts: ContentPart[]): unknown {
  const blocks: unknown[] = [];
  for (const part of parts) {
    if (part.type === "text") blocks.push({ type: "text", text: part.text });
    else {
      const image = imageBlock(part.url);
      if (image) blocks.push(image);
    }
  }
  return blocks.length === 1 && (blocks[0] as { type?: string }).type === "text"
    ? textOf(parts)
    : blocks;
}

export function toAnthropicBody(parsed: ParsedRequest, model: string): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: Record<string, unknown>[] = [];

  for (const message of parsed.messages) {
    if (message.role === "system") {
      const text = textOf(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === "user") {
      messages.push({ role: "user", content: userContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const content: unknown[] = [];
      const text = textOf(message.content);
      if (text) content.push({ type: "text", text });
      for (const call of message.toolCalls ?? []) {
        let input: unknown = {};
        if (call.kind === "custom") input = { input: call.arguments };
        else {
          try {
            input = call.arguments ? JSON.parse(call.arguments) : {};
          } catch {
            input = { input: call.arguments };
          }
        }
        content.push({ type: "tool_use", id: call.id, name: call.name, input });
      }
      messages.push({ role: "assistant", content: content.length ? content : "" });
      continue;
    }
    if (message.role !== "tool") continue;
    const last = messages[messages.length - 1];
    const result = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
    };
    if (last?.role === "user" && Array.isArray(last.content)) {
      (last.content as unknown[]).push(result);
    } else {
      messages.push({ role: "user", content: [result] });
    }
  }

  const tools = parsed.tools.map((tool) => {
    if (tool.type === "custom") {
      return {
        name: tool.name,
        description: tool.description ?? "",
        input_schema: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
        },
      };
    }
    return {
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.parameters ?? { type: "object", properties: {} },
    };
  });

  const effort = parsed.reasoningEffort;
  const thinkingBudget = effort && effort !== "none" ? THINKING_BUDGET[effort] : undefined;
  const maxTokens = Math.max(parsed.maxTokens ?? 16384, (thinkingBudget ?? 0) + 1024);

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: parsed.stream,
  };
  if (systemParts.length) body.system = systemParts.join("\n\n");
  if (tools.length) {
    body.tools = tools;
    if (parsed.toolChoice === "none") body.tool_choice = { type: "none" };
    else if (parsed.toolChoice === "required") body.tool_choice = { type: "any" };
    else if (parsed.toolChoice === "auto") body.tool_choice = { type: "auto" };
    else body.tool_choice = { type: "tool", name: parsed.toolChoice.name };
  }
  if (parsed.temperature !== undefined && !thinkingBudget) body.temperature = parsed.temperature;
  if (thinkingBudget) body.thinking = { type: "enabled", budget_tokens: thinkingBudget };
  return body;
}

async function* parseAnthropicStream(response: Response): AsyncGenerator<AdapterEvent> {
  const toolIds = new Map<number, string>();
  for await (const block of parseSse(response.body)) {
    let json: unknown;
    try {
      json = JSON.parse(block.data) as unknown;
    } catch {
      continue;
    }
    if (!json || typeof json !== "object") continue;
    const rec = json as {
      type?: string;
      error?: { message?: string };
      index?: number;
      content_block?: { type?: string; id?: string; name?: string; text?: string };
      delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } };
    };
    switch (rec.type) {
      case "error":
        yield { type: "error", message: rec.error?.message ?? "Anthropic error", status: response.status };
        return;
      case "content_block_start": {
        const blockType = rec.content_block?.type;
        if (blockType === "tool_use" && rec.content_block?.id && rec.content_block.name) {
          toolIds.set(rec.index ?? 0, rec.content_block.id);
          yield {
            type: "tool_call_start",
            id: rec.content_block.id,
            name: rec.content_block.name,
            kind: "function",
          };
        }
        if (blockType === "text" && rec.content_block?.text) {
          yield { type: "text_delta", text: rec.content_block.text };
        }
        break;
      }
      case "content_block_delta": {
        if (rec.delta?.type === "text_delta" && rec.delta.text) {
          yield { type: "text_delta", text: rec.delta.text };
        } else if (rec.delta?.type === "thinking_delta" && rec.delta.thinking) {
          yield { type: "thinking_delta", text: rec.delta.thinking };
        } else if (rec.delta?.type === "input_json_delta" && rec.delta.partial_json) {
          const id = toolIds.get(rec.index ?? 0);
          if (id) yield { type: "tool_call_delta", id, arguments: rec.delta.partial_json };
        }
        break;
      }
      case "content_block_stop": {
        const id = toolIds.get(rec.index ?? 0);
        if (id) yield { type: "tool_call_end", id };
        break;
      }
      case "message_delta":
      case "message_start": {
        const usage = rec.usage ?? rec.message?.usage;
        if (usage) {
          yield {
            type: "usage",
            usage: {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cachedTokens: usage.cache_read_input_tokens,
            },
          };
        }
        break;
      }
      case "message_stop":
        yield { type: "done" };
        return;
    }
  }
  yield { type: "done" };
}

export function anthropicAdapter(): Adapter {
  return {
    name: "anthropic",
    buildRequest(parsed: ParsedRequest, provider: ResolvedProvider): AdapterRequest {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...provider.headers,
      };
      if (provider.apiKey) headers["x-api-key"] = provider.apiKey;
      const base = provider.baseUrl.replace(/\/v1$/, "");
      return {
        url: joinUrl(base, "v1/messages"),
        method: "POST",
        headers,
        body: JSON.stringify(toAnthropicBody(parsed, provider.model.id)),
      };
    },
    parseStream: parseAnthropicStream,
  };
}
