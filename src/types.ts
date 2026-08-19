export type AdapterId = "openai-chat" | "anthropic" | "openai-responses";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string };

export type ToolCallKind = "function" | "custom";

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
  kind: ToolCallKind;
};

export type Message =
  | { role: "system" | "user"; content: ContentPart[] }
  | { role: "assistant"; content: ContentPart[]; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name?: string; content: string };

export type Tool =
  | {
      type: "function";
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }
  | { type: "custom"; name: string; description?: string };

export type ParsedRequest = {
  model: string;
  instructions?: string;
  messages: Message[];
  tools: Tool[];
  customToolNames: Set<string>;
  toolChoice: "auto" | "none" | "required" | { name: string };
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  temperature?: number;
  jsonSchema?: unknown;
  previousResponseId?: string;
  stream: boolean;
  compactionV2: boolean;
  raw: Record<string, unknown>;
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
};

export type AdapterEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string; kind: ToolCallKind }
  | { type: "tool_call_delta"; id: string; arguments: string }
  | { type: "tool_call_end"; id: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; stopReason?: string }
  | { type: "error"; message: string; status?: number };

export type ModelConfig = {
  id: string;
  displayName?: string;
  description?: string;
  contextWindow?: number;
  reasoning?: boolean;
  reasoningLevels?: ReasoningEffort[];
};

export type ProviderConfig = {
  adapter: AdapterId;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  models: ModelConfig[];
  defaultModel?: string;
};

export type ProxyConfig = {
  listen: string;
  defaultProvider?: string;
  defaultModel?: string;
  token?: string;
  providers: Record<string, ProviderConfig>;
};

export type ResolvedProvider = {
  id: string;
  adapter: AdapterId;
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string>;
  model: ModelConfig;
  slug: string;
};

export type AdapterRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

export type Adapter = {
  name: AdapterId;
  buildRequest(parsed: ParsedRequest, provider: ResolvedProvider): AdapterRequest;
  parseStream(response: Response): AsyncGenerator<AdapterEvent>;
};

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
