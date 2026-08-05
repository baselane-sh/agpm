import { describe, expect, it } from "vitest";
import { emptyLock } from "../src/lock.js";
import { formatList } from "../src/list.js";
import { sha256 } from "../src/hash.js";
import type { Manifest, ScanResult } from "../src/types.js";

const manifest: Manifest = { version: 1, skills: { a: "local" }, agents: {}, commands: {} };

const scanWith = (name: string, content: string): ScanResult => ({
  units: [{ kind: "skills", name, locations: [{ dir: ".claude/skills", files: { "SKILL.md": sha256(content) } }] }],
});

describe("formatList", () => {
  it("shows ok, unlisted, and missing statuses with sources", () => {
    const lock = emptyLock();
    lock.skills["a"] = { source: "local", dirs: [".claude/skills"], files: { "SKILL.md": sha256("x") } };
    const scan: ScanResult = {
      units: [
        { kind: "skills", name: "a", locations: [{ dir: ".claude/skills", files: { "SKILL.md": sha256("x") } }] },
        { kind: "skills", name: "stray", locations: [{ dir: ".claude/skills", files: { "SKILL.md": sha256("y") } }] },
      ],
    };
    const lines = formatList(manifest, lock, scan);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^skills\s+a\s+ok\s+local$/);
    expect(lines[1]).toMatch(/^skills\s+stray\s+unlisted\s+unknown$/);
  });

  it("maps unsynced to drifted (spec fixes the four display states)", () => {
    const lines = formatList(manifest, emptyLock(), { units: [] });
    expect(lines[0]).toMatch(/^skills\s+a\s+drifted\s+local$/);
  });

  it("shows the parent source for an extends-approved entry", () => {
    const lock = emptyLock();
    lock.extendsCommit = "a".repeat(40);
    const sections = Object.create(null) as Record<"skills" | "agents" | "commands", Record<string, string>>;
    for (const kind of ["skills", "agents", "commands"] as const) sections[kind] = Object.create(null) as Record<string, string>;
    sections.skills["blessed"] = "github:acme/tools/skills/blessed";
    lock.extendsManifest = sections;
    const lines = formatList({ version: 1, skills: {}, agents: {}, commands: {} }, lock, scanWith("blessed", "x"));
    expect(lines[0]).toMatch(/^skills\s+blessed\s+ok\s+github:acme\/tools\/skills\/blessed$/);
  });
});
