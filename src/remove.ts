// Remove engine: deletes a skill's folder from every root it exists in and drops the
// harness.json/harness.lock entries via the same computeSync path agpm sync uses. Works
// for any provenance, including an unapproved on-disk folder with no manifest entry.

import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgpmError } from "./errors.js";
import { emptyLock, parseLock, serializeLock } from "./lock.js";
import { isValidName, parseManifest, serializeManifest } from "./manifest.js";
import { readProvenance } from "./provenance.js";
import { scanRepo } from "./scan.js";
import { computeSync, type SyncResult } from "./sync.js";
import type { Lock, Manifest } from "./types.js";

const SKILL_ROOTS = [".claude/skills", ".agents/skills"];

export async function runRemove(cwd: string, name: string): Promise<{ lines: string[] }> {
  if (!isValidName(name)) {
    throw new AgpmError("remove takes a skill name");
  }

  const { manifest, lock } = await loadHarnessFiles(cwd);

  const existingRoots: string[] = [];
  for (const root of SKILL_ROOTS) {
    if (await isDirectory(join(cwd, root, name))) existingRoots.push(root);
  }
  if (!Object.hasOwn(manifest.skills, name) && existingRoots.length === 0) {
    throw new AgpmError(`skills/${name} is not installed`);
  }

  for (const root of existingRoots) {
    await rm(join(cwd, root, name), { recursive: true, force: true });
  }

  const { sources } = await readProvenance(cwd);
  const result = computeSync(manifest, lock, await scanRepo(cwd), sources);
  await writeHarnessFiles(cwd, result);

  return { lines: [`removed skills/${name}`] };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function loadHarnessFiles(cwd: string): Promise<{ manifest: Manifest; lock: Lock }> {
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

async function writeHarnessFiles(cwd: string, result: SyncResult): Promise<void> {
  await writeFile(join(cwd, "harness.json"), serializeManifest(result.manifest), "utf8");
  await writeFile(join(cwd, "harness.lock"), serializeLock(result.lock), "utf8");
}
