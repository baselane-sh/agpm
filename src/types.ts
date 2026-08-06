export type Kind = "skills" | "agents" | "commands";
export const KINDS: readonly Kind[] = ["skills", "agents", "commands"];

export interface ExtendsRef {
  owner: string;
  repo: string;
  ref: string;
}

export interface Manifest {
  version: 1;
  extends?: string; // "github:owner/repo@ref"
  skills: Record<string, string>; // name -> provenance
  agents: Record<string, string>;
  commands: Record<string, string>;
  files?: Record<string, string>; // tracked repo-relative path -> "local"
}

export interface LockEntry {
  source: string; // provenance string
  dirs: string[]; // repo-relative dirs, sorted
  files: Record<string, string>; // relpath -> "sha256:<64 hex>", sorted
}

export interface LockFileEntry {
  source: string; // always "local" in v1
  sha256?: string; // single file: "sha256:<64 hex>"
  files?: Record<string, string>; // directory: relpath inside the dir -> "sha256:<64 hex>", sorted
}

export interface Lock {
  version: 1;
  extends?: string; // the manifest extends value this pin was resolved from
  extendsCommit?: string; // 40 lowercase hex
  extendsManifest?: Record<Kind, Record<string, string>>; // parent name -> provenance, pinned at extendsCommit
  skills: Record<string, LockEntry>;
  agents: Record<string, LockEntry>;
  commands: Record<string, LockEntry>;
  files?: Record<string, LockFileEntry>; // tracked path -> approved hashes
}

export interface ResolvedExtends {
  commit: string; // 40 lowercase hex
  sections: Record<Kind, Record<string, string>>; // parent name -> provenance per kind
}

export interface ScannedLocation {
  dir: string; // repo-relative, e.g. ".claude/skills"
  files: Record<string, string>; // relpath inside the unit -> "sha256:..."
}

export interface ScannedUnit {
  kind: Kind;
  name: string;
  locations: ScannedLocation[]; // 1 or 2 (skills can live in both dirs)
}

export interface ScanResult {
  units: ScannedUnit[]; // sorted by kind then name
}

export type FindingCode = "missing" | "drifted" | "split" | "unsynced" | "unlisted";

export interface Finding {
  level: "fail" | "warn";
  kind: Kind | "extends" | "files";
  name: string;
  code: FindingCode;
  message: string;
}

export interface CheckResult {
  findings: Finding[]; // sorted by kind then name
  exitCode: 0 | 1;
}

export interface TrackedFileState {
  status: "file" | "dir" | "missing";
  sha256?: string; // status "file": "sha256:<64 hex>"
  files?: Record<string, string>; // status "dir": relpath -> "sha256:<64 hex>"
}

export type TrackedScan = Record<string, TrackedFileState>;

export interface CandidateNote {
  path: string;
  message: string;
}

export interface TrackedInput {
  scan: TrackedScan;
  candidates: CandidateNote[];
}
