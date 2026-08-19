import { joinUrl } from "../env.ts";
import { parseSse } from "../responses/sse.ts";
import { textOf } from "../responses/parse.ts";
import { id } from "../ids.ts";
import type {
  Adapter,
  AdapterEvent,
  AdapterRequest,
  ContentPart,
  ParsedRequest,
  ResolvedProvider,
  ToolCall,
} from "../types.ts";

type ChatToolCall = {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

function contentFor(parts: ContentPart[], role: "system" | "user"): unknown {
  const images = parts.filter((part) => part.type === "image");
  const text = textOf(parts);
  if (images.length === 0) return text;
  const out: unknown[] = [];
  if (text) out.push({ type: "text", text });
  for (const image of images) {
    out.push({ type: "image_url", image_url: { url: image.url } });
  }
  if (role === "system") return text;
  return out;
}

function assistantArgs(call: ToolCall): string {
  return call.kind === "custom" ? JSON.stringify({ input: call.arguments }) : call.arguments;
}

export function toChatBody(parsed: ParsedRequest, model: string): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  for (const message of parsed.messages) {
    if (message.role === "system" || message.role === "user") {
      messages.push({ role: message.role, content: contentFor(message.content, message.role) });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: assistantArgs(call) },
      }));
      messages.push({
        role: "assistant",
        content: textOf(message.content) || (toolCalls?.length ? null : ""),
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (message.role !== "tool") continue;
    messages.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      ...(message.name ? { name: message.name } : {}),
      content: message.content,
    });
  }

  const tools = parsed.tools.map((tool) => {
    if (tool.type === "custom") {
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description ?? "",
          parameters: {
            type: "object",
            properties: { input: { type: "string", description: "Tool input" } },
            required: ["input"],
          },
        },
      };
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? { type: "object", properties: {} },
      },
    };
  });

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: parsed.stream,
    stream_options: parsed.stream ? { include_usage: true } : undefined,
  };
  if (tools.length > 0) {
    body.tools = tools;
    if (parsed.toolChoice === "none" || parsed.toolChoice === "required" || parsed.toolChoice === "auto") {
      body.tool_choice = parsed.toolChoice;
    } else {
      body.tool_choice = { type: "function", function: { name: parsed.toolChoice.name } };
    }
  }
  if (parsed.maxTokens !== undefined) body.max_tokens = parsed.maxTokens;
  if (parsed.temperature !== undefined) body.temperature = parsed.temperature;
  if (parsed.jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "output", schema: parsed.jsonSchema, strict: false },
    };
  }
  if (parsed.reasoningEffort && parsed.reasoningEffort !== "none") {
    body.reasoning_effort = parsed.reasoningEffort === "xhigh" || parsed.reasoningEffort === "max"
      ? "high"
      : parsed.reasoningEffort;
  }
  return body;
}

async function* parseChatStream(response: Response): AsyncGenerator<AdapterEvent> {
  const pending = new Map<number, { id: string; name: string; arguments: string; started: boolean }>();
  for await (const block of parseSse(response.body)) {
    if (block.data === "[DONE]") {
      for (const call of pending.values()) {
        if (call.started) yield { type: "tool_call_end", id: call.id };
      }
      yield { type: "done" };
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(block.data) as unknown;
    } catch {
      continue;
    }
    if (!json || typeof json !== "object") continue;
    const rec = json as {
      error?: { message?: string };
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      choices?: Array<{
        finish_reason?: string | null;
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | { content?: string } | null;
          tool_calls?: ChatToolCall[];
        };
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: ChatToolCall[];
        };
      }>;
    };
    if (rec.error?.message) {
      yield { type: "error", message: rec.error.message, status: response.status };
      return;
    }
    const choice = rec.choices?.[0];
    const delta = choice?.delta;
    const thinking =
      (typeof delta?.reasoning_content === "string" ? delta.reasoning_content : undefined) ??
      (typeof delta?.reasoning === "string" ? delta.reasoning : undefined) ??
      (delta?.reasoning && typeof delta.reasoning === "object" ? delta.reasoning.content : undefined);
    if (thinking) yield { type: "thinking_delta", text: thinking };
    if (typeof delta?.content === "string" && delta.content) {
      yield { type: "text_delta", text: delta.content };
    }
    if (delta?.tool_calls) {
      for (const call of delta.tool_calls) {
        const index = call.index ?? 0;
        let state = pending.get(index);
        if (!state) {
          state = { id: call.id || id("call"), name: call.function?.name ?? "", arguments: "", started: false };
          pending.set(index, state);
        }
        if (call.id) state.id = call.id;
        if (call.function?.name) state.name = call.function.name;
        if (!state.started && state.name) {
          state.started = true;
          yield { type: "tool_call_start", id: state.id, name: state.name, kind: "function" };
        }
        if (call.function?.arguments) {
          state.arguments += call.function.arguments;
          if (state.started) yield { type: "tool_call_delta", id: state.id, arguments: call.function.arguments };
        }
      }
    }
    if (rec.usage) {
      yield {
        type: "usage",
        usage: {
          inputTokens: rec.usage.prompt_tokens ?? 0,
          outputTokens: rec.usage.completion_tokens ?? 0,
          cachedTokens: rec.usage.prompt_tokens_details?.cached_tokens,
        },
      };
    }
    if (choice?.finish_reason) {
      for (const call of pending.values()) {
        if (call.started) yield { type: "tool_call_end", id: call.id };
      }
      pending.clear();
    }
  }
  yield { type: "done" };
}

export function openaiChatAdapter(): Adapter {
  return {
    name: "openai-chat",
    buildRequest(parsed: ParsedRequest, provider: ResolvedProvider): AdapterRequest {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...provider.headers,
      };
      if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
      return {
        url: joinUrl(provider.baseUrl, "chat/completions"),
        method: "POST",
        headers,
        body: JSON.stringify(toChatBody(parsed, provider.model.id)),
      };
    },
    parseStream: parseChatStream,
  };
}
