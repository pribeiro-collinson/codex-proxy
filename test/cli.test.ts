import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.join(import.meta.dir, "../src/cli.ts");

async function run(home: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", cli, ...args], {
    env: { ...process.env, CODEX_PROXY_HOME: home, CODEX_HOME: path.join(home, "codex") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("cli", () => {
  test("prints version and help", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cxp-"));
    const version = await run(home, ["--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe("0.1.0");
    const help = await run(home, ["--help"]);
    expect(help.stdout).toContain("codex-proxy");
    expect(help.stdout).toContain("start");
  });

  test("init, models, wire, unwire", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cxp-"));
    const init = await run(home, ["init"]);
    expect(init.exitCode).toBe(0);
    expect(fs.existsSync(path.join(home, "config.json"))).toBe(true);

    const models = await run(home, ["models"]);
    expect(models.exitCode).toBe(0);
    expect(models.stdout).toContain("openrouter/anthropic/claude-sonnet-4.6");

    const wired = await run(home, ["wire"]);
    expect(wired.exitCode).toBe(0);
    const toml = fs.readFileSync(path.join(home, "codex", "config.toml"), "utf8");
    expect(toml).toContain("codex-proxy:begin");
    expect(toml).toContain("openai_base_url");

    const unwired = await run(home, ["unwire"]);
    expect(unwired.exitCode).toBe(0);
    const restored = fs.readFileSync(path.join(home, "codex", "config.toml"), "utf8");
    expect(restored).not.toContain("codex-proxy:begin");
  });
});
