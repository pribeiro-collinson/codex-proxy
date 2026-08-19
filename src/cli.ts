#!/usr/bin/env bun
import fs from "node:fs";
import { exampleConfig, loadConfig, parseListen } from "./config.ts";
import { resolveSecret } from "./env.ts";
import { resolvePaths, type Paths } from "./paths.ts";
import { clearPid, pidAlive, readPid, stopPid, writePid } from "./pid.ts";
import { defaultSlug, listSlugs } from "./router.ts";
import { serve, VERSION } from "./server.ts";
import { unwireCodex, wireCodex, wireStatus } from "./wire.ts";
import type { ProxyConfig } from "./types.ts";

const USAGE = `codex-proxy ${VERSION} — use any LLM with Codex Desktop / CLI

USAGE
  codex-proxy <command> [options]

COMMANDS
  init                 Write ~/.codex-proxy/config.json if it does not exist
  start                Wire Codex and serve on 127.0.0.1 (foreground)
  serve                Serve without touching Codex config
  stop                 Unwire Codex and stop a recorded pid
  wire                 Inject openai_base_url + model catalog into Codex
  unwire               Remove the injected Codex block
  status               Show proxy, wire, and default model
  doctor               Check config, keys, and Codex home
  models               List routed slugs (provider/model)

OPTIONS
  --port <n>           Override listen port
  --config <path>      Config file (default: ~/.codex-proxy/config.json)
  --codex-home <path>  Codex home (default: ~/.codex or %USERPROFILE%\\.codex)
  -h, --help           Show this help
  -V, --version        Show version

Windows Desktop: run \`codex-proxy start\`, then fully quit and reopen Codex.
`;

function fail(message: string, code = 1): never {
  console.error(`codex-proxy: ${message}`);
  process.exit(code);
}

function argsOf(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const rest = argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") flags.help = true;
    else if (arg === "-V" || arg === "--version") flags.version = true;
    else if (arg === "--port" || arg === "--config" || arg === "--codex-home") {
      const value = rest[i + 1];
      if (!value || value.startsWith("-")) fail(`${arg} requires a value`);
      flags[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith("--port=")) flags.port = arg.slice(7);
    else if (arg.startsWith("-")) fail(`Unknown flag ${arg}`);
    else positional.push(arg);
  }
  return { command: positional[0] ?? "help", flags };
}

function pathsFromFlags(flags: Record<string, string | boolean>): Paths {
  const env = { ...process.env };
  if (typeof flags["codex-home"] === "string") env.CODEX_HOME = flags["codex-home"];
  const paths = resolvePaths(env);
  if (typeof flags.config === "string") paths.config = flags.config;
  return paths;
}

