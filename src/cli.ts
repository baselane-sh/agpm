import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCheck } from "./check.js";
import { AgpmError } from "./errors.js";
import { formatList } from "./list.js";
import { emptyLock, parseLock } from "./lock.js";
import { parseManifest } from "./manifest.js";
import { scanRepo } from "./scan.js";
import type { Lock, Manifest } from "./types.js";

type Writer = (line: string) => void;

export async function runCli(argv: string[], cwd: string, write: Writer): Promise<number> {
  try {
    switch (argv[0]) {
      case "check":
        return await check(cwd, write);
      case "list":
        return await list(cwd, write);
      default:
        write("usage: agpm <check|list>");
        return 2;
    }
  } catch (error) {
    if (error instanceof AgpmError) {
      write(error.message);
      return 2;
    }
    write(`internal error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

async function loadFiles(cwd: string): Promise<{ manifest: Manifest; lock: Lock }> {
  const manifestPath = join(cwd, "harness.json");
  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgpmError(`no harness.json found in ${cwd}`);
    }
    throw error;
  }
  const manifest = parseManifest(manifestText, manifestPath);
  const lockPath = join(cwd, "harness.lock");
  let lock: Lock;
  try {
    lock = parseLock(await readFile(lockPath, "utf8"), lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      lock = emptyLock();
    } else {
      throw error;
    }
  }
  return { manifest, lock };
}

async function check(cwd: string, write: Writer): Promise<number> {
  const { manifest, lock } = await loadFiles(cwd);
  const result = runCheck(manifest, lock, await scanRepo(cwd));
  for (const finding of result.findings) {
    write(`${finding.level === "fail" ? "FAIL" : "WARN"} ${finding.kind}/${finding.name}: ${finding.message}`);
  }
  const fails = result.findings.filter((f) => f.level === "fail").length;
  const warns = result.findings.length - fails;
  write(`check: ${fails} fail, ${warns} warn`);
  return result.exitCode;
}

async function list(cwd: string, write: Writer): Promise<number> {
  const { manifest, lock } = await loadFiles(cwd);
  for (const line of formatList(manifest, lock, await scanRepo(cwd))) write(line);
  return 0;
}
