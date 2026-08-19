import { joinUrl } from "../env.ts";
import { parseSse } from "../responses/sse.ts";
import type { Adapter, AdapterEvent, AdapterRequest, ParsedRequest, ResolvedProvider } from "../types.ts";

function rewriteModel(body: Record<string, unknown>, model: string): string {
  return JSON.stringify({ ...body, model, stream: true });
}

async function* parseResponsesStream(response: Response): AsyncGenerator<AdapterEvent> {
  // Passthrough adapter is used as a fallback translator when piping is not available.
  for await (const block of parseSse(response.body)) {
    if (block.data === "[DONE]") {
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
    const rec = json as { type?: string; delta?: string; text?: string; response?: { error?: { message?: string }; usage?: { input_tokens?: number; output_tokens?: number } } };
    switch (rec.type) {
      case "response.output_text.delta":
        if (rec.delta) yield { type: "text_delta", text: rec.delta };
        break;
      case "response.reasoning_summary_text.delta":
        if (rec.delta) yield { type: "thinking_delta", text: rec.delta };
        break;
      case "response.failed":
        yield {
          type: "error",
          message: rec.response?.error?.message ?? "Upstream Responses request failed",
          status: response.status,
        };
        return;
      case "response.completed":
        if (rec.response?.usage) {
          yield {
            type: "usage",
            usage: {
              inputTokens: rec.response.usage.input_tokens ?? 0,
              outputTokens: rec.response.usage.output_tokens ?? 0,
            },
          };
        }
        yield { type: "done" };
        return;
    }
  }
  yield { type: "done" };
}

export function openaiResponsesAdapter(): Adapter {
  return {
    name: "openai-responses",
    buildRequest(parsed: ParsedRequest, provider: ResolvedProvider): AdapterRequest {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...provider.headers,
      };
      if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
      return {
        url: joinUrl(provider.baseUrl, "responses"),
        method: "POST",
        headers,
        body: rewriteModel(parsed.raw, provider.model.id),
      };
    },
    parseStream: parseResponsesStream,
  };
}

export function isPassthrough(adapter: string): boolean {
  return adapter === "openai-responses";
}
