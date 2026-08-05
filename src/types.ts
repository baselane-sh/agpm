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
}

export interface LockEntry {
  source: string; // provenance string
  dirs: string[]; // repo-relative dirs, sorted
  files: Record<string, string>; // relpath -> "sha256:<64 hex>", sorted
}

export interface Lock {
  version: 1;
  extends?: string; // the manifest extends value this pin was resolved from
  extendsCommit?: string; // 40 lowercase hex
  extendsManifest?: Record<Kind, Record<string, string>>; // parent name -> provenance, pinned at extendsCommit
  skills: Record<string, LockEntry>;
  agents: Record<string, LockEntry>;
  commands: Record<string, LockEntry>;
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
  kind: Kind | "extends";
  name: string;
  code: FindingCode;
  message: string;
}

export interface CheckResult {
  findings: Finding[]; // sorted by kind then name
  exitCode: 0 | 1;
}
