import fs from "node:fs";
import path from "node:path";
import { buildCatalog } from "./catalog.ts";
import { defaultSlug } from "./router.ts";
import { toPosixPath, type Paths } from "./paths.ts";
import type { ProxyConfig } from "./types.ts";

export const MARKER_BEGIN = "# --- codex-proxy:begin ---";
export const MARKER_END = "# --- codex-proxy:end ---";

const MANAGED_KEYS = new Set(["model", "model_catalog_json", "openai_base_url"]);

export type WireState = {
  previous: Record<string, string | undefined>;
  catalogPath: string;
  baseUrl: string;
  model: string;
};

export type WireResult = {
  configPath: string;
  catalogPath: string;
  model: string;
  baseUrl: string;
};

function splitToml(source: string): { root: string; rest: string } {
  const lines = source.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && !trimmed.startsWith("[#")) {
      break;
    }
    index += 1;
  }
  return {
    root: lines.slice(0, index).join("\n"),
    rest: lines.slice(index).join("\n"),
  };
}

function stripMarkedBlock(source: string): string {
  const begin = source.indexOf(MARKER_BEGIN);
  const end = source.indexOf(MARKER_END);
  if (begin === -1 || end === -1 || end < begin) return source;
  const after = end + MARKER_END.length;
  const before = source.slice(0, begin).replace(/\n+$/, "\n");
  const tail = source.slice(after).replace(/^\n+/, "\n");
  return `${before}${tail}`.replace(/^\n+/, "").replace(/\n+$/, "\n");
}

function quoteToml(value: string): string {
  return JSON.stringify(value);
}

function parseRootKey(line: string): { key: string; value: string } | undefined {
  const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
  if (!match?.[1] || match[2] === undefined) return undefined;
  const key = match[1];
  if (!MANAGED_KEYS.has(key)) return undefined;
  let value = match[2];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function extractManagedKeys(root: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of root.split("\n")) {
    const parsed = parseRootKey(line);
    if (parsed) found[parsed.key] = parsed.value;
  }
  return found;
}

function dropManagedKeys(root: string): string {
  return root
    .split("\n")
    .filter((line) => !parseRootKey(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function loadWireState(filePath: string): WireState | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as WireState;
  } catch {
    return undefined;
  }
}

function writeFileAtomic(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { encoding: "utf8" });
  fs.renameSync(tmp, filePath);
}

export function proxyBaseUrl(listen: string): string {
  const host = listen.startsWith("[") ? listen : listen.replace(/^0\.0\.0\.0/, "127.0.0.1");
  return `http://${host}/v1`;
}

export function wireCodex(paths: Paths, config: ProxyConfig): WireResult {
  const catalog = buildCatalog(config);
  const catalogJson = `${JSON.stringify(catalog, null, 2)}\n`;
  writeFileAtomic(paths.catalog, catalogJson);

  const baseUrl = proxyBaseUrl(config.listen);
  const model = defaultSlug(config);
  const existing = fs.existsSync(paths.codexConfig) ? fs.readFileSync(paths.codexConfig, "utf8") : "";
  const stripped = stripMarkedBlock(existing);
  const { root, rest } = splitToml(stripped);
  const previous = extractManagedKeys(root);
  const cleanedRoot = dropManagedKeys(root).trimEnd();

  const block = [
    MARKER_BEGIN,
    `model = ${quoteToml(model)}`,
    `model_catalog_json = ${quoteToml(toPosixPath(paths.catalog))}`,
    `openai_base_url = ${quoteToml(baseUrl)}`,
    MARKER_END,
  ].join("\n");

  const next = [block, cleanedRoot, rest].filter((part) => part && part.trim().length > 0).join("\n\n");
  fs.mkdirSync(paths.codexHome, { recursive: true });
  writeFileAtomic(paths.codexConfig, next.endsWith("\n") ? next : `${next}\n`);
  writeFileAtomic(
    paths.wireState,
    `${JSON.stringify({ previous, catalogPath: paths.catalog, baseUrl, model } satisfies WireState, null, 2)}\n`,
  );

  return { configPath: paths.codexConfig, catalogPath: paths.catalog, model, baseUrl };
}

export function unwireCodex(paths: Paths): { restored: boolean } {
  if (!fs.existsSync(paths.codexConfig)) return { restored: false };
  const existing = fs.readFileSync(paths.codexConfig, "utf8");
  if (!existing.includes(MARKER_BEGIN)) return { restored: false };
  const stripped = stripMarkedBlock(existing);
  const { root, rest } = splitToml(stripped);
  const state = loadWireState(paths.wireState);
  const restoredLines: string[] = [];
  if (state?.previous) {
    for (const key of MANAGED_KEYS) {
      const value = state.previous[key];
      if (value !== undefined && value !== "") restoredLines.push(`${key} = ${quoteToml(value)}`);
    }
  }
  const next = [restoredLines.join("\n"), root.trimEnd(), rest]
    .filter((part) => part && part.trim().length > 0)
    .join("\n\n");
  writeFileAtomic(paths.codexConfig, next ? (next.endsWith("\n") ? next : `${next}\n`) : "");
  try {
    fs.unlinkSync(paths.wireState);
  } catch {
    // ignore
  }
  return { restored: true };
}

export function wireStatus(paths: Paths): {
  wired: boolean;
  model?: string;
  baseUrl?: string;
  catalogPath?: string;
} {
  if (!fs.existsSync(paths.codexConfig)) return { wired: false };
  const text = fs.readFileSync(paths.codexConfig, "utf8");
  if (!text.includes(MARKER_BEGIN)) return { wired: false };
  const state = loadWireState(paths.wireState);
  return {
    wired: true,
    model: state?.model,
    baseUrl: state?.baseUrl,
    catalogPath: state?.catalogPath,
  };
}
