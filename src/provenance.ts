import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isProvenance } from "./manifest.js";

export interface ProvenanceInfo {
  sources: Record<string, string>;
  notes: string[];
}

const LOCK_PATHS = ["skills-lock.json", ".claude/skills-lock.json"];
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const CANDIDATE_KEYS = ["source", "repository", "repo", "url"];

export async function readProvenance(root: string): Promise<ProvenanceInfo> {
  const sources: Record<string, string> = Object.create(null);
  const notes: string[] = [];
  for (const rel of LOCK_PATHS) {
    let text: string;
    try {
      text = await readFile(join(root, rel), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      notes.push(`could not read ${rel}: ${(error as Error).message}`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      notes.push(`could not parse ${rel}; ignoring it`);
      continue;
    }
    collect(raw, sources);
  }
  return { sources, notes };
}

function collect(raw: unknown, sources: Record<string, string>): void {
  if (!isPlainObject(raw)) return;
  const top = raw as Record<string, unknown>;
  const table = isPlainObject(top["skills"]) ? (top["skills"] as Record<string, unknown>) : top;
  for (const [key, value] of Object.entries(table)) {
    const candidate = candidateOf(value);
    if (candidate === undefined) continue;
    const provenance = normalizeGithub(candidate);
    if (provenance === undefined) continue;
    const name = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
    if (name !== "") sources[name] = provenance;
  }
}

function candidateOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isPlainObject(value)) return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of CANDIDATE_KEYS) {
    if (Object.hasOwn(obj, key) && typeof obj[key] === "string") return obj[key] as string;
  }
  return undefined;
}

export function normalizeGithub(value: string): string | undefined {
  if (value.startsWith("github:")) {
    const at = value.indexOf("@");
    const stripped = at === -1 ? value : value.slice(0, at);
    return isProvenance(stripped) ? stripped : undefined;
  }
  const url = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/[^/]+(?:\/(.+))?)?\/?$/);
  if (url !== null) {
    const [, owner, repo, path] = url;
    const base = `github:${owner}/${repo}${path === undefined ? "" : `/${path}`}`;
    return isProvenance(base) ? base : undefined;
  }
  const segments = value.split("/");
  if (segments.length >= 2 && segments.every((s) => SEGMENT_RE.test(s))) {
    const bare = `github:${value}`;
    return isProvenance(bare) ? bare : undefined;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
