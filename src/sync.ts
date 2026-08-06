import { emptyLock } from "./lock.js";
import { emptyManifest, isValidName } from "./manifest.js";
import {
  KINDS,
  type Kind,
  type Lock,
  type LockEntry,
  type LockFileEntry,
  type Manifest,
  type ResolvedExtends,
  type ScanResult,
  type ScannedUnit,
  type TrackedScan,
} from "./types.js";

export interface SyncChange {
  action: "added" | "updated" | "removed";
  kind: Kind | "files";
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
  resolvedExtends?: ResolvedExtends,
  trackedScan?: TrackedScan,
): SyncResult {
  const manifest = emptyManifest();
  if (prev.extends !== undefined) manifest.extends = prev.extends;
  const lock = emptyLock();
  if (prev.extends !== undefined) {
    if (resolvedExtends !== undefined) {
      lock.extends = prev.extends;
      lock.extendsCommit = resolvedExtends.commit;
      lock.extendsManifest = copySections(resolvedExtends.sections);
    } else {
      if (prevLock.extends !== undefined) lock.extends = prevLock.extends;
      if (prevLock.extendsCommit !== undefined) lock.extendsCommit = prevLock.extendsCommit;
      if (prevLock.extendsManifest !== undefined) lock.extendsManifest = copySections(prevLock.extendsManifest);
    }
  }
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
        notes.push(
          `skipped ${kind}/${name}: the name must start with a letter or digit and use only letters, digits, dot, dash, underscore; rename the folder to record it`,
        );
        continue;
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

  const declared = prev.files ?? (Object.create(null) as Record<string, string>);
  const prevLockFiles = prevLock.files ?? (Object.create(null) as Record<string, LockFileEntry>);
  if (trackedScan === undefined) {
    // Callers without a tracked scan (install, remove, update, init) must
    // carry the tracked-file sections through unchanged, never drop them.
    const carriedFiles: Record<string, string> = Object.create(null);
    for (const [path, provenance] of Object.entries(declared)) carriedFiles[path] = provenance;
    const carriedLock: Record<string, LockFileEntry> = Object.create(null);
    for (const [path, entry] of Object.entries(prevLockFiles)) carriedLock[path] = { ...entry };
    if (Object.keys(carriedFiles).length > 0) manifest.files = carriedFiles;
    if (Object.keys(carriedLock).length > 0) lock.files = carriedLock;
  } else {
    const states = trackedScan;
    const removalPaths = new Set([...Object.keys(declared), ...Object.keys(prevLockFiles)]);
    for (const path of [...removalPaths].sort()) {
      const state = Object.hasOwn(states, path) ? states[path]! : undefined;
      if (state === undefined || state.status === "missing") {
        changes.push({ action: "removed", kind: "files", name: path, detail: "" });
      }
    }
    const files: Record<string, string> = Object.create(null);
    const lockFiles: Record<string, LockFileEntry> = Object.create(null);
    for (const path of Object.keys(declared).sort()) {
      const state = Object.hasOwn(states, path) ? states[path]! : undefined;
      if (state === undefined || state.status === "missing") continue;
      files[path] = "local";
      const entry: LockFileEntry =
        state.status === "file" ? { source: "local", sha256: state.sha256! } : { source: "local", files: state.files! };
      lockFiles[path] = entry;
      const prevEntry = Object.hasOwn(prevLockFiles, path) ? prevLockFiles[path]! : undefined;
      if (prevEntry === undefined) {
        changes.push({ action: "added", kind: "files", name: path, detail: "local" });
      } else if (!sameFileEntry(prevEntry, entry)) {
        changes.push({ action: "updated", kind: "files", name: path, detail: "" });
      }
    }
    if (Object.keys(files).length > 0) {
      manifest.files = files;
      lock.files = lockFiles;
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

function sameFileEntry(a: LockFileEntry, b: LockFileEntry): boolean {
  if (a.sha256 !== undefined || b.sha256 !== undefined) return a.sha256 === b.sha256;
  if (a.files === undefined || b.files === undefined) return a.files === b.files;
  return sameRecord(a.files, b.files);
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

function copySections(sections: Record<Kind, Record<string, string>>): Record<Kind, Record<string, string>> {
  const out = Object.create(null) as Record<Kind, Record<string, string>>;
  for (const kind of KINDS) {
    const copy = Object.create(null) as Record<string, string>;
    for (const name of Object.keys(sections[kind]).sort()) {
      copy[name] = sections[kind][name]!;
    }
    out[kind] = copy;
  }
  return out;
}
