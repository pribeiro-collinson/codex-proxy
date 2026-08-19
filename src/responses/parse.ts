import { COMPACTION_PREFIX, decodeCompactionSummary, SUMMARY_PREFIX } from "./compact.ts";
import type {
  ContentPart,
  Message,
  ParsedRequest,
  ReasoningEffort,
  Tool,
  ToolCall,
} from "../types.ts";

const HOSTED_TOOLS = new Set([
  "web_search",
  "web_search_preview",
  "file_search",
  "computer",
  "computer_use",
  "image_generation",
  "image_gen",
  "code_interpreter",
  "mcp",
]);

const EFFORTS = new Set<ReasoningEffort>(["none", "low", "medium", "high", "xhigh", "max"]);

function rec(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function textFromParts(content: unknown): ContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: ContentPart[] = [];
  for (const part of content) {
    const item = rec(part);
    if (!item) continue;
    const type = str(item.type);
    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = str(item.text);
      if (text) parts.push({ type: "text", text });
      continue;
    }
    if (type === "input_image" || type === "image_url" || type === "image") {
      const url =
        str(item.image_url) ||
        str(rec(item.image_url)?.url) ||
        str(item.url) ||
        (str(item.b64_json) ? `data:${str(item.mime_type) ?? "image/png"};base64,${item.b64_json}` : undefined);
      if (url) parts.push({ type: "image", url });
    }
  }
  return parts;
}

function parseEffort(raw: unknown): ReasoningEffort | undefined {
  const fromObject = rec(raw);
  const value = fromObject ? str(fromObject.effort) ?? str(fromObject.summary) : str(raw);
  if (!value) return undefined;
  const normalized = value.toLowerCase() as ReasoningEffort;
  return EFFORTS.has(normalized) ? normalized : undefined;
}

function namespacedName(item: Record<string, unknown>, fallback: string): string {
  const namespace = str(item.namespace);
  const name = str(item.name) ?? fallback;
  if (!namespace) return name;
  return `${namespace.replaceAll(".", "__")}__${name}`;
}

function parseTools(raw: unknown): { tools: Tool[]; customToolNames: Set<string> } {
  const tools: Tool[] = [];
  const customToolNames = new Set<string>();
  if (!Array.isArray(raw)) return { tools, customToolNames };
  for (const entry of raw) {
    const item = rec(entry);
    if (!item) continue;
    const type = str(item.type) ?? "function";
    if (HOSTED_TOOLS.has(type)) continue;
    if (type === "custom") {
      const name = str(item.name);
      if (!name) continue;
      tools.push({ type: "custom", name, description: str(item.description) });
      customToolNames.add(name);
      continue;
    }
    if (type === "function" || item.name || rec(item.function)) {
      const fn = rec(item.function) ?? item;
      const name = namespacedName(item, str(fn.name) ?? "");
      if (!name) continue;
      const parameters = rec(fn.parameters) ?? rec(item.parameters);
      tools.push({
        type: "function",
        name,
        description: str(fn.description) ?? str(item.description),
        parameters,
      });
    }
  }
  return { tools, customToolNames };
}

function parseToolChoice(
  raw: unknown,
): ParsedRequest["toolChoice"] {
  if (raw === "none" || raw === "required" || raw === "auto") return raw;
  const item = rec(raw);
  if (!item) return "auto";
  const type = str(item.type);
  if (type === "none" || type === "required" || type === "auto") return type;
  const name = str(item.name) ?? str(rec(item.function)?.name);
  if (name) return { name };
  return "auto";
}

function toolCallFromItem(item: Record<string, unknown>, kind: ToolCall["kind"]): ToolCall | undefined {
  const id = str(item.call_id) ?? str(item.id);
  const name = namespacedName(item, str(item.name) ?? "");
  if (!id || !name) return undefined;
  const argumentsText =
    kind === "custom"
      ? str(item.input) ?? str(item.arguments) ?? ""
      : str(item.arguments) ?? str(item.input) ?? "";
  return { id, name, arguments: argumentsText, kind };
}