function load(paths: Paths, flags: Record<string, string | boolean>): ProxyConfig {
  const config = loadConfig(paths.config);
  if (typeof flags.port === "string") {
    const port = Number(flags.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail("Invalid --port");
    const listen = parseListen(config.listen);
    config.listen = `${listen.hostname}:${port}`;
  }
  return config;
}

function printStatus(paths: Paths, config?: ProxyConfig): void {
  const pid = readPid(paths);
  const running = pid !== undefined && pidAlive(pid);
  const wired = wireStatus(paths);
  console.log(`config:   ${paths.config}`);
  console.log(`codex:    ${paths.codexConfig}`);
  console.log(`proxy:    ${running ? `running pid ${pid}` : "stopped"}`);
  console.log(`wired:    ${wired.wired ? "yes" : "no"}`);
  if (wired.wired) {
    console.log(`  model:   ${wired.model ?? "?"}`);
    console.log(`  base:    ${wired.baseUrl ?? "?"}`);
    console.log(`  catalog: ${wired.catalogPath ?? "?"}`);
  }
  if (config) {
    console.log(`listen:   ${config.listen}`);
    console.log(`default:  ${defaultSlug(config)}`);
    console.log(`models:   ${listSlugs(config).length}`);
  }
}

function doctor(paths: Paths): number {
  let issues = 0;
  const note = (ok: boolean, message: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
    if (!ok) issues += 1;
  };
  note(fs.existsSync(paths.config), `config exists (${paths.config})`);
  let config: ProxyConfig | undefined;
  try {
    config = loadConfig(paths.config);
    note(true, "config parses");
  } catch (error) {
    note(false, (error as Error).message);
  }
  if (config) {
    const listen = parseListen(config.listen);
    note(
      listen.hostname === "127.0.0.1" || listen.hostname === "localhost" || listen.hostname === "::1",
      `listen is loopback (${config.listen}) — required for Codex Desktop`,
    );
    for (const [id, provider] of Object.entries(config.providers)) {
      const key = Boolean(resolveSecret(provider.apiKey) || (provider.apiKeyEnv && process.env[provider.apiKeyEnv]?.trim()));
      const optional = provider.adapter === "openai-chat" && /127\.0\.0\.1|localhost/.test(provider.baseUrl);
      note(key || optional, `provider '${id}' API key ${key ? "set" : optional ? "not required (local)" : "missing"}`);
    }
    try {
      note(true, `default model ${defaultSlug(config)}`);
    } catch (error) {
      note(false, (error as Error).message);
    }
  }
  note(true, `Codex home ${paths.codexHome}${fs.existsSync(paths.codexHome) ? "" : " (will be created on wire)"}`);
  const pid = readPid(paths);
  if (pid && !pidAlive(pid)) note(false, `stale pid file ${paths.pid}`);
  else note(true, pid && pidAlive(pid) ? `proxy running as pid ${pid}` : "proxy not running");
  return issues;
}

function initConfig(paths: Paths): void {
  if (fs.existsSync(paths.config)) {
    console.log(`Already exists: ${paths.config}`);
    return;
  }
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(paths.config, `${JSON.stringify(exampleConfig(), null, 2)}\n`);
  console.log(`Wrote ${paths.config}`);
  console.log("Set provider API keys (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, …)");
  console.log("then run:  codex-proxy start");
}

async function main(): Promise<void> {
  const { command, flags } = argsOf(process.argv);
  if (flags.version) {
    console.log(VERSION);
    return;
  }
  if (flags.help || command === "help") {
    console.log(USAGE);
    return;
  }
  const paths = pathsFromFlags(flags);

  switch (command) {
    case "init":
      initConfig(paths);
      return;
    case "start": {
      const config = load(paths, flags);
      const wired = wireCodex(paths, config);
      writePid(paths);
      const { server, url } = serve(config);
      const shutdown = () => {
        stopPid(paths);
        unwireCodex(paths);
        server.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      console.log(`codex-proxy ${VERSION}  ${url}/v1`);
      console.log(`wired Codex  model=${wired.model}`);
      console.log(`catalog      ${wired.catalogPath}`);
      console.log("Fully quit and reopen Codex Desktop, then pick the model.");
      console.log("Ctrl+C stops the proxy and restores native Codex.");
      await new Promise(() => undefined);
      return;
    }
    case "serve": {
      const config = load(paths, flags);
      writePid(paths);
      const { url } = serve(config);
      process.on("SIGINT", () => {
        clearPid(paths);
        process.exit(0);
      });
      process.on("SIGTERM", () => {
        clearPid(paths);
        process.exit(0);
      });
      console.log(`codex-proxy ${VERSION}  ${url}/v1  (not wired)`);
      await new Promise(() => undefined);
      return;
    }
    case "stop": {
      const stopped = stopPid(paths);
      const unwired = unwireCodex(paths);
      console.log(`proxy:  ${stopped ? "stopped" : "not running"}`);
      console.log(`codex:  ${unwired.restored ? "restored" : "already native"}`);
      return;
    }
    case "wire": {
      const config = load(paths, flags);
      const wired = wireCodex(paths, config);
      console.log(`wired ${wired.configPath}`);
      console.log(`model ${wired.model}`);
      console.log(`url   ${wired.baseUrl}`);
      return;
    }
    case "unwire": {
      const unwired = unwireCodex(paths);
      console.log(unwired.restored ? `restored ${paths.codexConfig}` : "Codex was not wired");
      return;
    }
    case "status": {
      let config: ProxyConfig | undefined;
      try {
        config = load(paths, flags);
      } catch {
        // still print paths
      }
      printStatus(paths, config);
      return;
    }
    case "doctor": {
      const issues = doctor(paths);
      process.exit(issues === 0 ? 0 : 1);
      return;
    }
    case "models": {
      const config = load(paths, flags);
      for (const slug of listSlugs(config)) console.log(slug);
      return;
    }
    default:
      fail(`Unknown command '${command}'. See --help.`);
  }
}

await main();
