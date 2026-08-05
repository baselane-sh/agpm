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
