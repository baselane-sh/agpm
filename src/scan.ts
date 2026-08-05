import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AgpmError } from "./errors.js";
import { hashDir, sha256 } from "./hash.js";
import type { Kind, ScanResult, ScannedUnit } from "./types.js";

const SKILL_DIRS = [".agents/skills", ".claude/skills"];
const FILE_DIRS: [Kind, string][] = [
  ["agents", ".claude/agents"],
  ["commands", ".claude/commands"],
];

export async function scanRepo(root: string): Promise<ScanResult> {
  const skills = new Map<string, ScannedUnit>();
  for (const dir of SKILL_DIRS) {
    for (const entry of await listDir(join(root, dir))) {
      refuseSymlink(entry, join(root, dir, entry.name));
      if (!entry.isDirectory()) continue;
      const files = await hashDir(join(root, dir, entry.name));
      const unit = skills.get(entry.name) ?? { kind: "skills" as Kind, name: entry.name, locations: [] };
      skills.set(entry.name, { ...unit, locations: [...unit.locations, { dir, files }] });
    }
  }
  const units: ScannedUnit[] = [...skills.values()];
  for (const [kind, dir] of FILE_DIRS) {
    for (const entry of await listDir(join(root, dir))) {
      refuseSymlink(entry, join(root, dir, entry.name));
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const content = await readFile(join(root, dir, entry.name));
      units.push({
        kind,
        name: entry.name.slice(0, -3),
        locations: [{ dir, files: { [entry.name]: sha256(content) } }],
      });
    }
  }
  const order: Record<Kind, number> = { skills: 0, agents: 1, commands: 2 };
  units.sort((a, b) => order[a.kind] - order[b.kind] || (a.name < b.name ? -1 : 1));
  return { units };
}

function refuseSymlink(entry: { isSymbolicLink(): boolean }, abs: string): void {
  if (entry.isSymbolicLink()) {
    throw new AgpmError(`refusing symlink at ${abs}; agpm scans regular files and directories only`);
  }
}

async function listDir(abs: string) {
  try {
    return await readdir(abs, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
