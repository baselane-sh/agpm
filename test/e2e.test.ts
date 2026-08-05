import { writeFile } from "node:fs/promises";
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
});

async function makeStray(skillsDir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(skillsDir, "stray"), { recursive: true });
  await writeFile(join(skillsDir, "stray", "SKILL.md"), "unapproved\n");
}
