import { encodeCompactionSummary } from "./compact.ts";
import { sse } from "./sse.ts";
import { id, nowSeconds } from "../ids.ts";
import type { AdapterEvent, ParsedRequest, ToolCallKind, Usage } from "../types.ts";

type OutputItem = Record<string, unknown>;

function responseShell(opts: {
  responseId: string;
  model: string;
  status: string;
  output: OutputItem[];
  usage?: Usage;
  error?: { code: string; message: string };
}): Record<string, unknown> {
  return {
    id: opts.responseId,
    object: "response",
    created_at: nowSeconds(),
    status: opts.status,
    model: opts.model,
    output: opts.output,
    usage: opts.usage
      ? {
          input_tokens: opts.usage.inputTokens,
          output_tokens: opts.usage.outputTokens,
          total_tokens: opts.usage.inputTokens + opts.usage.outputTokens,
          input_tokens_details: opts.usage.cachedTokens
            ? { cached_tokens: opts.usage.cachedTokens }
            : undefined,
        }
      : undefined,
    error: opts.error ?? null,
  };
}

function unwrapCustomInput(name: string, args: string, customNames: Set<string>): {
  kind: ToolCallKind;
  input: string;
} {
  if (!customNames.has(name)) return { kind: "function", input: args };
  try {
    const parsed = JSON.parse(args) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (typeof rec.input === "string") return { kind: "custom", input: rec.input };
    }
  } catch {
    // raw patch / freeform payload
  }
  return { kind: "custom", input: args };
}

