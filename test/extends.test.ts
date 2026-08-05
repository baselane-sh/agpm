import { describe, expect, it } from "vitest";
import { parseExtends, parentApproval, resolveExtends, type ExtendsFetcher, type ExtendsRef } from "../src/extends.js";
import { emptyLock } from "../src/lock.js";
import type { Kind, Manifest } from "../src/types.js";

const parentManifest = JSON.stringify({
  version: 1,
  skills: { brainstorming: "github:obra/superpowers/skills/brainstorming" },
  agents: {},
  commands: {},
});

function fakeFetcher(commit: string, manifestText: string): ExtendsFetcher {
  return {
    resolveCommit: async (_ref: ExtendsRef) => commit,
    fetchManifest: async (_ref: ExtendsRef, _commit: string) => manifestText,
  };
}

describe("parseExtends", () => {
  it("splits owner, repo, and ref", () => {
    expect(parseExtends("github:acme/policy@main")).toEqual({ owner: "acme", repo: "policy", ref: "main" });
  });

  it("rejects anything that is not github:owner/repo@ref", () => {
    expect(() => parseExtends("gitlab:acme/policy@main")).toThrow(/github:owner\/repo@ref/);
    expect(() => parseExtends("github:acme@main")).toThrow(/github:owner\/repo@ref/);
  });

  it("rejects a dot-segment owner or repo (path traversal guard)", () => {
    expect(() => parseExtends("github:../..@main")).toThrow(/github:owner\/repo@ref/);
    expect(() => parseExtends("github:./x@main")).toThrow(/github:owner\/repo@ref/);
  });
});

describe("resolveExtends", () => {
  it("pins the commit and copies the parent sections", async () => {
    const r = await resolveExtends("github:acme/policy@main", fakeFetcher("a".repeat(40), parentManifest));
    expect(r.commit).toBe("a".repeat(40));
    expect(r.sections.skills["brainstorming"]).toBe("github:obra/superpowers/skills/brainstorming");
    expect(Object.keys(r.sections.agents)).toEqual([]);
  });

  it("rejects a resolved commit that is not 40 hex", async () => {
    await expect(resolveExtends("github:acme/policy@main", fakeFetcher("main", parentManifest))).rejects.toThrow(/40 hex/);
  });

  it("rejects a broken parent harness.json and names the policy repo", async () => {
    await expect(resolveExtends("github:acme/policy@main", fakeFetcher("a".repeat(40), "{nope"))).rejects.toThrow(/acme\/policy/);
  });

  it("refuses a parent that itself extends another repo", async () => {
    const nested = JSON.stringify({ version: 1, extends: "github:root/policy@main", skills: {}, agents: {}, commands: {} });
    await expect(resolveExtends("github:acme/policy@main", fakeFetcher("a".repeat(40), nested))).rejects.toThrow(/nested extends is not supported/);
  });
});

describe("parentApproval", () => {
  const EXT = "github:acme/policy@main";
  const manifestWith = (ext: string): Manifest => ({ version: 1, extends: ext, skills: {}, agents: {}, commands: {} });

  it("returns the parent source when the pinned manifest lists the name", () => {
    const manifest = manifestWith(EXT);
    const lock = emptyLock();
    lock.extends = EXT;
    lock.extendsCommit = "a".repeat(40);
    const sections = Object.create(null) as Record<Kind, Record<string, string>>;
    for (const kind of ["skills", "agents", "commands"] as const) {
      sections[kind] = Object.create(null) as Record<string, string>;
    }
    sections.skills["brainstorming"] = "github:obra/superpowers/skills/brainstorming";
    lock.extendsManifest = sections;
    expect(parentApproval(manifest, lock, "skills", "brainstorming")).toBe("github:obra/superpowers/skills/brainstorming");
    expect(parentApproval(manifest, lock, "skills", "other")).toBeUndefined();
    expect(parentApproval(manifest, emptyLock(), "skills", "brainstorming")).toBeUndefined();
  });

  it("treats prototype names as plain data", () => {
    const manifest = manifestWith(EXT);
    const lock = emptyLock();
    lock.extends = EXT;
    lock.extendsCommit = "a".repeat(40);
    const sections = Object.create(null) as Record<Kind, Record<string, string>>;
    for (const kind of ["skills", "agents", "commands"] as const) {
      sections[kind] = Object.create(null) as Record<string, string>;
    }
    lock.extendsManifest = sections;
    expect(parentApproval(manifest, lock, "skills", "toString")).toBeUndefined();
  });

  it("returns undefined when the manifest's extends differs from the lock's pin (stale)", () => {
    const manifest = manifestWith("github:acme/other@main");
    const lock = emptyLock();
    lock.extends = EXT;
    lock.extendsCommit = "a".repeat(40);
    const sections = Object.create(null) as Record<Kind, Record<string, string>>;
    for (const kind of ["skills", "agents", "commands"] as const) {
      sections[kind] = Object.create(null) as Record<string, string>;
    }
    sections.skills["brainstorming"] = "github:obra/superpowers/skills/brainstorming";
    lock.extendsManifest = sections;
    expect(parentApproval(manifest, lock, "skills", "brainstorming")).toBeUndefined();
  });

  it("returns undefined when the manifest has no extends but the lock still pins one", () => {
    const manifest: Manifest = { version: 1, skills: {}, agents: {}, commands: {} };
    const lock = emptyLock();
    lock.extends = EXT;
    lock.extendsCommit = "a".repeat(40);
    const sections = Object.create(null) as Record<Kind, Record<string, string>>;
    for (const kind of ["skills", "agents", "commands"] as const) {
      sections[kind] = Object.create(null) as Record<string, string>;
    }
    sections.skills["brainstorming"] = "github:obra/superpowers/skills/brainstorming";
    lock.extendsManifest = sections;
    expect(parentApproval(manifest, lock, "skills", "brainstorming")).toBeUndefined();
  });
});
