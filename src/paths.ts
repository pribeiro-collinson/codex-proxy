import os from "node:os";
import path from "node:path";

export type Paths = {
  home: string;
  config: string;
  catalog: string;
  pid: string;
  wireState: string;
  codexHome: string;
  codexConfig: string;
};

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.CODEX_PROXY_HOME?.trim() || path.join(os.homedir(), ".codex-proxy");
  const codexHome = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
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

export function toPosixPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}
