import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { makeRepo } from "./helpers.js";

async function run(argv: string[], cwd: string) {
  const lines: string[] = [];
  const code = await runCli(argv, cwd, (line) => lines.push(line));
  return { code, lines };
}

const cleanRepo = () =>
  makeRepo({
    ".claude/skills/a/SKILL.md": "x",
    "harness.json": JSON.stringify({ version: 1, skills: { a: "local" } }),
    // sha256("x") = 2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881
    "harness.lock": JSON.stringify({
      version: 1,
      skills: {
        a: {
          source: "local",
          dirs: [".claude/skills"],
          files: { "SKILL.md": "sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" },
        },
      },
    }),
  });

describe("runCli", () => {
  it("check on a clean repo prints the summary and exits 0", async () => {
    const { code, lines } = await run(["check"], await cleanRepo());
    expect(code).toBe(0);
    expect(lines).toEqual(["check: 0 fail, 0 warn"]);
  });

  it("check exits 1 and prints FAIL lines on drift", async () => {
    const root = await makeRepo({
      ".claude/skills/a/SKILL.md": "TAMPERED",
      "harness.json": JSON.stringify({ version: 1, skills: { a: "local" } }),
      "harness.lock": JSON.stringify({
        version: 1,
        skills: {
          a: {
            source: "local",
            dirs: [".claude/skills"],
            files: { "SKILL.md": "sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" },
          },
        },
      }),
    });
    const { code, lines } = await run(["check"], root);
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^FAIL skills\/a: /);
    expect(lines.at(-1)).toBe("check: 1 fail, 0 warn");
  });

  it("check without harness.json exits 2 with a clear message", async () => {
    const root = await makeRepo({ "README.md": "hi" });
    const { code, lines } = await run(["check"], root);
    expect(code).toBe(2);
    expect(lines[0]).toContain("no harness.json found in");
  });

  it("check with broken harness.json exits 2 and names the file", async () => {
    const root = await makeRepo({ "harness.json": "{nope" });
    const { code, lines } = await run(["check"], root);
    expect(code).toBe(2);
    expect(lines[0]).toContain("harness.json");
  });

  it("check with a missing lock reports unsynced entries, exit 1", async () => {
    const root = await makeRepo({
      ".claude/skills/a/SKILL.md": "x",
      "harness.json": JSON.stringify({ version: 1, skills: { a: "local" } }),
    });
    const { code, lines } = await run(["check"], root);
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^FAIL skills\/a: .*sync/);
  });

  it("list prints one line per entry and exits 0", async () => {
    const { code, lines } = await run(["list"], await cleanRepo());
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^skills\s+a\s+ok\s+local$/);
  });

  it("unknown command prints usage and exits 2", async () => {
    const { code, lines } = await run(["frobnicate"], await makeRepo({}));
    expect(code).toBe(2);
    expect(lines[0]).toBe("usage: agpm <init|sync|check|audit|list>; check accepts --strict and --json");
  });
});

