// Tracked-file path rules, shared by manifest parsing (Task 3) and the track
// command (Task 8). Scanning and checking land here in Task 5.

export const MANAGED_ROOTS: readonly string[] = [
  ".agents/skills",
  ".claude/agents",
  ".claude/commands",
  ".claude/skills",
];

const DRIVE_RE = /^[A-Za-z]:/;

export function isRepoRelative(path: string): boolean {
  if (path === "" || path.includes("\\") || DRIVE_RE.test(path)) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function inManagedRoot(path: string): boolean {
  return MANAGED_ROOTS.some((root) => path === root || path.startsWith(root + "/"));
}
