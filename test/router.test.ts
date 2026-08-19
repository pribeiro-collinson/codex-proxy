import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { defaultSlug, routeModel } from "../src/router.ts";

const config = parseConfig({
  defaultProvider: "openrouter",
  defaultModel: "openrouter/anthropic/claude-sonnet-4.6",
  providers: {
    openrouter: {
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "${OPENROUTER_API_KEY}",
      models: [
        { id: "anthropic/claude-sonnet-4.6", displayName: "Claude" },
        { id: "google/gemini-2.5-pro" },
      ],
    },
    xai: {
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "xai-live",
      models: [{ id: "grok-4" }],
    },
  },
});

describe("routeModel", () => {
  test("matches a provider/model slug including inner slashes", () => {
    const route = routeModel("openrouter/anthropic/claude-sonnet-4.6", config, {
      OPENROUTER_API_KEY: "or-key",
    });
    expect(route.id).toBe("openrouter");
    expect(route.model.id).toBe("anthropic/claude-sonnet-4.6");
    expect(route.apiKey).toBe("or-key");
  });

  test("matches a unique bare model id", () => {
    const route = routeModel("grok-4", config, {});
    expect(route.slug).toBe("xai/grok-4");
    expect(route.apiKey).toBe("xai-live");
  });

  test("rejects unknown models", () => {
    expect(() => routeModel("nope", config, {})).toThrow("Unknown model");
  });

  test("defaultSlug uses configured default", () => {
    expect(defaultSlug(config)).toBe("openrouter/anthropic/claude-sonnet-4.6");
  });
});
