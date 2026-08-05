import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { hashDir } from "../src/hash.js";
import { serializeLock, emptyLock } from "../src/lock.js";
import { makeRepo } from "./helpers.js";

describe("end to end", () => {
  it("approve by hand, check green, tamper, check red, stray folder warns", async () => {
    const root = await makeRepo({
      ".claude/skills/brainstorming/SKILL.md": "# Brainstorming\nrules\n",
      ".agents/skills/brainstorming/SKILL.md": "# Brainstorming\nrules\n",
      ".claude/agents/planner.md": "# Planner\n",
      "harness.json": JSON.stringify({
        version: 1,
        skills: { brainstorming: "github:obra/superpowers/skills/brainstorming" },
        agents: { planner: "local" },
      }),
    });
    // build the lock the way M2's sync will: hash what is on disk
    const lock = emptyLock();
    lock.skills["brainstorming"] = {
      source: "github:obra/superpowers/skills/brainstorming",
      dirs: [".agents/skills", ".claude/skills"],
      files: await hashDir(join(root, ".claude/skills/brainstorming")),
    };
    lock.agents["planner"] = {
      source: "local",
      dirs: [".claude/agents"],
      files: await hashDir(join(root, ".claude/agents")).then((all) => ({ "planner.md": all["planner.md"]! })),
    };
    await writeFile(join(root, "harness.lock"), serializeLock(lock));

    const lines: string[] = [];
    expect(await runCli(["check"], root, (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toBe("check: 0 fail, 0 warn");

    // tamper with one copy: both split (dirs disagree) and drift must surface as FAIL
    await writeFile(join(root, ".claude/skills/brainstorming/SKILL.md"), "# Brainstorming\nEVIL\n");
    const lines2: string[] = [];
    expect(await runCli(["check"], root, (l) => lines2.push(l))).toBe(1);
    expect(lines2.some((l) => l.startsWith("FAIL skills/brainstorming:"))).toBe(true);

    // a stray unapproved folder only warns
    await writeFile(join(root, ".claude/skills/brainstorming/SKILL.md"), "# Brainstorming\nrules\n");
    const strayRoot = join(root, ".claude/skills");
    await makeStray(strayRoot);
    const lines3: string[] = [];
    expect(await runCli(["check"], root, (l) => lines3.push(l))).toBe(0);
    expect(lines3.some((l) => l.startsWith("WARN skills/stray:"))).toBe(true);
  });

  it("full loop: init, drift, sync, remove, always back to green", async () => {
    const root = await makeRepo({ ".claude/skills/a/SKILL.md": "v1" });
    const out = async (argv: string[]) => {
      const lines: string[] = [];
      const code = await runCli(argv, root, (line) => lines.push(line));
      return { code, lines };
    };

    expect((await out(["init"])).code).toBe(0);
    expect((await out(["check"])).code).toBe(0);

    await mkdir(join(root, ".claude", "skills", "b"), { recursive: true });
    await writeFile(join(root, ".claude", "skills", "b", "SKILL.md"), "new", "utf8");
    const warned = await out(["check"]);
    expect(warned.code).toBe(0);
    expect(warned.lines.some((l) => l.startsWith("WARN skills/b"))).toBe(true);
    expect((await out(["sync"])).lines).toContain("added skills/b (local)");
    expect((await out(["check"])).code).toBe(0);

    await writeFile(join(root, ".claude", "skills", "a", "SKILL.md"), "v2", "utf8");
    expect((await out(["check"])).code).toBe(1);
    expect((await out(["sync"])).lines).toContain("updated skills/a (1 file changed)");
    expect((await out(["check"])).code).toBe(0);

    await rm(join(root, ".claude", "skills", "b"), { recursive: true });
    expect((await out(["check"])).code).toBe(1);
    expect((await out(["sync"])).lines).toContain("removed skills/b");
    expect((await out(["check"])).code).toBe(0);
  });
});

async function makeStray(skillsDir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(skillsDir, "stray"), { recursive: true });
  await writeFile(join(skillsDir, "stray", "SKILL.md"), "unapproved\n");
}
