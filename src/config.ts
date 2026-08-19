import fs from "node:fs";
import type { AdapterId, ModelConfig, ProviderConfig, ProxyConfig, ReasoningEffort } from "./types.ts";

const ADAPTERS = new Set<AdapterId>(["openai-chat", "anthropic", "openai-responses"]);
const EFFORTS = new Set<ReasoningEffort>(["none", "low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_LISTEN = "127.0.0.1:18789";

export function parseListen(listen: string): { hostname: string; port: number } {
  const trimmed = listen.trim();
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid listen address '${listen}'. Use host:port, e.g. 127.0.0.1:18789`);
  }
  const hostname = match[1] ?? match[2] ?? "127.0.0.1";
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port in listen address '${listen}'`);
  }
  return { hostname, port };
}

export function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

function parseModel(raw: unknown, index: number): ModelConfig {
  if (typeof raw === "string") {
    const id = raw.trim();
    if (!id) throw new Error(`models[${index}] is empty`);
    return { id };
  }
  const rec = asRecord(raw, `models[${index}]`);
  const id = optionalString(rec.id, `models[${index}].id`);
  if (!id) throw new Error(`models[${index}].id is required`);
  const reasoningLevels = Array.isArray(rec.reasoningLevels)
    ? rec.reasoningLevels.map((level, i) => {
        if (typeof level !== "string" || !EFFORTS.has(level as ReasoningEffort)) {
          throw new Error(`models[${index}].reasoningLevels[${i}] is not a valid effort`);
        }
        return level as ReasoningEffort;
      })
    : undefined;
  return {
    id,
    displayName: optionalString(rec.displayName, `models[${index}].displayName`),
    description: optionalString(rec.description, `models[${index}].description`),
    contextWindow: optionalNumber(rec.contextWindow, `models[${index}].contextWindow`),
    reasoning: typeof rec.reasoning === "boolean" ? rec.reasoning : undefined,
    reasoningLevels,
  };
}

function parseHeaders(raw: unknown, label: string): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const rec = asRecord(raw, label);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
    headers[key] = value;
  }
  return headers;
}

function parseProvider(id: string, raw: unknown): ProviderConfig {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw new Error(`Provider id '${id}' must match [a-z0-9][a-z0-9_-]{0,63}`);
  }
  const rec = asRecord(raw, `providers.${id}`);
  const adapter = optionalString(rec.adapter, `providers.${id}.adapter`);
  if (!adapter || !ADAPTERS.has(adapter as AdapterId)) {
    throw new Error(
      `providers.${id}.adapter must be one of ${[...ADAPTERS].join(", ")}`,
    );
  }
  const baseUrl = optionalString(rec.baseUrl, `providers.${id}.baseUrl`);
  if (!baseUrl) throw new Error(`providers.${id}.baseUrl is required`);
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(`providers.${id}.baseUrl is not a valid http(s) URL`);
  }
  if (!Array.isArray(rec.models) || rec.models.length === 0) {
    throw new Error(`providers.${id}.models must be a non-empty array`);
  }
  return {
    adapter: adapter as AdapterId,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: optionalString(rec.apiKey, `providers.${id}.apiKey`),
    apiKeyEnv: optionalString(rec.apiKeyEnv, `providers.${id}.apiKeyEnv`),
    headers: parseHeaders(rec.headers, `providers.${id}.headers`),
    models: rec.models.map((model, index) => parseModel(model, index)),
    defaultModel: optionalString(rec.defaultModel, `providers.${id}.defaultModel`),
  };
}

export function parseConfig(raw: unknown): ProxyConfig {
  const rec = asRecord(raw, "config");
  const listen = optionalString(rec.listen, "listen") ?? DEFAULT_LISTEN;
  parseListen(listen);
  const providersRaw = asRecord(rec.providers, "providers");
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, value] of Object.entries(providersRaw)) {
    providers[id] = parseProvider(id, value);
  }
  if (Object.keys(providers).length === 0) {
    throw new Error("config.providers must contain at least one provider");
  }
  const defaultProvider = optionalString(rec.defaultProvider, "defaultProvider");
  if (defaultProvider && !providers[defaultProvider]) {
    throw new Error(`defaultProvider '${defaultProvider}' is not defined`);
  }
  return {
    listen,
    defaultProvider,
    defaultModel: optionalString(rec.defaultModel, "defaultModel"),
    token: optionalString(rec.token, "token"),
    providers,
  };
}

export function loadConfig(filePath: string): ProxyConfig {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        `Missing config at ${filePath}. Run \`codex-proxy init\` and add a provider.`,
      );
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${(error as Error).message}`);
  }
  return parseConfig(json);
}

export function exampleConfig(): ProxyConfig {
  return {
    listen: DEFAULT_LISTEN,
    defaultProvider: "openrouter",
    defaultModel: "openrouter/anthropic/claude-sonnet-4.6",
    providers: {
      openrouter: {
        adapter: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "${OPENROUTER_API_KEY}",
        models: [
          {
            id: "anthropic/claude-sonnet-4.6",
            displayName: "Claude Sonnet 4.6",
            description: "Anthropic Claude via OpenRouter",
            contextWindow: 200000,
            reasoning: true,
          },
          {
            id: "google/gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            description: "Google Gemini via OpenRouter",
            contextWindow: 1000000,
          },
          {
            id: "deepseek/deepseek-chat",
            displayName: "DeepSeek V3",
            description: "DeepSeek via OpenRouter",
            contextWindow: 128000,
          },
        ],
      },
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "${ANTHROPIC_API_KEY}",
        models: [
          {
            id: "claude-sonnet-4-6",
            displayName: "Claude Sonnet 4.6 (direct)",
            contextWindow: 200000,
            reasoning: true,
          },
        ],
      },
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        apiKey: "${XAI_API_KEY}",
        models: [
          {
            id: "grok-4",
            displayName: "Grok 4",
            contextWindow: 256000,
            reasoning: true,
          },
        ],
      },
      ollama: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:11434/v1",
        models: [
          {
            id: "llama3.2",
            displayName: "Llama 3.2 (Ollama)",
            contextWindow: 128000,
          },
        ],
      },
    },
  };
}