export async function* bridgeEvents(
  parsed: ParsedRequest,
  events: AsyncIterable<AdapterEvent> | AdapterEvent[],
  responseId = id("resp"),
): AsyncGenerator<string> {
  const model = parsed.model;
  const output: OutputItem[] = [];
  let usage: Usage | undefined;
  let failed: { code: string; message: string } | undefined;

  const created = responseShell({ responseId, model, status: "in_progress", output: [] });
  yield sse("response.created", { type: "response.created", response: created });
  yield sse("response.in_progress", { type: "response.in_progress", response: created });

  if (parsed.compactionV2) {
    let summary = "";
    for await (const event of events) {
      if (event.type === "text_delta") summary += event.text;
      else if (event.type === "error") failed = { code: "upstream_error", message: event.message };
      else if (event.type === "usage") usage = event.usage;
    }
    if (failed) {
      const response = responseShell({
        responseId,
        model,
        status: "failed",
        output,
        error: failed,
      });
      yield sse("response.failed", { type: "response.failed", response });
      return;
    }
    const item = {
      id: id("cmp"),
      type: "compaction",
      encrypted_content: encodeCompactionSummary(summary.trim()),
    };
    yield sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item,
    });
    yield sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item,
    });
    const response = responseShell({
      responseId,
      model,
      status: "completed",
      output: [item],
      usage,
    });
    yield sse("response.completed", { type: "response.completed", response });
    return;
  }

  type OpenMessage = {
    kind: "message";
    id: string;
    index: number;
    text: string;
  };
  type OpenReasoning = {
    kind: "reasoning";
    id: string;
    index: number;
    text: string;
  };
  type OpenTool = {
    kind: "tool";
    id: string;
    index: number;
    callId: string;
    name: string;
    toolKind: ToolCallKind;
    arguments: string;
  };
  let open: OpenMessage | OpenReasoning | OpenTool | undefined;

  const closeOpen = function* (): Generator<string> {
    if (!open) return;
    if (open.kind === "message") {
      const item = {
        id: open.id,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: open.text, annotations: [] }],
      };
      yield sse("response.output_text.done", {
        type: "response.output_text.done",
        item_id: open.id,
        output_index: open.index,
        content_index: 0,
        text: open.text,
      });
      yield sse("response.content_part.done", {
        type: "response.content_part.done",
        item_id: open.id,
        output_index: open.index,
        content_index: 0,
        part: item.content[0],
      });
      yield sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: open.index,
        item,
      });
      output.push(item);
    } else if (open.kind === "reasoning") {
      const item = {
        id: open.id,
        type: "reasoning",
        summary: [{ type: "summary_text", text: open.text }],
      };
      yield sse("response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        item_id: open.id,
        output_index: open.index,
        text: open.text,
      });
      yield sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: open.index,
        item,
      });
      output.push(item);
    } else {
      const item =
        open.toolKind === "custom"
          ? {
              id: open.id,
              type: "custom_tool_call",
              status: "completed",
              call_id: open.callId,
              name: open.name,
              input: open.arguments,
            }
          : {
              id: open.id,
              type: "function_call",
              status: "completed",
              call_id: open.callId,
              name: open.name,
              arguments: open.arguments,
            };
      if (open.toolKind === "custom") {
        yield sse("response.custom_tool_call_input.done", {
          type: "response.custom_tool_call_input.done",
          item_id: open.id,
          output_index: open.index,
          input: open.arguments,
        });
      } else {
        yield sse("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: open.id,
          output_index: open.index,
          arguments: open.arguments,
        });
      }
      yield sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: open.index,
        item,
      });
      output.push(item);
    }
    open = undefined;
  };

  const ensureMessage = function* (): Generator<string> {
    if (open?.kind === "message") return;
    yield* closeOpen();
    const itemId = id("msg");
    const index = output.length;
    open = { kind: "message", id: itemId, index, text: "" };
    yield sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: index,
      item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    yield sse("response.content_part.added", {
      type: "response.content_part.added",
      item_id: itemId,
      output_index: index,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  };

  const ensureReasoning = function* (): Generator<string> {
    if (open?.kind === "reasoning") return;
    yield* closeOpen();
    const itemId = id("rs");
    const index = output.length;
    open = { kind: "reasoning", id: itemId, index, text: "" };
    yield sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: index,
      item: { id: itemId, type: "reasoning", summary: [] },
    });
  };

  for await (const event of events) {
    switch (event.type) {
      case "text_delta": {
        yield* ensureMessage();
        if (open?.kind !== "message") break;
        open.text += event.text;
        yield sse("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: open.id,
          output_index: open.index,
          content_index: 0,
          delta: event.text,
        });
        break;
      }
      case "thinking_delta": {
        yield* ensureReasoning();
        if (open?.kind !== "reasoning") break;
        open.text += event.text;
        yield sse("response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          item_id: open.id,
          output_index: open.index,
          delta: event.text,
        });
        break;
      }
      case "tool_call_start": {
        yield* closeOpen();
        const unwrapped = unwrapCustomInput(event.name, "", parsed.customToolNames);
        const kind: ToolCallKind = parsed.customToolNames.has(event.name) ? "custom" : event.kind;
        const itemId = id(kind === "custom" ? "ctc" : "fc");
        const index = output.length;
        open = {
          kind: "tool",
          id: itemId,
          index,
          callId: event.id,
          name: event.name,
          toolKind: kind,
          arguments: unwrapped.input,
        };
        const item =
          kind === "custom"
            ? {
                id: itemId,
                type: "custom_tool_call",
                status: "in_progress",
                call_id: event.id,
                name: event.name,
                input: "",
              }
            : {
                id: itemId,
                type: "function_call",
                status: "in_progress",
                call_id: event.id,
                name: event.name,
                arguments: "",
              };
        yield sse("response.output_item.added", {
          type: "response.output_item.added",
          output_index: index,
          item,
        });
        break;
      }
      case "tool_call_delta": {
        if (open?.kind !== "tool") break;
        open.arguments += event.arguments;
        if (open.toolKind === "custom") {
          yield sse("response.custom_tool_call_input.delta", {
            type: "response.custom_tool_call_input.delta",
            item_id: open.id,
            output_index: open.index,
            delta: event.arguments,
          });
        } else {
          yield sse("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            item_id: open.id,
            output_index: open.index,
            delta: event.arguments,
          });
        }
        break;
      }
      case "tool_call_end": {
        if (open?.kind === "tool") {
          const unwrapped = unwrapCustomInput(open.name, open.arguments, parsed.customToolNames);
          open.toolKind = unwrapped.kind;
          open.arguments = unwrapped.input;
        }
        yield* closeOpen();
        break;
      }
      case "usage":
        usage = event.usage;
        break;
      case "error":
        failed = { code: "upstream_error", message: event.message };
        break;
      case "done":
        break;
    }
    if (failed) break;
  }

  yield* closeOpen();

  if (failed) {
    const response = responseShell({
      responseId,
      model,
      status: "failed",
      output,
      usage,
      error: failed,
    });
    yield sse("response.failed", { type: "response.failed", response });
    return;
  }

  const response = responseShell({
    responseId,
    model,
    status: "completed",
    output,
    usage,
  });
  yield sse("response.completed", { type: "response.completed", response });
}

export async function collectText(events: AsyncIterable<AdapterEvent>): Promise<{
  text: string;
  error?: string;
}> {
  let text = "";
  let error: string | undefined;
  for await (const event of events) {
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "error") error = event.message;
  }
  return { text, error };
}
