import { describe, expect, it } from "vitest";
import { computeSync } from "../src/sync.js";
import { emptyLock } from "../src/lock.js";
import { emptyManifest } from "../src/manifest.js";
import { sha256 } from "../src/hash.js";
import type { Lock, Manifest, ResolvedExtends, ScanResult, TrackedScan } from "../src/types.js";

const noSources: Record<string, string> = Object.create(null);

const scanWith = (name: string, content: string, dirs = [".claude/skills"]): ScanResult => ({
  units: [{ kind: "skills", name, locations: dirs.map((dir) => ({ dir, files: { "SKILL.md": sha256(content) } })) }],
});

const manifestWith = (name: string, source: string): Manifest => {
  const m = emptyManifest();
  m.skills[name] = source;
  return m;
};

const lockWith = (name: string, content: string, source = "local", dirs = [".claude/skills"]): Lock => {
  const l = emptyLock();
  l.skills[name] = { source, dirs: [...dirs].sort(), files: { "SKILL.md": sha256(content) } };
  return l;
};

describe("computeSync", () => {
  it("adds a new folder with lockfile provenance when available, else local", () => {
    const sources: Record<string, string> = Object.create(null);
    sources["a"] = "github:o/r/skills/a";
    const r = computeSync(emptyManifest(), emptyLock(), scanWith("a", "x"), sources);
    expect(r.manifest.skills["a"]).toBe("github:o/r/skills/a");
    expect(r.lock.skills["a"]!.source).toBe("github:o/r/skills/a");
    expect(r.changes).toEqual([{ action: "added", kind: "skills", name: "a", detail: "github:o/r/skills/a" }]);
    const local = computeSync(emptyManifest(), emptyLock(), scanWith("b", "y"), noSources);
    expect(local.manifest.skills["b"]).toBe("local");
  });

  it("keeps the source sticky and reports changed bytes as updated", () => {
    const r = computeSync(
      manifestWith("a", "github:o/r/skills/a"),
      lockWith("a", "old", "github:o/r/skills/a"),
      scanWith("a", "new"),
      noSources,
    );
    expect(r.manifest.skills["a"]).toBe("github:o/r/skills/a");
    expect(r.lock.skills["a"]!.files["SKILL.md"]).toBe(sha256("new"));
    expect(r.changes).toEqual([{ action: "updated", kind: "skills", name: "a", detail: "1 file changed" }]);
  });

  it("removes entries whose folder disappeared", () => {
    const r = computeSync(manifestWith("gone", "local"), lockWith("gone", "x"), { units: [] }, noSources);
    expect(Object.keys(r.manifest.skills)).toEqual([]);
    expect(Object.keys(r.lock.skills)).toEqual([]);
    expect(r.changes).toEqual([{ action: "removed", kind: "skills", name: "gone", detail: "" }]);
  });

  it("reports no changes when disk matches the files, and output round-trips byte-identically", () => {
    const r = computeSync(manifestWith("a", "local"), lockWith("a", "x"), scanWith("a", "x"), noSources);
    expect(r.changes).toEqual([]);
    expect(r.manifest.skills["a"]).toBe("local");
  });

  it("creates a missing lock entry for a manifest-listed unit as updated", () => {
    const r = computeSync(manifestWith("a", "local"), emptyLock(), scanWith("a", "x"), noSources);
    expect(r.changes).toEqual([{ action: "updated", kind: "skills", name: "a", detail: "lock entry created" }]);
    expect(r.lock.skills["a"]!.files["SKILL.md"]).toBe(sha256("x"));
  });

  it("preserves extends and extendsCommit untouched", () => {
    const m = emptyManifest();
    m.extends = "github:acme/policy@main";
    const l = emptyLock();
    l.extendsCommit = "a".repeat(40);
    const r = computeSync(m, l, { units: [] }, noSources);
    expect(r.manifest.extends).toBe("github:acme/policy@main");
    expect(r.lock.extendsCommit).toBe("a".repeat(40));
  });

  it("does not mutate its inputs", () => {
    const m = manifestWith("a", "local");
    const l = emptyLock();
    computeSync(m, l, scanWith("a", "x"), noSources);
    expect(Object.keys(l.skills)).toEqual([]);
    expect(m.skills["a"]).toBe("local");
  });

  it("skips a folder name it could not parse back, with a note, and keeps valid siblings", () => {
    const scan: ScanResult = {
      units: [...scanWith("__proto__", "x").units, ...scanWith("good", "y").units],
    };
    const r = computeSync(emptyManifest(), emptyLock(), scan, noSources);
    expect(Object.hasOwn(r.manifest.skills, "__proto__")).toBe(false);
    expect(Object.hasOwn(r.lock.skills, "__proto__")).toBe(false);
    expect(r.manifest.skills["good"]).toBe("local");
    expect(r.changes).toEqual([{ action: "added", kind: "skills", name: "good", detail: "local" }]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain("__proto__");
    expect(r.notes[0]).toContain("rename");
  });

  it("records both dirs and uses the first-sorting location's files", () => {
    const r = computeSync(emptyManifest(), emptyLock(), scanWith("a", "x", [".claude/skills", ".agents/skills"]), noSources);
    expect(r.lock.skills["a"]!.dirs).toEqual([".agents/skills", ".claude/skills"]);
    expect(r.lock.skills["a"]!.files["SKILL.md"]).toBe(sha256("x"));
  });

  it("removes a lock-only entry that has no manifest entry and no scanned unit", () => {
    const r = computeSync(emptyManifest(), lockWith("ghost", "x"), { units: [] }, noSources);
    expect(r.changes).toEqual([{ action: "removed", kind: "skills", name: "ghost", detail: "" }]);
    expect(Object.keys(r.lock.skills)).toEqual([]);
  });

  it("emits a note when a unit is split across locations with different bytes", () => {
    const scan: ScanResult = {
      units: [
        {
          kind: "skills",
          name: "a",
          locations: [
            { dir: ".claude/skills", files: { "SKILL.md": sha256("x") } },
            { dir: ".agents/skills", files: { "SKILL.md": sha256("y") } },
          ],
        },
      ],
    };
    const r = computeSync(emptyManifest(), emptyLock(), scan, noSources);
    expect(r.notes).toEqual([
      "skills/a differs between .agents/skills and .claude/skills; recorded files from .agents/skills; agpm cannot reconcile the copies",
    ]);
  });

  it("emits no note when a split unit's locations agree", () => {
    const r = computeSync(emptyManifest(), emptyLock(), scanWith("a", "x", [".claude/skills", ".agents/skills"]), noSources);
    expect(r.notes).toEqual([]);
  });

  it("pins extendsCommit and extendsManifest from the resolved extends", () => {
    const m = emptyManifest();
    m.extends = "github:acme/policy@main";
    const resolved: ResolvedExtends = {
      commit: "b".repeat(40),
      sections: { skills: { brainstorming: "github:obra/superpowers/skills/brainstorming" }, agents: {}, commands: {} },
    };
    const r = computeSync(m, emptyLock(), { units: [] }, noSources, resolved);
    expect(r.lock.extendsCommit).toBe("b".repeat(40));
    expect(r.lock.extendsManifest?.skills["brainstorming"]).toBe("github:obra/superpowers/skills/brainstorming");
    expect(r.lock.extends).toBe("github:acme/policy@main");
    expect(r.manifest.extends).toBe("github:acme/policy@main");
  });

  it("does not alias the resolved sections into the lock", () => {
    const m = emptyManifest();
    m.extends = "github:acme/policy@main";
    const resolved: ResolvedExtends = {
      commit: "b".repeat(40),
      sections: { skills: { a: "local" }, agents: {}, commands: {} },
    };
    const r = computeSync(m, emptyLock(), { units: [] }, noSources, resolved);
    resolved.sections.skills["a"] = "unknown";
    expect(r.lock.extendsManifest?.skills["a"]).toBe("local");
  });

  it("drops the pin when the manifest no longer extends", () => {
    const l = emptyLock();
    l.extends = "github:acme/policy@main";
    l.extendsCommit = "a".repeat(40);
    l.extendsManifest = { skills: {}, agents: {}, commands: {} };
    const r = computeSync(emptyManifest(), l, { units: [] }, noSources);
    expect(r.lock.extends).toBeUndefined();
    expect(r.lock.extendsCommit).toBeUndefined();
    expect(r.lock.extendsManifest).toBeUndefined();
  });

  it("carries the previous pin when extends is set but no resolution was provided", () => {
    const m = emptyManifest();
    m.extends = "github:acme/policy@main";
    const l = emptyLock();
    l.extends = "github:acme/policy@main";
    l.extendsCommit = "a".repeat(40);
    l.extendsManifest = { skills: { a: "local" }, agents: {}, commands: {} };
    const r = computeSync(m, l, { units: [] }, noSources);
    expect(r.lock.extends).toBe("github:acme/policy@main");
    expect(r.lock.extendsCommit).toBe("a".repeat(40));
    expect(r.lock.extendsManifest?.skills["a"]).toBe("local");
  });
});

describe("computeSync tracked files", () => {
  const H = sha256("x");
  const noScan = { units: [] };

  it("adds a newly declared tracked file", () => {
    const prev = { ...emptyManifest(), files: { "CLAUDE.md": "local" } };
    const tracked: TrackedScan = { "CLAUDE.md": { status: "file", sha256: H } };
    const r = computeSync(prev, emptyLock(), noScan, {}, undefined, tracked);
    expect(r.manifest.files).toEqual({ "CLAUDE.md": "local" });
    expect(r.lock.files).toEqual({ "CLAUDE.md": { source: "local", sha256: H } });
    expect(r.changes).toEqual([{ action: "added", kind: "files", name: "CLAUDE.md", detail: "local" }]);
  });

  it("updates a drifted tracked file and keeps a matching one silent", () => {
    const prev = { ...emptyManifest(), files: { "CLAUDE.md": "local", "AGENTS.md": "local" } };
    const prevLock = emptyLock();
    prevLock.files = {
      "CLAUDE.md": { source: "local", sha256: sha256("old") },
      "AGENTS.md": { source: "local", sha256: H },
    };
    const tracked: TrackedScan = {
      "CLAUDE.md": { status: "file", sha256: H },
      "AGENTS.md": { status: "file", sha256: H },
    };
    const r = computeSync(prev, prevLock, noScan, {}, undefined, tracked);
    expect(r.changes).toEqual([{ action: "updated", kind: "files", name: "CLAUDE.md", detail: "" }]);
    expect(r.lock.files!["CLAUDE.md"]).toEqual({ source: "local", sha256: H });
  });

  it("records directory entries", () => {
    const prev = { ...emptyManifest(), files: { hooks: "local" } };
    const tracked: TrackedScan = { hooks: { status: "dir", files: { "guard.sh": H } } };
    const r = computeSync(prev, emptyLock(), noScan, {}, undefined, tracked);
    expect(r.lock.files).toEqual({ hooks: { source: "local", files: { "guard.sh": H } } });
  });

  it("removes a tracked path that left the disk", () => {
    const prev = { ...emptyManifest(), files: { "CLAUDE.md": "local" } };
    const prevLock = emptyLock();
    prevLock.files = { "CLAUDE.md": { source: "local", sha256: H } };
    const tracked: TrackedScan = { "CLAUDE.md": { status: "missing" } };
    const r = computeSync(prev, prevLock, noScan, {}, undefined, tracked);
    expect(r.manifest.files).toBeUndefined();
    expect(r.lock.files).toBeUndefined();
    expect(r.changes).toEqual([{ action: "removed", kind: "files", name: "CLAUDE.md", detail: "" }]);
  });

  it("drops a lock-only files entry", () => {
    const prevLock = emptyLock();
    prevLock.files = { "CLAUDE.md": { source: "local", sha256: H } };
    const r = computeSync(emptyManifest(), prevLock, noScan, {}, undefined, {});
    expect(r.lock.files).toBeUndefined();
    expect(r.changes).toEqual([{ action: "removed", kind: "files", name: "CLAUDE.md", detail: "" }]);
  });

  it("leaves files sections absent when nothing is tracked", () => {
    const r = computeSync(emptyManifest(), emptyLock(), noScan, {});
    expect(r.manifest.files).toBeUndefined();
    expect(r.lock.files).toBeUndefined();
  });

  it("carries tracked files through unchanged when no tracked scan is given", () => {
    // install, remove, and update call computeSync without a tracked scan;
    // an omitted scan must never remove tracked files.
    const prev = { ...emptyManifest(), files: { "CLAUDE.md": "local" } };
    const prevLock = emptyLock();
    prevLock.files = { "CLAUDE.md": { source: "local", sha256: H } };
    const r = computeSync(prev, prevLock, noScan, {});
    expect(r.manifest.files).toEqual({ "CLAUDE.md": "local" });
    expect(r.lock.files).toEqual({ "CLAUDE.md": { source: "local", sha256: H } });
    expect(r.changes).toEqual([]);
  });
});
