import { describe, expect, it } from "vitest";
import { runCheck } from "../src/check.js";
import { emptyLock } from "../src/lock.js";
import { sha256 } from "../src/hash.js";
import type { Kind, Manifest, ScanResult, TrackedInput } from "../src/types.js";

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
  const EXT = "github:acme/tools@main";

  function lockWithParent(name: string, ext: string | undefined = EXT): ReturnType<typeof emptyLock> {
    const lock = emptyLock();
    if (ext !== undefined) lock.extends = ext;
    lock.extendsCommit = "a".repeat(40);
    const sections = Object.create(null) as Record<Kind, Record<string, string>>;
    for (const kind of ["skills", "agents", "commands"] as const) {
      sections[kind] = Object.create(null) as Record<string, string>;
    }
    sections.skills[name] = "github:acme/tools/skills/" + name;
    lock.extendsManifest = sections;
    return lock;
  }

  const manifestWithExtends = (ext = EXT): Manifest => ({ version: 1, extends: ext, skills: {}, agents: {}, commands: {} });

  it("does not warn for a folder the parent manifest approves (fresh pin)", () => {
    const r = runCheck(manifestWithExtends(), lockWithParent("brainstorming"), scanWith("brainstorming", "x"));
    expect(r.findings).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it("still warns for a folder neither manifest approves", () => {
    const r = runCheck(manifestWithExtends(), lockWithParent("brainstorming"), scanWith("stray", "x"));
    expect(r.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unlisted", name: "stray" })]),
    );
  });

  it("a stale pin fails extends/unsynced and no longer suppresses the unlisted warning", () => {
    const r = runCheck(manifestWithExtends("github:acme/other@main"), lockWithParent("brainstorming"), scanWith("brainstorming", "x"));
    expect(r.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "fail", kind: "extends", name: "", code: "unsynced" }),
        expect.objectContaining({ level: "warn", code: "unlisted", name: "brainstorming" }),
      ]),
    );
    expect(r.exitCode).toBe(1);
  });
});

describe("runCheck extends freshness messages", () => {
  it("fails when the manifest sets extends but the lock has no pin", () => {
    const m: Manifest = { version: 1, extends: "github:acme/policy@main", skills: {}, agents: {}, commands: {} };
    const r = runCheck(m, emptyLock(), { units: [] });
    expect(r.findings).toEqual([
      expect.objectContaining({
        level: "fail",
        kind: "extends",
        name: "",
        code: "unsynced",
        message: 'extends "github:acme/policy@main" is not pinned in harness.lock; run agpm sync and approve the diff by PR',
      }),
    ]);
    expect(r.exitCode).toBe(1);
  });

  it("fails when the lock still pins extends the manifest dropped", () => {
    const lock = emptyLock();
    lock.extends = "github:acme/policy@main";
    const r = runCheck(manifest({}), lock, { units: [] });
    expect(r.findings).toEqual([
      expect.objectContaining({
        level: "fail",
        kind: "extends",
        name: "",
        code: "unsynced",
        message: 'harness.json has no extends but harness.lock still pins "github:acme/policy@main"; run agpm sync and approve the diff by PR',
      }),
    ]);
    expect(r.exitCode).toBe(1);
  });

  it("fails when the manifest and lock extends values differ", () => {
    const m: Manifest = { version: 1, extends: "github:acme/policy@main", skills: {}, agents: {}, commands: {} };
    const lock = emptyLock();
    lock.extends = "github:acme/other@main";
    const r = runCheck(m, lock, { units: [] });
    expect(r.findings).toEqual([
      expect.objectContaining({
        level: "fail",
        kind: "extends",
        name: "",
        code: "unsynced",
        message: 'harness.json extends "github:acme/policy@main" but harness.lock pins "github:acme/other@main"; run agpm sync and approve the diff by PR',
      }),
    ]);
    expect(r.exitCode).toBe(1);
  });

  it("stays clean when manifest and lock extends agree (both absent)", () => {
    const r = runCheck(manifest({}), emptyLock(), { units: [] });
    expect(r.findings).toEqual([]);
    expect(r.exitCode).toBe(0);
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

describe("runCheck tracked files", () => {
  const H = sha256("x");
  const note = (path: string): { path: string; message: string } => ({
    path,
    message: `${path} exists on disk but nobody tracks it in harness.json; run agpm track ${path}`,
  });

  it("merges tracked-file findings and candidate warnings", () => {
    const m = { ...manifest({}), files: { "CLAUDE.md": "local" } };
    const lock = emptyLock();
    lock.files = { "CLAUDE.md": { source: "local", sha256: H } };
    const tracked: TrackedInput = {
      scan: { "CLAUDE.md": { status: "file", sha256: sha256("CHANGED") } },
      candidates: [note(".mcp.json")],
    };
    const r = runCheck(m, lock, { units: [] }, {}, tracked);
    expect(r.findings).toEqual([
      expect.objectContaining({ kind: "files", name: "CLAUDE.md", code: "drifted", level: "fail" }),
      expect.objectContaining({ kind: "files", name: ".mcp.json", code: "unlisted", level: "warn" }),
    ]);
    expect(r.exitCode).toBe(1);
  });

  it("promotes candidate warnings to fail under strict", () => {
    const tracked: TrackedInput = { scan: {}, candidates: [note("CLAUDE.md")] };
    const r = runCheck(manifest({}), emptyLock(), { units: [] }, { strict: true }, tracked);
    expect(r.findings[0]).toMatchObject({ level: "fail", code: "unlisted", kind: "files" });
    expect(r.exitCode).toBe(1);
  });

  it("skips candidate warnings for already-tracked paths", () => {
    const m = { ...manifest({}), files: { "CLAUDE.md": "local" } };
    const lock = emptyLock();
    lock.files = { "CLAUDE.md": { source: "local", sha256: H } };
    const tracked: TrackedInput = {
      scan: { "CLAUDE.md": { status: "file", sha256: H } },
      candidates: [note("CLAUDE.md")],
    };
    expect(runCheck(m, lock, { units: [] }, {}, tracked).findings).toEqual([]);
  });

  it("behaves exactly as before when no tracked input is given", () => {
    const r = runCheck(manifest({}), emptyLock(), { units: [] });
    expect(r.findings).toEqual([]);
    expect(r.exitCode).toBe(0);
  });
});
