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
  notes: string[];
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
  const notes: string[] = [];

  for (const kind of KINDS) {
    const units = new Map(scan.units.filter((u) => u.kind === kind).map((u) => [u.name, u]));
    const removalCandidates = new Set([...Object.keys(prev[kind]), ...Object.keys(prevLock[kind])]);
    for (const name of [...removalCandidates].sort()) {
      if (!units.has(name)) changes.push({ action: "removed", kind, name, detail: "" });
    }
    for (const [name, unit] of [...units.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!isValidName(name)) {
        throw new AgpmError(
          `cannot record ${kind} name "${name}"; rename the folder to use letters, digits, dot, dash, underscore`,
        );
      }
      const splitNote = describeSplit(kind, name, unit);
      if (splitNote !== undefined) notes.push(splitNote);
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
  return { manifest, lock, changes, notes };
}

function unitToEntry(unit: ScannedUnit, source: string): LockEntry {
  const locations = [...unit.locations].sort((a, b) => (a.dir < b.dir ? -1 : 1));
  return { source, dirs: locations.map((l) => l.dir), files: locations[0]!.files };
}

function describeSplit(kind: Kind, name: string, unit: ScannedUnit): string | undefined {
  const locations = [...unit.locations].sort((a, b) => (a.dir < b.dir ? -1 : 1));
  if (locations.length < 2) return undefined;
  const first = locations[0]!;
  const differs = locations.slice(1).some((loc) => !sameRecord(first.files, loc.files));
  if (!differs) return undefined;
  const dirs = locations.map((l) => l.dir).join(" and ");
  return `${kind}/${name} differs between ${dirs}; recorded files from ${first.dir}; agpm cannot reconcile the copies`;
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
