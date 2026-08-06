import { AgpmError } from "./errors.js";
import { isRegistryProvenance } from "./registryRef.js";
import { inManagedRoot, isRepoRelative } from "./trackedFiles.js";
import { KINDS, type ExtendsRef, type Kind, type Manifest } from "./types.js";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROVENANCE_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const EXTENDS_RE = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([^\s@]+)$/;
const TOP_KEYS = new Set(["version", "extends", ...KINDS, "files"]);

// Single source of truth for the "github:owner/repo@ref" extends format, shared by
// parseManifest, parseLock, and parseExtends. Rejects "." and ".." owner/repo segments
// so a value like "github:../..@main" cannot be turned into a path-traversing API call.
export function parseExtendsValue(value: string): ExtendsRef | undefined {
  const m = EXTENDS_RE.exec(value);
  if (m === null) return undefined;
  const owner = m[1]!;
  const repo = m[2]!;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return undefined;
  return { owner, repo, ref: m[3]! };
}

export function isProvenance(value: string): boolean {
  if (value === "local" || value === "unknown") return true;
  if (value.startsWith("registry:")) return isRegistryProvenance(value);
  if (!value.startsWith("github:")) return false;
  const segments = value.slice("github:".length).split("/");
  if (segments.length < 2) return false;
  return segments.every((seg) => seg !== "." && seg !== ".." && PROVENANCE_SEGMENT_RE.test(seg));
}

export function parseManifest(text: string, filePath: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AgpmError(`broken harness.json at ${filePath}: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgpmError(`broken harness.json at ${filePath}: top level must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!TOP_KEYS.has(key)) {
      throw new AgpmError(`${filePath}: unknown key "${key}" (allowed: version, extends, skills, agents, commands, files)`);
    }
  }
  if (obj["version"] !== 1) {
    throw new AgpmError(`${filePath}: version must be 1`);
  }
  let ext: string | undefined;
  if (obj["extends"] !== undefined) {
    if (typeof obj["extends"] !== "string" || parseExtendsValue(obj["extends"]) === undefined) {
      throw new AgpmError(`${filePath}: extends must look like "github:owner/repo@ref"`);
    }
    ext = obj["extends"];
  }
  const sections = Object.create(null) as Record<Kind, Record<string, string>>;
  for (const kind of KINDS) {
    sections[kind] = parseSection(obj[kind], kind, filePath);
  }
  const files = parseFiles(obj["files"], filePath);
  return {
    version: 1,
    ...(ext === undefined ? {} : { extends: ext }),
    ...sections,
    ...(files === undefined ? {} : { files }),
  };
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function emptyManifest(): Manifest {
  return {
    version: 1,
    skills: Object.create(null) as Record<string, string>,
    agents: Object.create(null) as Record<string, string>,
    commands: Object.create(null) as Record<string, string>,
  };
}

export function serializeManifest(manifest: Manifest): string {
  const out: Record<string, unknown> = Object.create(null);
  out["version"] = 1;
  if (manifest.extends !== undefined) out["extends"] = manifest.extends;
  for (const kind of KINDS) {
    const section: Record<string, string> = Object.create(null);
    for (const name of Object.keys(manifest[kind]).sort()) {
      section[name] = manifest[kind][name]!;
    }
    out[kind] = section;
  }
  if (manifest.files !== undefined && Object.keys(manifest.files).length > 0) {
    const files: Record<string, string> = Object.create(null);
    for (const path of Object.keys(manifest.files).sort()) {
      files[path] = manifest.files[path]!;
    }
    out["files"] = files;
  }
  return JSON.stringify(out, null, 2) + "\n";
}

function parseSection(raw: unknown, kind: Kind, filePath: string): Record<string, string> {
  if (raw === undefined) return Object.create(null) as Record<string, string>;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgpmError(`${filePath}: "${kind}" must be an object of name to provenance`);
  }
  const out: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) {
      throw new AgpmError(`${filePath}: bad ${kind} name "${name}" (letters, digits, dot, dash, underscore)`);
    }
    if (typeof value !== "string" || !isProvenance(value)) {
      throw new AgpmError(
        `${filePath}: ${kind}/${name} provenance must be "local", "unknown", "github:owner/repo[/path]", or "registry:@org/name@version"`,
      );
    }
    out[name] = value;
  }
  return out;
}

function parseFiles(raw: unknown, filePath: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgpmError(`${filePath}: "files" must be an object of path to provenance`);
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) return undefined;
  const out: Record<string, string> = Object.create(null);
  for (const [path, value] of entries) {
    if (!isRepoRelative(path)) {
      throw new AgpmError(
        `${filePath}: bad files path "${path}" (repo-relative, forward slashes, no "." or ".." segments)`,
      );
    }
    if (inManagedRoot(path)) {
      throw new AgpmError(
        `${filePath}: files path "${path}" is inside a managed root; skills, agents, and commands are tracked automatically`,
      );
    }
    if (value !== "local") {
      throw new AgpmError(`${filePath}: files/${path} provenance must be "local"`);
    }
    out[path] = value;
  }
  return out;
}
