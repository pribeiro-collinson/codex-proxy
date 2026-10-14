import { getAdapter, isPassthrough } from "./adapters/index.ts";
import { isLoopback, parseListen } from "./config.ts";
import { COMPACT_PROMPT, buildCompactV1Output, extractUserTexts } from "./responses/compact.ts";
import { bridgeEvents, collectText } from "./responses/bridge.ts";
import { parseResponsesRequest } from "./responses/parse.ts";
import { parseSse, sse, sseComment } from "./responses/sse.ts";
import { id } from "./ids.ts";
import { listSlugs, routeModel, routeModelMultimodal } from "./router.ts";
import type { AdapterEvent, FetchFn, ParsedRequest, ProxyConfig, ResolvedProvider } from "./types.ts";

export const VERSION = "0.1.0";

const HEARTBEAT_MS = 2000;

function json(data: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(`${JSON.stringify(data)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

function errorPayload(message: string, status = 400): Record<string, unknown> {
  return { error: { message, type: "codex_proxy_error", code: status } };
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}

function authorized(request: Request, token: string | undefined, loopback: boolean): boolean {
  if (!token) return loopback;
  const header =
    request.headers.get("x-codex-proxy-key") ??
    request.headers.get("x-api-key") ??
    request.headers.get("authorization");
  if (!header) return false;
  const value = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header.trim();
  return value === token;
}

function heartbeatStream(source: AsyncIterable<string>, abort: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream({
    async start(controller) {
      const ping = () => {
        try {
          controller.enqueue(encoder.encode(sseComment("codex-proxy heartbeat")));
        } catch {
          if (timer) clearInterval(timer);
        }
      };
      timer = setInterval(ping, HEARTBEAT_MS);
      try {
        for await (const chunk of source) {
          if (abort.aborted) break;
          controller.enqueue(encoder.encode(chunk));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        try {
          controller.enqueue(
            encoder.encode(
              sse("response.failed", {
                type: "response.failed",
                response: {
                  id: id("resp"),
                  object: "response",
                  status: "failed",
                  error: { code: "proxy_error", message: (error as Error).message },
                },
              }),
            ),
          );
          controller.close();
        } catch {
          controller.error(error);
        }
      } finally {
        if (timer) clearInterval(timer);
      }
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
}

async function* failedEvents(message: string, status?: number): AsyncGenerator<AdapterEvent> {
  yield { type: "error", message, status };
}

async function* pipeUpstreamSse(response: Response): AsyncGenerator<string> {
  for await (const block of parseSse(response.body)) {
    if (block.event) yield `event: ${block.event}\ndata: ${block.data}\n\n`;
    else yield `data: ${block.data}\n\n`;
  }
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

async function upstreamErrorText(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? text.slice(0, 2000) ?? `HTTP ${response.status}`;
  } catch {
    return text.slice(0, 2000) || `HTTP ${response.status}`;
  }
}

function prepareParsed(parsed: ParsedRequest): ParsedRequest {
  if (!parsed.compactionV2) return parsed;
  return {
    ...parsed,
    tools: [],
    toolChoice: "none",
    messages: [
      { role: "system", content: [{ type: "text", text: COMPACT_PROMPT }] },
      ...parsed.messages,
    ],
  };
}

async function runAdapter(
  parsed: ParsedRequest,
  provider: ResolvedProvider,
  fetchFn: FetchFn,
  abort: AbortSignal,
): Promise<{ response: Response; provider: ResolvedProvider }> {
  const adapter = getAdapter(provider.adapter);
  const request = adapter.buildRequest(parsed, provider);
  const response = await fetchFn(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: abort,
  });
  return { response, provider };
}

export function createHandler(
  config: ProxyConfig,
  options: { fetch?: FetchFn; startedAt?: number } = {},
): (request: Request) => Promise<Response> {
  const fetchFn = options.fetch ?? fetch;
  const startedAt = options.startedAt ?? Date.now();
  const listen = parseListen(config.listen);
  const loopback = isLoopback(listen.hostname);
  const token = config.token ?? process.env.CODEX_PROXY_TOKEN?.trim();

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/healthz" || path === "/health") {
      return json({
        status: "ok",
        service: "codex-proxy",
        version: VERSION,
        uptime: Math.round((Date.now() - startedAt) / 1000),
      });
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return new Response("WebSockets disabled; Codex should fall back to HTTP SSE.\n", {
        status: 426,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (!authorized(request, token, loopback)) {
      return json(errorPayload("Unauthorized", 401), 401);
    }

    if (path === "/v1/models" && request.method === "GET") {
      const models = listSlugs(config).map((id) => ({ id, object: "model", owned_by: "codex-proxy" }));
      return json({ object: "list", data: models });
    }

    if (path === "/v1/responses/compact" && request.method === "POST") {
      try {
        const body = await readJson(request);
        const parsed = prepareParsed({
          ...parseResponsesRequest(body),
          tools: [],
          toolChoice: "none",
          compactionV2: false,
          stream: true,
        });
        parsed.messages = [
          { role: "system", content: [{ type: "text", text: COMPACT_PROMPT }] },
          ...parsed.messages.filter((message) => message.role !== "system"),
        ];
        const provider = routeModelMultimodal(parsed.model, config, process.env, parsed.messages);
        const adapter = getAdapter(provider.adapter);
        const { response } = await runAdapter(parsed, provider, fetchFn, request.signal);
        if (!response.ok) {
          return json(errorPayload(await upstreamErrorText(response), response.status), response.status);
        }
        const collected = await collectText(adapter.parseStream(response));
        if (collected.error) return json(errorPayload(collected.error, 502), 502);
        const rec = body && typeof body === "object" ? (body as { input?: unknown }) : {};
        return json({
          object: "response.compaction",
          model: provider.slug,
          output: buildCompactV1Output(extractUserTexts(rec.input), collected.text),
        });
      } catch (error) {
        return json(errorPayload((error as Error).message, 400), 400);
      }
    }

    if (path === "/v1/responses" && request.method === "POST") {
      const abort = request.signal;
      try {
        const body = await readJson(request);
        const parsed = prepareParsed(parseResponsesRequest(body));
        const provider = routeModelMultimodal(parsed.model, config, process.env, parsed.messages);
        if (!provider.apiKey && provider.adapter !== "openai-chat") {
          return json(
            errorPayload(
              `Provider '${provider.id}' has no API key. Set apiKey or apiKeyEnv in config.json.`,
              401,
            ),
            401,
          );
        }
        const adapter = getAdapter(provider.adapter);
        const { response } = await runAdapter(parsed, provider, fetchFn, abort);
        if (!response.ok) {
          const message = await upstreamErrorText(response);
          if (!parsed.stream) return json(errorPayload(message, response.status), response.status);
          return sseResponse(
            heartbeatStream(bridgeEvents(parsed, failedEvents(message, response.status)), abort),
          );
        }
        if (isPassthrough(provider.adapter) && parsed.stream) {
          return sseResponse(heartbeatStream(pipeUpstreamSse(response), abort));
        }
        if (!parsed.stream) {
          const chunks: string[] = [];
          for await (const chunk of bridgeEvents(parsed, adapter.parseStream(response))) chunks.push(chunk);
          const completed = chunks.reverse().find((chunk) => chunk.includes("response.completed"));
          if (!completed) return json(errorPayload("Upstream returned no completion", 502), 502);
          const dataLine = completed.split("\n").find((line) => line.startsWith("data:"));
          const payload = dataLine ? JSON.parse(dataLine.slice(5).trim()) : {};
          return json((payload as { response?: unknown }).response ?? payload);
        }
        return sseResponse(heartbeatStream(bridgeEvents(parsed, adapter.parseStream(response)), abort));
      } catch (error) {
        const message = (error as Error).message;
        const status = message.startsWith("Unknown model") ? 404 : 400;
        return json(errorPayload(message, status), status);
      }
    }

    return json(errorPayload(`Not found: ${request.method} ${path}`, 404), 404);
  };
}

export function serve(
  config: ProxyConfig,
  options: { fetch?: FetchFn } = {},
): { server: ReturnType<typeof Bun.serve>; url: string } {
  const listen = parseListen(config.listen);
  if (!isLoopback(listen.hostname)) {
    const token = config.token ?? process.env.CODEX_PROXY_TOKEN?.trim();
    if (!token) {
      throw new Error("Refusing to bind beyond loopback without config.token or CODEX_PROXY_TOKEN");
    }
  }
  const handler = createHandler(config, options);
  const server = Bun.serve({
    hostname: listen.hostname,
    port: listen.port,
    idleTimeout: 255,
    fetch: handler,
  });
  const url = `http://${listen.hostname === "0.0.0.0" ? "127.0.0.1" : listen.hostname}:${server.port}`;
  return { server, url };
}