function pushAssistantToolCalls(messages: Message[], calls: ToolCall[]): void {
  if (calls.length === 0) return;
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && (last.toolCalls?.length ?? 0) > 0 && last.content.length === 0) {
    last.toolCalls = [...(last.toolCalls ?? []), ...calls];
    return;
  }
  messages.push({ role: "assistant", content: [], toolCalls: calls });
}

function compactionToText(encrypted: string | undefined): string {
  const decoded = encrypted ? decodeCompactionSummary(encrypted) : null;
  if (decoded) return `${SUMMARY_PREFIX}\n\n${decoded}`;
  return "[earlier conversation was compacted]";
}

export function parseResponsesRequest(body: unknown): ParsedRequest {
  const recBody = rec(body);
  if (!recBody) throw new Error("Request body must be a JSON object");
  const model = str(recBody.model);
  if (!model) throw new Error("model is required");

  const messages: Message[] = [];
  const instructions = str(recBody.instructions);
  if (instructions) messages.push({ role: "system", content: [{ type: "text", text: instructions }] });

  let compactionV2 = false;
  const input = recBody.input;
  if (typeof input === "string") {
    if (input) messages.push({ role: "user", content: [{ type: "text", text: input }] });
  } else if (Array.isArray(input)) {
    for (const rawItem of input) {
      const item = rec(rawItem);
      if (!item) continue;
      const type = str(item.type) ?? "message";
      if (type === "compaction_trigger") {
        compactionV2 = true;
        continue;
      }
      if (type === "compaction") {
        const text = compactionToText(str(item.encrypted_content));
        messages.push({ role: "user", content: [{ type: "text", text }] });
        continue;
      }
      if (type === "message" || type === "input_message") {
        const roleRaw = str(item.role) ?? "user";
        const role = roleRaw === "developer" || roleRaw === "system" ? "system" : roleRaw === "assistant" ? "assistant" : "user";
        const content = textFromParts(item.content);
        if (role === "assistant") messages.push({ role: "assistant", content });
        else messages.push({ role, content });
        continue;
      }
      if (type === "function_call") {
        const call = toolCallFromItem(item, "function");
        if (call) pushAssistantToolCalls(messages, [call]);
        continue;
      }
      if (type === "custom_tool_call") {
        const call = toolCallFromItem(item, "custom");
        if (call) pushAssistantToolCalls(messages, [call]);
        continue;
      }
      if (type === "function_call_output" || type === "custom_tool_call_output") {
        const callId = str(item.call_id) ?? str(item.id);
        if (!callId) continue;
        const output =
          str(item.output) ??
          str(item.input) ??
          (item.output !== undefined ? JSON.stringify(item.output) : "");
        messages.push({ role: "tool", toolCallId: callId, name: str(item.name), content: output });
        continue;
      }
      if (type === "reasoning") {
        const encrypted = str(item.encrypted_content);
        if (encrypted?.startsWith(COMPACTION_PREFIX)) {
          const decoded = decodeCompactionSummary(encrypted);
          if (decoded) {
            messages.push({ role: "user", content: [{ type: "text", text: `${SUMMARY_PREFIX}\n\n${decoded}` }] });
          }
        }
      }
    }
  }

  const { tools, customToolNames } = parseTools(recBody.tools);
  const textFormat = rec(rec(recBody.text)?.format);
  const jsonSchema =
    textFormat && str(textFormat.type) === "json_schema"
      ? rec(textFormat.json_schema)?.schema ?? rec(textFormat.schema)
      : textFormat && str(textFormat.type) === "json_object"
        ? { type: "object" }
        : undefined;

  const maxTokens =
    typeof recBody.max_output_tokens === "number"
      ? recBody.max_output_tokens
      : typeof recBody.max_tokens === "number"
        ? recBody.max_tokens
        : undefined;

  return {
    model,
    instructions,
    messages,
    tools,
    customToolNames,
    toolChoice: parseToolChoice(recBody.tool_choice),
    reasoningEffort: parseEffort(recBody.reasoning) ?? parseEffort(recBody.reasoning_effort),
    maxTokens,
    temperature: typeof recBody.temperature === "number" ? recBody.temperature : undefined,
    jsonSchema,
    previousResponseId: str(recBody.previous_response_id),
    stream: recBody.stream !== false,
    compactionV2,
    raw: recBody,
  };
}

export function textOf(parts: ContentPart[]): string {
  return parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}