describe("runCli init and sync", () => {
  it("init writes both files, reports entries, and check passes immediately", async () => {
    const root = await makeRepo({
      ".claude/skills/a/SKILL.md": "x",
      ".claude/agents/planner.md": "p",
      "skills-lock.json": JSON.stringify({ skills: { "o/r/a": { source: "github:o/r/skills/a" } } }),
    });
    const { code, lines } = await run(["init"], root);
    expect(code).toBe(0);
    expect(lines).toEqual([
      "added skills/a (github:o/r/skills/a)",
      "added agents/planner (local)",
      "init: 2 entries recorded",
    ]);
    const manifest = JSON.parse(await readFile(join(root, "harness.json"), "utf8"));
    expect(manifest.skills["a"]).toBe("github:o/r/skills/a");
    const check = await run(["check"], root);
    expect(check.code).toBe(0);
  });

  it("init refuses to overwrite an existing harness.json", async () => {
    const root = await makeRepo({ "harness.json": JSON.stringify({ version: 1 }) });
    const { code, lines } = await run(["init"], root);
    expect(code).toBe(2);
    expect(lines[0]).toContain("already exists");
  });

  it("sync without harness.json points at init", async () => {
    const root = await makeRepo({ "README.md": "hi" });
    const { code, lines } = await run(["sync"], root);
    expect(code).toBe(2);
    expect(lines[0]).toContain("run agpm init");
  });

  it("sync refreshes a tampered entry and check goes green again", async () => {
    const root = await makeRepo({ ".claude/skills/a/SKILL.md": "x" });
    await run(["init"], root);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, ".claude", "skills", "a", "SKILL.md"), "TAMPERED", "utf8");
    expect((await run(["check"], root)).code).toBe(1);
    const sync = await run(["sync"], root);
    expect(sync.code).toBe(0);
    expect(sync.lines).toEqual(["updated skills/a (1 file changed)", "sync: 0 added, 1 updated, 0 removed"]);
    expect((await run(["check"], root)).code).toBe(0);
  });

  it("sync with nothing to do says so and stays green", async () => {
    const root = await makeRepo({ ".claude/skills/a/SKILL.md": "x" });
    await run(["init"], root);
    const { code, lines } = await run(["sync"], root);
    expect(code).toBe(0);
    expect(lines).toEqual(["sync: 0 added, 0 updated, 0 removed"]);
  });

  it("sync surfaces provenance notes", async () => {
    const root = await makeRepo({ ".claude/skills/a/SKILL.md": "x" });
    await run(["init"], root);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "skills-lock.json"), "{nope", "utf8");
    const { lines } = await run(["sync"], root);
    expect(lines[0]).toContain("note:");
  });

  it("sync notes a split skill it cannot reconcile and still exits 0", async () => {
    const root = await makeRepo({ ".claude/skills/a/SKILL.md": "x" });
    await run(["init"], root);
    const { writeFile } = await import("node:fs/promises");
    await mkdir(join(root, ".agents", "skills", "a"), { recursive: true });
    await writeFile(join(root, ".agents", "skills", "a", "SKILL.md"), "y", "utf8");
    const { code, lines } = await run(["sync"], root);
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith("note:") && l.includes("skills/a"))).toBe(true);
  });
});

describe("runCli hardening", () => {
  it("fails when the lock approves a prototype-named skill the manifest does not list", async () => {
    const root = await makeRepo({
      ".claude/skills/toString/SKILL.md": "x",
      "harness.json": JSON.stringify({ version: 1, skills: {} }),
      "harness.lock": JSON.stringify({
        version: 1,
        skills: {
          toString: {
            source: "local",
            dirs: [".claude/skills"],
            files: { "SKILL.md": "sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" },
          },
        },
      }),
    });
    const { code, lines } = await run(["check"], root);
    expect(code).toBe(1);
    expect(lines[0]).toContain("FAIL skills/toString");
  });

  it("reports internal error and exits 2 when harness.json is unreadable for a non-ENOENT reason", async () => {
    const root = await makeRepo({ "README.md": "hi" });
    await mkdir(join(root, "harness.json"));
    const { code, lines } = await run(["check"], root);
    expect(code).toBe(2);
    expect(lines).toEqual([expect.stringContaining("internal error")]);
  });
});

describe("runCli check flags", () => {
  it("check --json prints one JSON document with findings, summary, exitCode", async () => {
    const root = await makeRepo({
      ".claude/skills/a/SKILL.md": "TAMPERED",
      "harness.json": JSON.stringify({ version: 1, skills: { a: "local" } }),
      "harness.lock": JSON.stringify({
        version: 1,
        skills: {
          a: {
            source: "local",
            dirs: [".claude/skills"],
            files: { "SKILL.md": "sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" },
          },
        },
      }),
    });
    const { code, lines } = await run(["check", "--json"], root);
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    const doc = JSON.parse(lines[0]!);
    expect(doc.exitCode).toBe(1);
    expect(doc.summary).toEqual({ fail: 1, warn: 0 });
    expect(doc.findings[0]).toMatchObject({ level: "fail", kind: "skills", name: "a", code: "drifted" });
  });

  it("check --strict fails an unlisted folder", async () => {
    const root = await makeRepo({
      ".claude/skills/stray/SKILL.md": "x",
      "harness.json": JSON.stringify({ version: 1 }),
      "harness.lock": JSON.stringify({ version: 1 }),
    });
    expect((await run(["check"], root)).code).toBe(0);
    const strict = await run(["check", "--strict"], root);
    expect(strict.code).toBe(1);
    expect(strict.lines[0]).toMatch(/^FAIL skills\/stray/);
  });

  it("rejects an unknown flag with the usage line and exit 2", async () => {
    const { code, lines } = await run(["check", "--verbose"], await cleanRepo());
    expect(code).toBe(2);
    expect(lines[0]).toBe("usage: agpm <init|sync|check|audit|list>; check accepts --strict and --json");
    const listFlags = await run(["list", "--json"], await cleanRepo());
    expect(listFlags.code).toBe(2);
  });
});

