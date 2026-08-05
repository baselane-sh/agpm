import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatAudit } from "./audit.js";
import { runCheck } from "./check.js";
import { AgpmError } from "./errors.js";
import { formatList } from "./list.js";
import { emptyLock, parseLock, serializeLock } from "./lock.js";
import { emptyManifest, parseManifest, serializeManifest } from "./manifest.js";
import { readProvenance } from "./provenance.js";
import { scanRepo } from "./scan.js";
import { computeSync, type SyncResult } from "./sync.js";
import type { Lock, Manifest } from "./types.js";

type Writer = (line: string) => void;

export async function runCli(argv: string[], cwd: string, write: Writer): Promise<number> {
  try {
    switch (argv[0]) {
      case "init":
        return await init(cwd, write);
      case "sync":
        return await sync(cwd, write);
      case "check":
        return await check(cwd, write);
      case "audit":
        return await audit(cwd, write);
      case "list":
        return await list(cwd, write);
      default:
        write("usage: agpm <init|sync|check|audit|list>");
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
      throw new AgpmError(`no harness.json found in ${cwd}; run agpm init`);
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

async function audit(cwd: string, write: Writer): Promise<number> {
  const { manifest, lock } = await loadFiles(cwd);
  const { notes } = await readProvenance(cwd);
  for (const line of formatAudit(manifest, lock, await scanRepo(cwd), notes)) write(line);
  return 0;
}

async function list(cwd: string, write: Writer): Promise<number> {
  const { manifest, lock } = await loadFiles(cwd);
  for (const line of formatList(manifest, lock, await scanRepo(cwd))) write(line);
  return 0;
}

async function init(cwd: string, write: Writer): Promise<number> {
  const manifestPath = join(cwd, "harness.json");
  if (await fileExists(manifestPath)) {
    throw new AgpmError(`harness.json already exists in ${cwd}; run agpm sync`);
  }
  const { sources } = await readProvenance(cwd);
  const result = computeSync(emptyManifest(), emptyLock(), await scanRepo(cwd), sources);
  await writeResult(cwd, result);
  reportChanges(result.changes, write);
  const n = result.changes.length;
  write(`init: ${n} ${n === 1 ? "entry" : "entries"} recorded`);
  return 0;
}

async function sync(cwd: string, write: Writer): Promise<number> {
  const { manifest, lock } = await loadFiles(cwd);
  const { sources, notes } = await readProvenance(cwd);
  const result = computeSync(manifest, lock, await scanRepo(cwd), sources);
  await writeResult(cwd, result);
  for (const note of notes) write(`note: ${note}`);
  reportChanges(result.changes, write);
  const count = (action: string) => result.changes.filter((c) => c.action === action).length;
  write(`sync: ${count("added")} added, ${count("updated")} updated, ${count("removed")} removed`);
  return 0;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeResult(cwd: string, result: SyncResult): Promise<void> {
  await writeFile(join(cwd, "harness.json"), serializeManifest(result.manifest), "utf8");
  await writeFile(join(cwd, "harness.lock"), serializeLock(result.lock), "utf8");
}

function reportChanges(changes: SyncResult["changes"], write: Writer): void {
  for (const change of changes) {
    const suffix = change.detail === "" ? "" : ` (${change.detail})`;
    write(`${change.action} ${change.kind}/${change.name}${suffix}`);
  }
}
