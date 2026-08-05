import { describe, expect, it } from "vitest";
import { runCheck } from "../src/check.js";
import { emptyLock } from "../src/lock.js";
import { sha256 } from "../src/hash.js";
import type { Manifest, ScanResult } from "../src/types.js";

const manifest = (skills: Record<string, string>): Manifest => ({
  version: 1, skills, agents: {}, commands: {},
});

const scanWith = (name: string, content: string, dirs = [".claude/skills"]): ScanResult => ({
  units: [{ kind: "skills", name, locations: dirs.map((dir) => ({ dir, files: { "SKILL.md": sha256(content) } })) }],
});

function lockWith(name: string, content: string, dirs = [".claude/skills"]) {
  const lock = emptyLock();
  lock.skills[name] = { source: "local", dirs: [...dirs].sort(), files: { "SKILL.md": sha256(content) } };
  return lock;
}

describe("runCheck", () => {
  it("is clean when disk matches lock and manifest", () => {
    const r = runCheck(manifest({ a: "local" }), lockWith("a", "x"), scanWith("a", "x"));
    expect(r.findings).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it("fails unsynced when manifest and lock disagree", () => {
    const r = runCheck(manifest({ a: "local" }), emptyLock(), scanWith("a", "x"));
    expect(r.findings).toEqual([
      expect.objectContaining({ level: "fail", code: "unsynced", name: "a" }),
    ]);
    expect(r.exitCode).toBe(1);
  });

  it("fails missing when a locked entry has no folder", () => {
    const r = runCheck(manifest({ a: "local" }), lockWith("a", "x"), { units: [] });
    expect(r.findings[0]).toMatchObject({ level: "fail", code: "missing" });
  });

  it("fails drifted when bytes differ from the lock", () => {
    const r = runCheck(manifest({ a: "local" }), lockWith("a", "x"), scanWith("a", "CHANGED"));
    expect(r.findings[0]).toMatchObject({ level: "fail", code: "drifted" });
  });

  it("fails drifted when the dirs changed", () => {
    const both = [".agents/skills", ".claude/skills"];
    const r = runCheck(manifest({ a: "local" }), lockWith("a", "x", both), scanWith("a", "x"));
    expect(r.findings[0]).toMatchObject({ level: "fail", code: "drifted" });
  });

  it("fails split when the two skills dirs disagree with each other", () => {
    const scan: ScanResult = {
      units: [{
        kind: "skills", name: "a",
        locations: [
          { dir: ".agents/skills", files: { "SKILL.md": sha256("one") } },
          { dir: ".claude/skills", files: { "SKILL.md": sha256("two") } },
        ],
      }],
    };
    const both = [".agents/skills", ".claude/skills"];
    const r = runCheck(manifest({ a: "local" }), lockWith("a", "one", both), scan);
    expect(r.findings[0]).toMatchObject({ level: "fail", code: "split" });
  });

  it("warns unlisted for a folder in neither file, exit 0", () => {
    const r = runCheck(manifest({}), emptyLock(), scanWith("stray", "x"));
    expect(r.findings).toEqual([
      expect.objectContaining({ level: "warn", code: "unlisted", name: "stray" }),
    ]);
    expect(r.exitCode).toBe(0);
  });
});

describe("runCheck prototype-name hardening", () => {
  it("fails unsynced when the lock approves a prototype-named entry the manifest does not", () => {
    const r = runCheck(manifest({}), lockWith("toString", "x"), scanWith("toString", "x"));
    expect(r.findings).toEqual([
      expect.objectContaining({ level: "fail", code: "unsynced", name: "toString" }),
    ]);
    expect(r.exitCode).toBe(1);
  });

  it("warns unlisted for a stray skill named toString instead of crashing", () => {
    const r = runCheck(manifest({}), emptyLock(), scanWith("toString", "x"));
    expect(r.findings).toEqual([
      expect.objectContaining({ level: "warn", code: "unlisted", name: "toString" }),
    ]);
    expect(r.exitCode).toBe(0);
  });
});

describe("runCheck with extends", () => {
  function lockWithParent(name: string): ReturnType<typeof emptyLock> {
    const lock = emptyLock();
    lock.extendsCommit = "a".repeat(40);
    const sections = Object.create(null) as Record<"skills" | "agents" | "commands", Record<string, string>>;
    for (const kind of ["skills", "agents", "commands"] as const) {
      sections[kind] = Object.create(null) as Record<string, string>;
    }
    sections.skills[name] = "github:acme/tools/skills/" + name;
    lock.extendsManifest = sections;
    return lock;
  }

  it("does not warn for a folder the parent manifest approves", () => {
    const r = runCheck(manifest({}), lockWithParent("brainstorming"), scanWith("brainstorming", "x"));
    expect(r.findings).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it("still warns for a folder neither manifest approves", () => {
    const r = runCheck(manifest({}), lockWithParent("brainstorming"), scanWith("stray", "x"));
    expect(r.findings).toEqual([expect.objectContaining({ code: "unlisted", name: "stray" })]);
  });
});

describe("runCheck strict", () => {
  it("escalates unlisted to fail and exit 1", () => {
    const r = runCheck(manifest({}), emptyLock(), scanWith("stray", "x"), { strict: true });
    expect(r.findings).toEqual([
      expect.objectContaining({ level: "fail", code: "unlisted", name: "stray" }),
    ]);
    expect(r.exitCode).toBe(1);
  });

  it("changes nothing on a clean repo", () => {
    const r = runCheck(manifest({ a: "local" }), lockWith("a", "x"), scanWith("a", "x"), { strict: true });
    expect(r.findings).toEqual([]);
    expect(r.exitCode).toBe(0);
  });
});
