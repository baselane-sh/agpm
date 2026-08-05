export type Kind = "skills" | "agents" | "commands";
export const KINDS: readonly Kind[] = ["skills", "agents", "commands"];

export interface Manifest {
  version: 1;
  extends?: string; // "github:owner/repo@ref"
  skills: Record<string, string>; // name -> provenance
  agents: Record<string, string>;
  commands: Record<string, string>;
}
