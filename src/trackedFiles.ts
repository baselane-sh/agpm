// Tracked-file path rules, shared by manifest parsing (Task 3) and the track
// command (Task 8). Scanning and checking land here in Task 5.

import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgpmError } from "./errors.js";
import { hashDir, sha256 } from "./hash.js";
import type { CandidateNote, Finding, LockFileEntry, TrackedScan } from "./types.js";

export const MANAGED_ROOTS: readonly string[] = [
  ".agents/skills",
  ".claude/agents",
  ".claude/commands",
  ".claude/skills",
];

const DRIVE_RE = /^[A-Za-z]:/;

export function isRepoRelative(path: string): boolean {
  if (path === "" || path.includes("\\") || DRIVE_RE.test(path)) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function inManagedRoot(path: string): boolean {
  return MANAGED_ROOTS.some((root) => path === root || path.startsWith(root + "/"));
}

export async function scanTrackedFiles(root: string, declared: Record<string, string>): Promise<TrackedScan> {
  const out: TrackedScan = Object.create(null);
  for (const path of Object.keys(declared).sort()) {
    const abs = join(root, path);
    let stats;
    try {
      stats = await lstat(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        out[path] = { status: "missing" };
        continue;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new AgpmError(`refusing symlink at ${path}; agpm hashes regular files only`);
    }
    if (stats.isDirectory()) {
      out[path] = { status: "dir", files: await hashDir(abs) };
    } else {
      out[path] = { status: "file", sha256: sha256(await readFile(abs)) };
    }
  }
  return out;
}

export function checkTrackedFiles(
  declared: Record<string, string>,
  lockFiles: Record<string, LockFileEntry>,
  scan: TrackedScan,
): Finding[] {
  const findings: Finding[] = [];
  const paths = [...new Set([...Object.keys(declared), ...Object.keys(lockFiles)])].sort();
  for (const path of paths) {
    const inManifest = Object.hasOwn(declared, path);
    const entry = Object.hasOwn(lockFiles, path) ? lockFiles[path]! : undefined;
    if (!inManifest) {
      findings.push(fail(path, "unsynced",
        `harness.json and harness.lock disagree about files/${path}; run agpm sync and approve the diff by PR`));
      continue;
    }
    if (entry === undefined) {
      findings.push(fail(path, "unsynced", `files/${path} is approved but not hashed; run agpm sync`));
      continue;
    }
    const state = Object.hasOwn(scan, path) ? scan[path]! : undefined;
    if (state === undefined || state.status === "missing") {
      findings.push(fail(path, "missing", `files/${path} is approved in harness.json but missing on disk`));
      continue;
    }
    const matches =
      state.status === "file"
        ? entry.sha256 !== undefined && entry.sha256 === state.sha256
        : entry.files !== undefined && state.files !== undefined && sameRecord(entry.files, state.files);
    if (!matches) {
      findings.push(fail(path, "drifted", `files/${path} bytes differ from the approved hashes`));
    }
  }
  return findings;
}

const PLAIN_CANDIDATES = ["CLAUDE.md", "AGENTS.md", ".mcp.json"];
const SETTINGS_CANDIDATE = ".claude/settings.json";

export async function candidateWarnings(root: string): Promise<CandidateNote[]> {
  const notes: CandidateNote[] = [];
  for (const path of PLAIN_CANDIDATES) {
    if (await isRegularFile(join(root, path))) {
      notes.push({ path, message: `${path} exists on disk but nobody tracks it in harness.json; run agpm track ${path}` });
    }
  }
  const settingsAbs = join(root, SETTINGS_CANDIDATE);
  if ((await isRegularFile(settingsAbs)) && (await settingsNeedsTracking(settingsAbs))) {
    notes.push({
      path: SETTINGS_CANDIDATE,
      message: `${SETTINGS_CANDIDATE} contains hooks but nobody tracks it in harness.json; run agpm track ${SETTINGS_CANDIDATE}`,
    });
  }
  return notes;
}

async function isRegularFile(abs: string): Promise<boolean> {
  try {
    return (await lstat(abs)).isFile();
  } catch {
    return false;
  }
}

async function settingsNeedsTracking(abs: string): Promise<boolean> {
  const text = await readFile(abs, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return true;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.hasOwn(parsed, "hooks");
}

function fail(path: string, code: Finding["code"], message: string): Finding {
  return { level: "fail", kind: "files", name: path, code, message };
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}
