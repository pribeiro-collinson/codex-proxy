import fs from "node:fs";
import type { Paths } from "./paths.ts";

export function writePid(paths: Paths, pid = process.pid): void {
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(paths.pid, `${pid}\n`, { encoding: "utf8" });
}

export function readPid(paths: Paths): number | undefined {
  try {
    const text = fs.readFileSync(paths.pid, "utf8").trim();
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function clearPid(paths: Paths): void {
  try {
    fs.unlinkSync(paths.pid);
  } catch {
    // ignore
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stopPid(paths: Paths): boolean {
  const pid = readPid(paths);
  if (!pid) return false;
  if (pid === process.pid) {
    clearPid(paths);
    return true;
  }
  if (!pidAlive(pid)) {
    clearPid(paths);
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  clearPid(paths);
  return true;
}
