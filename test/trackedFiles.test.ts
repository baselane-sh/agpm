import { describe, expect, it } from "vitest";
import { MANAGED_ROOTS, inManagedRoot, isRepoRelative } from "../src/trackedFiles.js";

describe("isRepoRelative", () => {
  const good = ["CLAUDE.md", ".mcp.json", ".claude/settings.json", "docs/notes.md", "hooks"];
  for (const path of good) {
    it(`accepts ${path}`, () => expect(isRepoRelative(path)).toBe(true));
  }
  const bad = ["", ".", "/etc/passwd", "a//b", "a/", "./a", "../a", "a/../b", "a\\b", "C:/x", "a/."];
  for (const path of bad) {
    it(`rejects ${JSON.stringify(path)}`, () => expect(isRepoRelative(path)).toBe(false));
  }
});

describe("inManagedRoot", () => {
  it("covers the four managed roots and their children", () => {
    expect(MANAGED_ROOTS).toEqual([".agents/skills", ".claude/agents", ".claude/commands", ".claude/skills"]);
    expect(inManagedRoot(".claude/skills")).toBe(true);
    expect(inManagedRoot(".claude/skills/foo/SKILL.md")).toBe(true);
    expect(inManagedRoot(".agents/skills/x")).toBe(true);
    expect(inManagedRoot(".claude/agents/a.md")).toBe(true);
    expect(inManagedRoot(".claude/commands/c.md")).toBe(true);
  });

  it("does not match siblings or name prefixes", () => {
    expect(inManagedRoot(".claude/settings.json")).toBe(false);
    expect(inManagedRoot(".claude/skillsX")).toBe(false);
    expect(inManagedRoot("CLAUDE.md")).toBe(false);
  });
});
