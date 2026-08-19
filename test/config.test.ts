import { describe, expect, test } from "bun:test";
import { exampleConfig, parseConfig, parseListen } from "../src/config.ts";
import { resolveSecret } from "../src/env.ts";

describe("parseConfig", () => {
  test("accepts the bundled example", () => {
    const config = parseConfig(exampleConfig());
    expect(config.listen).toBe("127.0.0.1:18789");
    expect(Object.keys(config.providers)).toContain("openrouter");
  });

  test("rejects an unknown adapter", () => {
    expect(() =>
      parseConfig({
        providers: {
          x: { adapter: "nope", baseUrl: "https://api.example.com", models: ["m"] },
        },
      }),
    ).toThrow("adapter");
  });
});

describe("parseListen", () => {
  test("splits host and port", () => {
    expect(parseListen("127.0.0.1:18789")).toEqual({ hostname: "127.0.0.1", port: 18789 });
  });
});

describe("resolveSecret", () => {
  test("expands ${ENV}", () => {
    expect(resolveSecret("${FOO}", { FOO: "abc" })).toBe("abc");
    expect(resolveSecret("$FOO", { FOO: "abc" })).toBe("abc");
    expect(resolveSecret("literal", {})).toBe("literal");
    expect(resolveSecret("${MISSING}", {})).toBeUndefined();
  });
});
