import { describe, expect, it } from "vitest";
import { formatAudit } from "../src/audit.js";
import { emptyLock } from "../src/lock.js";
import { emptyManifest } from "../src/manifest.js";
import { sha256 } from "../src/hash.js";
import { runCli } from "../src/cli.js";
import { makeRepo } from "./helpers.js";
import type { Lock, Manifest, ScanResult, TrackedInput } from "../src/types.js";

const scanWith = (name: string, content: string): ScanResult => ({
  units: [{ kind: "skills", name, locations: [{ dir: ".claude/skills", files: { "SKILL.md": sha256(content) } }] }],
});

describe("formatAudit", () => {
  it("shows ok, unapproved, and missing entries with counts", () => {
    const manifest = emptyManifest();
    manifest.skills["approved"] = "github:o/r/skills/approved";
    manifest.skills["ghost"] = "local";
    const lock = emptyLock();
    lock.skills["approved"] = { source: "github:o/r/skills/approved", dirs: [".claude/skills"], files: { "SKILL.md": sha256("x") } };
    lock.skills["ghost"] = { source: "local", dirs: [".claude/skills"], files: { "SKILL.md": sha256("g") } };
    const scan: ScanResult = {
      units: [
        ...scanWith("approved", "x").units,
        ...scanWith("stray", "s").units,
      ],
    };
    const lines = formatAudit(manifest, lock, scan, []);
    expect(lines.find((l) => l.includes("approved"))).toMatch(/^skills\s+approved\s+ok\s+github:o\/r\/skills\/approved\s+\.claude\/skills$/);
    expect(lines.find((l) => l.includes("ghost"))).toContain("(not on disk)");
    expect(lines.find((l) => l.includes("stray"))).toContain("(unapproved)");
    expect(lines.at(-1)).toBe("audit: 3 entries, 1 out of approval, 1 unapproved");
  });

  it("appends provenance notes before the summary", () => {
    const lines = formatAudit(emptyManifest(), emptyLock(), { units: [] }, ["could not parse skills-lock.json; ignoring it"]);
    expect(lines[0]).toBe("note: could not parse skills-lock.json; ignoring it");
    expect(lines.at(-1)).toBe("audit: 0 entries, 0 out of approval, 0 unapproved");
  });

  it("marks an extends-approved entry with (extends)", () => {
    const lock = emptyLock();
    lock.extendsCommit = "a".repeat(40);
    const sections = Object.create(null) as Record<"skills" | "agents" | "commands", Record<string, string>>;
    for (const kind of ["skills", "agents", "commands"] as const) sections[kind] = Object.create(null) as Record<string, string>;
    sections.skills["blessed"] = "github:acme/tools/skills/blessed";
    lock.extendsManifest = sections;
    const lines = formatAudit({ version: 1, skills: {}, agents: {}, commands: {} }, lock, scanWith("blessed", "x"), []);
    expect(lines[0]).toContain("github:acme/tools/skills/blessed (extends)");
    expect(lines.at(-1)).toContain("0 unapproved");
  });
});

describe("formatAudit files rows", () => {
  const H = sha256("x");

  it("counts files rows in the summary and shows the path as location", () => {
    const manifest = { ...emptyManifest(), files: { "CLAUDE.md": "local", "AGENTS.md": "local" } };
    const lock = emptyLock();
    lock.files = {
      "CLAUDE.md": { source: "local", sha256: H },
      "AGENTS.md": { source: "local", sha256: H },
    };
    const tracked: TrackedInput = {
      scan: {
        "CLAUDE.md": { status: "file", sha256: H },
        "AGENTS.md": { status: "missing" },
      },
      candidates: [{ path: ".mcp.json", message: ".mcp.json exists on disk but nobody tracks it in harness.json; run agpm track .mcp.json" }],
    };
    const lines = formatAudit(manifest, lock, { units: [] }, [], tracked);
    expect(lines).toEqual([
      `${"files".padEnd(9)} ${".mcp.json".padEnd(30)} ${"unlisted".padEnd(9)} ${"(unapproved)".padEnd(45)} .mcp.json`,
      `${"files".padEnd(9)} ${"AGENTS.md".padEnd(30)} ${"missing".padEnd(9)} ${"local".padEnd(45)} (not on disk)`,
      `${"files".padEnd(9)} ${"CLAUDE.md".padEnd(30)} ${"ok".padEnd(9)} ${"local".padEnd(45)} CLAUDE.md`,
      "audit: 3 entries, 1 out of approval, 1 unapproved",
    ]);
  });
});

describe("runCli audit", () => {
  it("exits 0 even when the repo has drift", async () => {
    const root = await makeRepo({ ".claude/skills/a/SKILL.md": "x" });
    await runCli(["init"], root, () => {});
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(root, ".claude", "skills", "a", "SKILL.md"), "TAMPERED", "utf8");
    const lines: string[] = [];
    const code = await runCli(["audit"], root, (line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines.find((l) => l.includes(" a "))).toContain("drifted");
  });
});
