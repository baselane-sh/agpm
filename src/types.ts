export type Kind = "skills" | "agents" | "commands";
export const KINDS: readonly Kind[] = ["skills", "agents", "commands"];

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
  extendsCommit?: string; // 40 lowercase hex
  skills: Record<string, LockEntry>;
  agents: Record<string, LockEntry>;
  commands: Record<string, LockEntry>;
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
  kind: Kind;
  name: string;
  code: FindingCode;
  message: string;
}

export interface CheckResult {
  findings: Finding[]; // sorted by kind then name
  exitCode: 0 | 1;
}
