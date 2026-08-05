import { AgpmError } from "./errors.js";
import { isProvenance } from "./manifest.js";
import { KINDS, type Kind, type Lock, type LockEntry } from "./types.js";

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export function emptyLock(): Lock {
  return { version: 1, skills: {}, agents: {}, commands: {} };
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
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new AgpmError(`${where}: files must be an object`);
  }
  const outFiles: Record<string, string> = {};
  for (const [rel, hash] of Object.entries(files)) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) {
      throw new AgpmError(`${where}: files["${rel}"] must be "sha256:<64 hex>"`);
    }
    outFiles[rel] = hash;
  }
  return { source, dirs: [...(dirs as string[])].sort(), files: outFiles };
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
