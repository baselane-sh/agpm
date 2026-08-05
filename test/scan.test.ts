import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgpmError } from "../src/errors.js";
import { sha256 } from "../src/hash.js";
import { scanRepo } from "../src/scan.js";
import { makeRepo } from "./helpers.js";

describe("scanRepo", () => {
  it("returns no units for an empty repo", async () => {
    const root = await makeRepo({ "README.md": "hi" });
    expect((await scanRepo(root)).units).toEqual([]);
  });

  it("finds skills in both dirs and merges same-name into one unit", async () => {
    const root = await makeRepo({
      ".claude/skills/brainstorming/SKILL.md": "b",
      ".agents/skills/brainstorming/SKILL.md": "b",
      ".agents/skills/solo/SKILL.md": "s",
    });
    const { units } = await scanRepo(root);
    expect(units.map((u) => [u.kind, u.name])).toEqual([
      ["skills", "brainstorming"],
      ["skills", "solo"],
    ]);
    const both = units[0]!;
    expect(both.locations.map((l) => l.dir).sort()).toEqual([".agents/skills", ".claude/skills"]);
    expect(both.locations[0]!.files["SKILL.md"]).toBe(sha256("b"));
  });

  it("finds agents and commands as single md files", async () => {
    const root = await makeRepo({
      ".claude/agents/planner.md": "p",
      ".claude/commands/tdd-task.md": "t",
      ".claude/agents/notes.txt": "ignored",
    });
    const { units } = await scanRepo(root);
    expect(units.map((u) => [u.kind, u.name])).toEqual([
      ["agents", "planner"],
      ["commands", "tdd-task"],
    ]);
    expect(units[0]!.locations).toEqual([
      { dir: ".claude/agents", files: { "planner.md": sha256("p") } },
    ]);
  });
});

describe("scanRepo symlink refusal", () => {
  it("rejects a symlinked skill directory with a clear error", async () => {
    const root = await makeRepo({ "elsewhere/evil/SKILL.md": "e", ".claude/skills/good/SKILL.md": "g" });
    await symlink(join(root, "elsewhere", "evil"), join(root, ".claude", "skills", "evil"));
    await expect(scanRepo(root)).rejects.toThrow(AgpmError);
    await expect(scanRepo(root)).rejects.toThrow(/symlink/);
  });

  it("rejects a symlinked agent file with a clear error", async () => {
    const root = await makeRepo({ "elsewhere/evil.md": "e", ".claude/agents/real.md": "r" });
    await symlink(join(root, "elsewhere", "evil.md"), join(root, ".claude", "agents", "evil.md"));
    await expect(scanRepo(root)).rejects.toThrow(/symlink/);
  });
});
