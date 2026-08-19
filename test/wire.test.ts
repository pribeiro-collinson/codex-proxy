import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.ts";
import { MARKER_BEGIN, unwireCodex, wireCodex } from "../src/wire.ts";
import type { Paths } from "../src/paths.ts";

function tempPaths(): Paths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-"));
  const home = path.join(root, "proxy");
  const codexHome = path.join(root, "codex");
  return {
    home,
    config: path.join(home, "config.json"),
    catalog: path.join(home, "catalog.json"),
    pid: path.join(home, "proxy.pid"),
    wireState: path.join(home, "wire-state.json"),
    codexHome,
    codexConfig: path.join(codexHome, "config.toml"),
  };
}

const config = parseConfig({
  listen: "127.0.0.1:18789",
  defaultProvider: "xai",
  providers: {
    xai: {
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "k",
      models: [{ id: "grok-4", displayName: "Grok 4", contextWindow: 256000 }],
    },
  },
});

describe("wireCodex", () => {
  test("injects marked root keys before existing tables and restores them", () => {
    const paths = tempPaths();
    fs.mkdirSync(paths.codexHome, { recursive: true });
    fs.writeFileSync(
      paths.codexConfig,
      [
        'model = "gpt-5.6-sol"',
        'approval_policy = "on-request"',
        "",
        "[features]",
        "fast_mode = true",
        "",
      ].join("\n"),
    );

    const wired = wireCodex(paths, config);
    const text = fs.readFileSync(paths.codexConfig, "utf8");
    expect(text.startsWith(MARKER_BEGIN)).toBe(true);
    expect(text).toContain('model = "xai/grok-4"');
    expect(text).toContain("openai_base_url = \"http://127.0.0.1:18789/v1\"");
    expect(text).toContain("[features]");
    expect(text.indexOf(MARKER_BEGIN)).toBeLessThan(text.indexOf("[features]"));
    expect(wired.model).toBe("xai/grok-4");

    const catalog = JSON.parse(fs.readFileSync(paths.catalog, "utf8")) as {
      models: Array<{ slug: string; visibility: string; supported_in_api: boolean }>;
    };
    expect(catalog.models[0]).toMatchObject({
      slug: "xai/grok-4",
      visibility: "list",
      supported_in_api: true,
    });

    unwireCodex(paths);
    const restored = fs.readFileSync(paths.codexConfig, "utf8");
    expect(restored).not.toContain(MARKER_BEGIN);
    expect(restored).toContain('model = "gpt-5.6-sol"');
    expect(restored).toContain("[features]");
    expect(restored).not.toContain("openai_base_url");
  });

  test("is idempotent when wired twice", () => {
    const paths = tempPaths();
    wireCodex(paths, config);
    wireCodex(paths, config);
    const text = fs.readFileSync(paths.codexConfig, "utf8");
    expect(text.split(MARKER_BEGIN).length).toBe(2);
  });
});
