import { AgpmError } from "./errors.js";
import { KINDS, type Kind, type Manifest } from "./types.js";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROVENANCE_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./-]+)?$/;
const EXTENDS_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[^\s@]+$/;
const TOP_KEYS = new Set(["version", "extends", ...KINDS]);

export function isProvenance(value: string): boolean {
  return value === "local" || value === "unknown" || PROVENANCE_RE.test(value);
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
      throw new AgpmError(`${filePath}: unknown key "${key}" (allowed: version, extends, skills, agents, commands)`);
    }
  }
  if (obj["version"] !== 1) {
    throw new AgpmError(`${filePath}: version must be 1`);
  }
  let ext: string | undefined;
  if (obj["extends"] !== undefined) {
    if (typeof obj["extends"] !== "string" || !EXTENDS_RE.test(obj["extends"])) {
      throw new AgpmError(`${filePath}: extends must look like "github:owner/repo@ref"`);
    }
    ext = obj["extends"];
  }
  const sections = Object.create(null) as Record<Kind, Record<string, string>>;
  for (const kind of KINDS) {
    sections[kind] = parseSection(obj[kind], kind, filePath);
  }
  return { version: 1, ...(ext === undefined ? {} : { extends: ext }), ...sections };
}

function parseSection(raw: unknown, kind: Kind, filePath: string): Record<string, string> {
  if (raw === undefined) return {};
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
        `${filePath}: ${kind}/${name} provenance must be "local", "unknown", or "github:owner/repo[/path]" with no @ref`,
      );
    }
    out[name] = value;
  }
  return out;
}
