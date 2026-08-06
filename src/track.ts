import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgpmError } from "./errors.js";
import { hashDir, sha256 } from "./hash.js";
import { emptyLock, parseLock, serializeLock } from "./lock.js";
import { parseManifest, serializeManifest } from "./manifest.js";
import { inManagedRoot, isRepoRelative } from "./trackedFiles.js";
import type { Lock, LockFileEntry, Manifest } from "./types.js";

export async function runTrack(cwd: string, rawPath: string): Promise<{ lines: string[] }> {
  const path = normalize(rawPath);
  if (!isRepoRelative(path)) {
    throw new AgpmError("tracked paths must be repo-relative");
  }
  if (inManagedRoot(path)) {
    throw new AgpmError(`${path} is inside a managed root; skills, agents, and commands are tracked automatically`);
  }
  const { manifest, lock } = await loadHarness(cwd);
  if (manifest.files !== undefined && Object.hasOwn(manifest.files, path)) {
    throw new AgpmError(`${path} is already tracked`);
  }
  const abs = join(cwd, path);
  let stats;
  try {
    stats = await lstat(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgpmError(`no such file: ${path}`);
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new AgpmError(`refusing symlink at ${path}`);
  }
  const entry: LockFileEntry = stats.isDirectory()
    ? { source: "local", files: await hashDir(abs) }
    : { source: "local", sha256: sha256(await readFile(abs)) };
  const files = copyRecord(manifest.files);
  files[path] = "local";
  const lockFiles = copyRecord(lock.files);
  lockFiles[path] = entry;
  await writeHarness(cwd, { ...manifest, files }, { ...lock, files: lockFiles });
  return { lines: [`tracked ${path}`] };
}

export async function runUntrack(cwd: string, rawPath: string): Promise<{ lines: string[] }> {
  const path = normalize(rawPath);
  const { manifest, lock } = await loadHarness(cwd);
  if (manifest.files === undefined || !Object.hasOwn(manifest.files, path)) {
    throw new AgpmError(`${path} is not tracked`);
  }
  const files = copyRecord(manifest.files);
  delete files[path];
  const lockFiles = copyRecord(lock.files);
  delete lockFiles[path];
  const nextManifest: Manifest = { ...manifest };
  if (Object.keys(files).length > 0) nextManifest.files = files;
  else delete nextManifest.files;
  const nextLock: Lock = { ...lock };
  if (Object.keys(lockFiles).length > 0) nextLock.files = lockFiles;
  else delete nextLock.files;
  await writeHarness(cwd, nextManifest, nextLock);
  return { lines: [`untracked ${path}`] };
}

function normalize(rawPath: string): string {
  return rawPath.replace(/\/+$/, "");
}

function copyRecord<T>(source: Record<string, T> | undefined): Record<string, T> {
  const out: Record<string, T> = Object.create(null);
  for (const [key, value] of Object.entries(source ?? {})) out[key] = value;
  return out;
}

async function loadHarness(cwd: string): Promise<{ manifest: Manifest; lock: Lock }> {
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

async function writeHarness(cwd: string, manifest: Manifest, lock: Lock): Promise<void> {
  await writeFile(join(cwd, "harness.json"), serializeManifest(manifest), "utf8");
  await writeFile(join(cwd, "harness.lock"), serializeLock(lock), "utf8");
}
