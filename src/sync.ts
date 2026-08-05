import { AgpmError } from "./errors.js";
import { emptyLock } from "./lock.js";
import { emptyManifest, isValidName } from "./manifest.js";
import { KINDS, type Kind, type Lock, type LockEntry, type Manifest, type ScanResult, type ScannedUnit } from "./types.js";

export interface SyncChange {
  action: "added" | "updated" | "removed";
  kind: Kind;
  name: string;
  detail: string;
}

export interface SyncResult {
  manifest: Manifest;
  lock: Lock;
  changes: SyncChange[];
}

export function computeSync(
  prev: Manifest,
  prevLock: Lock,
  scan: ScanResult,
  sources: Record<string, string>,
): SyncResult {
  const manifest = emptyManifest();
  if (prev.extends !== undefined) manifest.extends = prev.extends;
  const lock = emptyLock();
  if (prevLock.extendsCommit !== undefined) lock.extendsCommit = prevLock.extendsCommit;
  const changes: SyncChange[] = [];

  for (const kind of KINDS) {
    const units = new Map(scan.units.filter((u) => u.kind === kind).map((u) => [u.name, u]));
    for (const name of Object.keys(prev[kind]).sort()) {
      if (!units.has(name)) changes.push({ action: "removed", kind, name, detail: "" });
    }
    for (const [name, unit] of [...units.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!isValidName(name)) {
        throw new AgpmError(
          `cannot record ${kind} name "${name}"; rename the folder to use letters, digits, dot, dash, underscore`,
        );
      }
      const source = Object.hasOwn(prev[kind], name)
        ? prev[kind][name]!
        : kind === "skills" && Object.hasOwn(sources, name)
          ? sources[name]!
          : "local";
      manifest[kind][name] = source;
      const entry = unitToEntry(unit, source);
      lock[kind][name] = entry;
      const prevEntry = Object.hasOwn(prevLock[kind], name) ? prevLock[kind][name]! : undefined;
      if (prevEntry === undefined) {
        if (Object.hasOwn(prev[kind], name)) {
          changes.push({ action: "updated", kind, name, detail: "lock entry created" });
        } else {
          changes.push({ action: "added", kind, name, detail: source });
        }
      } else if (!sameEntry(prevEntry, entry)) {
        changes.push({ action: "updated", kind, name, detail: diffSummary(prevEntry, entry) });
      }
    }
  }
  return { manifest, lock, changes };
}

function unitToEntry(unit: ScannedUnit, source: string): LockEntry {
  const locations = [...unit.locations].sort((a, b) => (a.dir < b.dir ? -1 : 1));
  return { source, dirs: locations.map((l) => l.dir), files: locations[0]!.files };
}

function sameEntry(a: LockEntry, b: LockEntry): boolean {
  return a.source === b.source && sameArray(a.dirs, b.dirs) && sameRecord(a.files, b.files);
}

function diffSummary(a: LockEntry, b: LockEntry): string {
  if (!sameArray(a.dirs, b.dirs)) return `dirs now [${b.dirs.join(", ")}]`;
  const keys = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
  let n = 0;
  for (const key of keys) {
    const left = Object.hasOwn(a.files, key) ? a.files[key] : undefined;
    const right = Object.hasOwn(b.files, key) ? b.files[key] : undefined;
    if (left !== right) n++;
  }
  return `${n} file${n === 1 ? "" : "s"} changed`;
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}