describe("runCli sync with extends", () => {
  const fakeFetcher = {
    resolveCommit: async () => "c".repeat(40),
    fetchManifest: async () =>
      JSON.stringify({ version: 1, skills: { blessed: "github:acme/tools/skills/blessed" }, agents: {}, commands: {} }),
  };

  it("pins the policy and stops warning about a parent-approved folder", async () => {
    const root = await makeRepo({
      ".claude/skills/blessed/SKILL.md": "x",
      "harness.json": JSON.stringify({ version: 1, extends: "github:acme/policy@main" }),
      "harness.lock": JSON.stringify({ version: 1 }),
    });
    const sync = await runCli(["sync"], root, () => {}, { extendsFetcher: fakeFetcher });
    expect(sync).toBe(0);
    const lock = JSON.parse(await readFile(join(root, "harness.lock"), "utf8"));
    expect(lock.extends).toBe("github:acme/policy@main");
    expect(lock.extendsCommit).toBe("c".repeat(40));
    expect(lock.extendsManifest.skills["blessed"]).toBe("github:acme/tools/skills/blessed");
    // the folder was also recorded locally by the scan, so remove the local record
    // to prove the parent approval alone suppresses the warning
    const manifest = JSON.parse(await readFile(join(root, "harness.json"), "utf8"));
    delete manifest.skills["blessed"];
    delete lock.skills["blessed"];
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "harness.json"), JSON.stringify(manifest), "utf8");
    await writeFile(join(root, "harness.lock"), JSON.stringify(lock), "utf8");
    const check = await run(["check"], root);
    expect(check.code).toBe(0);
    expect(check.lines).toEqual(["check: 0 fail, 0 warn"]);
  });

  it("reports the pin in the sync output", async () => {
    const root = await makeRepo({
      "harness.json": JSON.stringify({ version: 1, extends: "github:acme/policy@main" }),
      "harness.lock": JSON.stringify({ version: 1 }),
    });
    const lines: string[] = [];
    const code = await runCli(["sync"], root, (l) => lines.push(l), { extendsFetcher: fakeFetcher });
    expect(code).toBe(0);
    expect(lines[0]).toBe(`extends: github:acme/policy@main pinned at ${"c".repeat(12)}`);
  });

  it("check prints FAIL extends without a slash when harness.json and harness.lock disagree about extends", async () => {
    const root = await makeRepo({
      "harness.json": JSON.stringify({ version: 1, extends: "github:acme/policy@main", skills: {} }),
    });
    const { code, lines } = await run(["check"], root);
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^FAIL extends: /);
    expect(lines[0]).not.toContain("extends/");
  });

  it("fails loud with exit 2 when resolution fails", async () => {
    const root = await makeRepo({
      "harness.json": JSON.stringify({ version: 1, extends: "github:acme/policy@main" }),
      "harness.lock": JSON.stringify({ version: 1 }),
    });
    const failing = {
      resolveCommit: async () => {
        throw new (await import("../src/errors.js")).AgpmError("extends github:acme/policy@main: resolve the ref returned 404; if the repo is private, set GITHUB_TOKEN");
      },
      fetchManifest: async () => "{}",
    };
    const lines: string[] = [];
    const code = await runCli(["sync"], root, (l) => lines.push(l), { extendsFetcher: failing });
    expect(code).toBe(2);
    expect(lines[0]).toContain("404");
  });
});
