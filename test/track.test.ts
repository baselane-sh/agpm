import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/hash.js";
import { parseLock } from "../src/lock.js";
import { parseManifest } from "../src/manifest.js";
import { runTrack, runUntrack } from "../src/track.js";
import { makeRepo } from "./helpers.js";

const baseManifest = JSON.stringify({ version: 1, skills: {}, agents: {}, commands: {} });
const baseLock = JSON.stringify({ version: 1, skills: {}, agents: {}, commands: {} });

async function repoWith(files: Record<string, string>): Promise<string> {
  return makeRepo({ "harness.json": baseManifest, "harness.lock": baseLock, ...files });
}

async function readHarness(root: string) {
  const manifest = parseManifest(await readFile(join(root, "harness.json"), "utf8"), "harness.json");
  const lock = parseLock(await readFile(join(root, "harness.lock"), "utf8"), "harness.lock");
  return { manifest, lock };
}

describe("runTrack", () => {
  it("tracks a file and writes both harness files", async () => {
    const root = await repoWith({ "CLAUDE.md": "x" });
    const { lines } = await runTrack(root, "CLAUDE.md");
    expect(lines).toEqual(["tracked CLAUDE.md"]);
    const { manifest, lock } = await readHarness(root);
    expect(manifest.files).toEqual({ "CLAUDE.md": "local" });
    expect(lock.files).toEqual({ "CLAUDE.md": { source: "local", sha256: sha256("x") } });
  });

  it("tracks a directory and strips a trailing slash", async () => {
    const root = await repoWith({ "hooks/guard.sh": "echo ok\n" });
    const { lines } = await runTrack(root, "hooks/");
    expect(lines).toEqual(["tracked hooks"]);
    const { lock } = await readHarness(root);
    expect(lock.files).toEqual({ hooks: { source: "local", files: { "guard.sh": sha256("echo ok\n") } } });
  });

  it("refuses a missing path", async () => {
    const root = await repoWith({});
    await expect(runTrack(root, "nope.md")).rejects.toThrow("no such file: nope.md");
  });

  it("refuses a symlink", async () => {
    const root = await repoWith({ "real.md": "x" });
    await symlink(join(root, "real.md"), join(root, "link.md"));
    await expect(runTrack(root, "link.md")).rejects.toThrow("refusing symlink at link.md");
  });

  it("refuses a managed-root path", async () => {
    const root = await repoWith({});
    await expect(runTrack(root, ".claude/skills/foo")).rejects.toThrow(
      ".claude/skills/foo is inside a managed root; skills, agents, and commands are tracked automatically",
    );
  });

  it("refuses absolute and dotted paths", async () => {
    const root = await repoWith({});
    await expect(runTrack(root, "/etc/passwd")).rejects.toThrow("tracked paths must be repo-relative");
    await expect(runTrack(root, "../x")).rejects.toThrow("tracked paths must be repo-relative");
  });

  it("refuses an already tracked path", async () => {
    const root = await repoWith({ "CLAUDE.md": "x" });
    await runTrack(root, "CLAUDE.md");
    await expect(runTrack(root, "CLAUDE.md")).rejects.toThrow("CLAUDE.md is already tracked");
  });

  it("requires harness.json", async () => {
    const root = await makeRepo({ "CLAUDE.md": "x" });
    await expect(runTrack(root, "CLAUDE.md")).rejects.toThrow(/no harness\.json found/);
  });
});

describe("runUntrack", () => {
  it("untracks and drops empty files sections", async () => {
    const root = await repoWith({ "CLAUDE.md": "x" });
    await runTrack(root, "CLAUDE.md");
    const { lines } = await runUntrack(root, "CLAUDE.md");
    expect(lines).toEqual(["untracked CLAUDE.md"]);
    const { manifest, lock } = await readHarness(root);
    expect(manifest.files).toBeUndefined();
    expect(lock.files).toBeUndefined();
    expect(await readFile(join(root, "harness.json"), "utf8")).not.toContain('"files"');
  });

  it("refuses an unknown path", async () => {
    const root = await repoWith({});
    await expect(runUntrack(root, "nope.md")).rejects.toThrow("nope.md is not tracked");
  });
});
