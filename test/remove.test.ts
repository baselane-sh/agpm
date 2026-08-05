import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgpmError } from "../src/errors.js";
import { parseManifest } from "../src/manifest.js";
import { runRemove } from "../src/remove.js";
import { makeRepo } from "./helpers.js";

function baseRepo(extra: Record<string, string> = {}): Record<string, string> {
  return { "harness.json": JSON.stringify({ version: 1, skills: {} }), ...extra };
}

describe("runRemove: validation", () => {
  it("rejects a name that fails isValidName", async () => {
    const root = await makeRepo(baseRepo());
    await expect(runRemove(root, "bad name")).rejects.toThrow(new AgpmError("remove takes a skill name"));
  });

  it("rejects a name with no manifest entry and no on-disk folder", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    await expect(runRemove(root, "missing-skill")).rejects.toThrow(new AgpmError("skills/missing-skill is not installed"));
  });
});

describe("runRemove: deletion", () => {
  it("deletes the folder from every root it exists in", async () => {
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({ version: 1, skills: { "tdd-cycle": "registry:@acme/tdd-cycle@1.0.0" } }),
        ".claude/skills/tdd-cycle/SKILL.md": "x\n",
        ".agents/skills/tdd-cycle/SKILL.md": "x\n",
      }),
    );

    const { lines } = await runRemove(root, "tdd-cycle");

    expect(lines).toEqual(["removed skills/tdd-cycle"]);
    await expect(stat(join(root, ".claude/skills/tdd-cycle"))).rejects.toThrow();
    await expect(stat(join(root, ".agents/skills/tdd-cycle"))).rejects.toThrow();
  });

  it("deletes from a single root when only one root has the folder", async () => {
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({ version: 1, skills: { solo: "local" } }),
        ".claude/skills/solo/SKILL.md": "x\n",
      }),
    );

    const { lines } = await runRemove(root, "solo");

    expect(lines).toEqual(["removed skills/solo"]);
    await expect(stat(join(root, ".claude/skills/solo"))).rejects.toThrow();
  });

  it("works for any provenance kind (local, github, registry)", async () => {
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({
          version: 1,
          skills: { "gh-skill": "github:acme/repo/gh-skill" },
        }),
        ".claude/skills/gh-skill/SKILL.md": "x\n",
      }),
    );

    const { lines } = await runRemove(root, "gh-skill");

    expect(lines).toEqual(["removed skills/gh-skill"]);
  });

  it("removes a manifest entry whose folder is already missing from disk", async () => {
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({ version: 1, skills: { ghost: "local" } }),
      }),
    );

    const { lines } = await runRemove(root, "ghost");

    expect(lines).toEqual(["removed skills/ghost"]);
  });

  it("removes an on-disk folder with no manifest entry (unapproved install)", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/rogue/SKILL.md": "x\n" }));

    const { lines } = await runRemove(root, "rogue");

    expect(lines).toEqual(["removed skills/rogue"]);
    await expect(stat(join(root, ".claude/skills/rogue"))).rejects.toThrow();
  });
});

describe("runRemove: post-remove state", () => {
  it("drops the skill from harness.json and harness.lock", async () => {
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({ version: 1, skills: { "tdd-cycle": "registry:@acme/tdd-cycle@1.0.0" } }),
        ".claude/skills/tdd-cycle/SKILL.md": "x\n",
      }),
    );

    await runRemove(root, "tdd-cycle");

    const manifestPath = join(root, "harness.json");
    const manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
    expect(Object.hasOwn(manifest.skills, "tdd-cycle")).toBe(false);
  });

  it("leaves other skills untouched", async () => {
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({
          version: 1,
          skills: { "tdd-cycle": "registry:@acme/tdd-cycle@1.0.0", other: "local" },
        }),
        ".claude/skills/tdd-cycle/SKILL.md": "x\n",
        ".claude/skills/other/SKILL.md": "y\n",
      }),
    );

    await runRemove(root, "tdd-cycle");

    const manifestPath = join(root, "harness.json");
    const manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
    expect(manifest.skills["other"]).toBe("local");
    expect(await readFile(join(root, ".claude/skills/other/SKILL.md"), "utf8")).toBe("y\n");
  });
});
