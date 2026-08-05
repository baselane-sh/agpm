import { AgpmError } from "./errors.js";
import { isProvenance, isValidName } from "./manifest.js";
import { KINDS, type Kind, type Lock, type LockEntry } from "./types.js";

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export function emptyLock(): Lock {
  // Null-prototype sections: entry names come from parsed JSON, and names like
  // "toString" or "__proto__" must behave as plain data keys.
  return {
    version: 1,
    skills: Object.create(null) as Record<string, LockEntry>,
    agents: Object.create(null) as Record<string, LockEntry>,
    commands: Object.create(null) as Record<string, LockEntry>,
  };
}

export function parseLock(text: string, filePath: string): Lock {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AgpmError(`broken harness.lock at ${filePath}: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgpmError(`broken harness.lock at ${filePath}: top level must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== 1) throw new AgpmError(`${filePath}: version must be 1`);
  const lock = emptyLock();
  if (obj["extendsCommit"] !== undefined) {
    if (typeof obj["extendsCommit"] !== "string" || !COMMIT_RE.test(obj["extendsCommit"])) {
      throw new AgpmError(`${filePath}: extendsCommit must be a 40 hex commit`);
    }
    lock.extendsCommit = obj["extendsCommit"];
  }
  if (obj["extendsManifest"] !== undefined) {
    if (lock.extendsCommit === undefined) {
      throw new AgpmError(`${filePath}: extendsManifest requires extendsCommit`);
    }
    lock.extendsManifest = parseExtendsManifest(obj["extendsManifest"], filePath);
  }
  for (const kind of KINDS) {
    const section = obj[kind];
    if (section === undefined) continue;
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
      throw new AgpmError(`${filePath}: "${kind}" must be an object`);
    }
    for (const [name, value] of Object.entries(section)) {
      lock[kind][name] = parseEntry(value, `${filePath}: ${kind}/${name}`);
    }
  }
  return lock;
}

function badPath(p: string): boolean {
  return (
    p === "" ||
    p.startsWith("/") ||
    p.includes("\\") ||
    p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  );
}

function parseEntry(raw: unknown, where: string): LockEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgpmError(`${where}: entry must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const { source, dirs, files } = obj;
  if (typeof source !== "string" || !isProvenance(source)) {
    throw new AgpmError(`${where}: source must be a provenance string`);
  }
  if (!Array.isArray(dirs) || dirs.length === 0 || !dirs.every((d) => typeof d === "string")) {
    throw new AgpmError(`${where}: dirs must be a non-empty string array`);
  }
  for (const d of dirs as string[]) {
    if (badPath(d)) {
      throw new AgpmError(`${where}: dirs value "${d}" must be a clean repo-relative path (no "..", "\\", or leading "/")`);
    }
  }
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new AgpmError(`${where}: files must be an object`);
  }
  const outFiles: Record<string, string> = Object.create(null);
  for (const [rel, hash] of Object.entries(files)) {
    if (badPath(rel)) {
      throw new AgpmError(`${where}: files key "${rel}" must be a clean relative path (no "..", "\\", or leading "/")`);
    }
    if (typeof hash !== "string" || !HASH_RE.test(hash)) {
      throw new AgpmError(`${where}: files["${rel}"] must be "sha256:<64 hex>"`);
    }
    outFiles[rel] = hash;
  }
  return { source, dirs: [...(dirs as string[])].sort(), files: outFiles };
}

function parseExtendsManifest(raw: unknown, filePath: string): Record<Kind, Record<string, string>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgpmError(`${filePath}: extendsManifest must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KINDS.includes(key as Kind)) {
      throw new AgpmError(`${filePath}: extendsManifest has unknown key "${key}" (allowed: skills, agents, commands)`);
    }
  }
  const out = Object.create(null) as Record<Kind, Record<string, string>>;
  for (const kind of KINDS) {
    const section = Object.create(null) as Record<string, string>;
    const rawSection = obj[kind];
    if (rawSection !== undefined) {
      if (typeof rawSection !== "object" || rawSection === null || Array.isArray(rawSection)) {
        throw new AgpmError(`${filePath}: extendsManifest.${kind} must be an object`);
      }
      for (const [name, value] of Object.entries(rawSection)) {
        if (!isValidName(name)) {
          throw new AgpmError(`${filePath}: extendsManifest.${kind} has a bad name "${name}"`);
        }
        if (typeof value !== "string" || !isProvenance(value)) {
          throw new AgpmError(`${filePath}: extendsManifest.${kind}/${name} must be a provenance string`);
        }
        section[name] = value;
      }
    }
    out[kind] = section;
  }
  return out;
}

export function serializeLock(lock: Lock): string {
  return JSON.stringify(sortDeep(lock), null, 2) + "\n";
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return [...value].sort();
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortDeep(v)]),
    );
  }
  return value;
}
