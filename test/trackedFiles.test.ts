import { describe, expect, it } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../src/hash.js";
import { candidateWarnings, checkTrackedFiles, scanTrackedFiles, MANAGED_ROOTS, inManagedRoot, isRepoRelative } from "../src/trackedFiles.js";
import { makeRepo } from "./helpers.js";

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

describe("scanTrackedFiles", () => {
  it("hashes a file, hashes a directory, and reports a missing path", async () => {
    const root = await makeRepo({
      "CLAUDE.md": "instructions\n",
      "hooks/guard.sh": "echo ok\n",
      "hooks/sub/extra.sh": "echo extra\n",
    });
    const scan = await scanTrackedFiles(root, { "CLAUDE.md": "local", hooks: "local", "gone.md": "local" });
    expect(scan["CLAUDE.md"]).toEqual({ status: "file", sha256: sha256("instructions\n") });
    expect(scan["hooks"]).toEqual({
      status: "dir",
      files: { "guard.sh": sha256("echo ok\n"), "sub/extra.sh": sha256("echo extra\n") },
    });
    expect(scan["gone.md"]).toEqual({ status: "missing" });
  });

  it("refuses a symlinked tracked path", async () => {
    const root = await makeRepo({ "real.md": "x\n" });
    await symlink(join(root, "real.md"), join(root, "link.md"));
    await expect(scanTrackedFiles(root, { "link.md": "local" })).rejects.toThrow(/refusing symlink at link\.md/);
  });
});

describe("checkTrackedFiles", () => {
  const H = sha256("x");
  const fileEntry = { source: "local", sha256: H };
  const fileState = { status: "file", sha256: H } as const;

  it("is clean when hashes match", () => {
    expect(checkTrackedFiles({ "CLAUDE.md": "local" }, { "CLAUDE.md": fileEntry }, { "CLAUDE.md": fileState })).toEqual([]);
  });

  it("fails drifted when bytes differ", () => {
    const findings = checkTrackedFiles(
      { "CLAUDE.md": "local" },
      { "CLAUDE.md": fileEntry },
      { "CLAUDE.md": { status: "file", sha256: sha256("CHANGED") } },
    );
    expect(findings).toEqual([
      {
        level: "fail",
        kind: "files",
        name: "CLAUDE.md",
        code: "drifted",
        message: "files/CLAUDE.md bytes differ from the approved hashes",
      },
    ]);
  });

  it("fails drifted when a tracked file became a directory", () => {
    const findings = checkTrackedFiles(
      { "CLAUDE.md": "local" },
      { "CLAUDE.md": fileEntry },
      { "CLAUDE.md": { status: "dir", files: { "a.md": H } } },
    );
    expect(findings[0]).toMatchObject({ code: "drifted" });
  });

  it("compares directory hashes", () => {
    const findings = checkTrackedFiles(
      { hooks: "local" },
      { hooks: { source: "local", files: { "guard.sh": H } } },
      { hooks: { status: "dir", files: { "guard.sh": sha256("CHANGED") } } },
    );
    expect(findings[0]).toMatchObject({ code: "drifted", name: "hooks" });
  });

  it("fails missing when the path left the disk", () => {
    const findings = checkTrackedFiles({ "CLAUDE.md": "local" }, { "CLAUDE.md": fileEntry }, { "CLAUDE.md": { status: "missing" } });
    expect(findings).toEqual([
      {
        level: "fail",
        kind: "files",
        name: "CLAUDE.md",
        code: "missing",
        message: "files/CLAUDE.md is approved in harness.json but missing on disk",
      },
    ]);
  });

  it("fails unsynced when the manifest entry has no lock entry", () => {
    const findings = checkTrackedFiles({ "CLAUDE.md": "local" }, {}, { "CLAUDE.md": fileState });
    expect(findings).toEqual([
      {
        level: "fail",
        kind: "files",
        name: "CLAUDE.md",
        code: "unsynced",
        message: "files/CLAUDE.md is approved but not hashed; run agpm sync",
      },
    ]);
  });

  it("fails unsynced when the lock has an entry the manifest does not", () => {
    const findings = checkTrackedFiles({}, { "CLAUDE.md": fileEntry }, {});
    expect(findings).toEqual([
      {
        level: "fail",
        kind: "files",
        name: "CLAUDE.md",
        code: "unsynced",
        message: "harness.json and harness.lock disagree about files/CLAUDE.md; run agpm sync and approve the diff by PR",
      },
    ]);
  });
});

describe("candidateWarnings", () => {
  it("lists CLAUDE.md, AGENTS.md, and .mcp.json when they exist", async () => {
    const root = await makeRepo({ "CLAUDE.md": "x\n", "AGENTS.md": "y\n", ".mcp.json": "{}\n" });
    const notes = await candidateWarnings(root);
    expect(notes.map((n) => n.path)).toEqual(["CLAUDE.md", "AGENTS.md", ".mcp.json"]);
    expect(notes[0]!.message).toBe(
      "CLAUDE.md exists on disk but nobody tracks it in harness.json; run agpm track CLAUDE.md",
    );
  });

  it("flags .claude/settings.json only for hooks or broken JSON", async () => {
    const withHooks = await makeRepo({ ".claude/settings.json": JSON.stringify({ hooks: {} }) });
    const hookNotes = await candidateWarnings(withHooks);
    expect(hookNotes.map((n) => n.path)).toEqual([".claude/settings.json"]);
    expect(hookNotes[0]!.message).toBe(
      ".claude/settings.json contains hooks but nobody tracks it in harness.json; run agpm track .claude/settings.json",
    );

    const broken = await makeRepo({ ".claude/settings.json": "{nope" });
    expect((await candidateWarnings(broken)).map((n) => n.path)).toEqual([".claude/settings.json"]);

    const plain = await makeRepo({ ".claude/settings.json": JSON.stringify({ theme: "dark" }) });
    expect(await candidateWarnings(plain)).toEqual([]);
  });

  it("returns nothing for an empty repo", async () => {
    const root = await makeRepo({});
    expect(await candidateWarnings(root)).toEqual([]);
  });

  it("warns instead of silently passing when a candidate is a symlink", async () => {
    const root = await makeRepo({ "real.md": "instructions\n" });
    await symlink(join(root, "real.md"), join(root, "CLAUDE.md"));
    const notes = await candidateWarnings(root);
    expect(notes).toEqual([
      { path: "CLAUDE.md", message: "CLAUDE.md is a symlink; agpm tracks regular files only; replace it with a regular file to approve it" },
    ]);
  });

  it("warns on a symlinked settings.json without reading its contents", async () => {
    const root = await makeRepo({ "real.json": JSON.stringify({ theme: "dark" }) });
    await mkdir(join(root, ".claude"), { recursive: true });
    await symlink(join(root, "real.json"), join(root, ".claude/settings.json"));
    const notes = await candidateWarnings(root);
    expect(notes).toEqual([
      {
        path: ".claude/settings.json",
        message: ".claude/settings.json is a symlink; agpm tracks regular files only; replace it with a regular file to approve it",
      },
    ]);
  });
});
