import { describe, expect, it } from "vitest";
import { normalizeGithub, readProvenance } from "../src/provenance.js";
import { makeRepo } from "./helpers.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

describe("normalizeGithub", () => {
  it("accepts the three known shapes", () => {
    expect(normalizeGithub("github:o/r/skills/brainstorming@abc123")).toBe("github:o/r/skills/brainstorming");
    expect(normalizeGithub("github:o/r")).toBe("github:o/r");
    expect(normalizeGithub("https://github.com/o/r")).toBe("github:o/r");
    expect(normalizeGithub("https://github.com/o/r/tree/main/skills/x")).toBe("github:o/r/skills/x");
    expect(normalizeGithub("https://github.com/o/r/blob/v1.2/skills/x")).toBe("github:o/r/skills/x");
    expect(normalizeGithub("o/r/skills/x")).toBe("github:o/r/skills/x");
  });

  it("refuses everything else", () => {
    expect(normalizeGithub("1.0.0")).toBeUndefined();
    expect(normalizeGithub("just-a-name")).toBeUndefined();
    expect(normalizeGithub("https://gitlab.com/o/r")).toBeUndefined();
    expect(normalizeGithub("github:o")).toBeUndefined();
    expect(normalizeGithub("")).toBeUndefined();
  });
});

describe("readProvenance", () => {
  it("returns empty info when no lockfile exists", async () => {
    const root = await makeRepo({ "README.md": "hi" });
    const info = await readProvenance(root);
    expect(Object.keys(info.sources)).toEqual([]);
    expect(info.notes).toEqual([]);
  });

  it("extracts sources from a skills table, keyed by last path segment", async () => {
    const root = await makeRepo({
      "skills-lock.json": JSON.stringify({
        skills: {
          "o/r/brainstorming": { source: "github:o/r/skills/brainstorming@abc" },
          "plain-name": "https://github.com/o/r/tree/main/skills/plain-name",
          versioned: { source: "1.0.0" },
        },
      }),
    });
    const info = await readProvenance(root);
    expect(info.sources["brainstorming"]).toBe("github:o/r/skills/brainstorming");
    expect(info.sources["plain-name"]).toBe("github:o/r/skills/plain-name");
    expect(Object.hasOwn(info.sources, "versioned")).toBe(false);
    expect(info.notes).toEqual([]);
  });

  it("later lockfiles win and the top-level object works as the table", async () => {
    const root = await makeRepo({
      "skills-lock.json": JSON.stringify({ x: "github:aaa/r" }),
      ".claude/skills-lock.json": JSON.stringify({ x: "github:bbb/r" }),
    });
    expect((await readProvenance(root)).sources["x"]).toBe("github:bbb/r");
  });

  it("notes an unparseable lockfile and never crashes", async () => {
    const root = await makeRepo({ "skills-lock.json": "{nope" });
    const info = await readProvenance(root);
    expect(Object.keys(info.sources)).toEqual([]);
    expect(info.notes).toHaveLength(1);
    expect(info.notes[0]).toContain("skills-lock.json");
  });

  it("notes an unreadable lockfile (a directory) and never crashes", async () => {
    const root = await makeRepo({ "README.md": "hi" });
    await mkdir(join(root, "skills-lock.json"));
    const info = await readProvenance(root);
    expect(info.notes).toHaveLength(1);
    expect(info.notes[0]).toContain("skills-lock.json");
  });
});
