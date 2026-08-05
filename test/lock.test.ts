import { describe, expect, it } from "vitest";
import { emptyLock, parseLock, serializeLock } from "../src/lock.js";

const HEX = "a".repeat(64);
const entry = {
  source: "github:obra/superpowers/skills/brainstorming",
  dirs: [".claude/skills", ".agents/skills"],
  files: { "SKILL.md": `sha256:${HEX}` },
};

describe("parseLock", () => {
  it("parses a valid lock", () => {
    const text = JSON.stringify({ version: 1, extendsCommit: "b".repeat(40), skills: { brainstorming: entry } });
    const lock = parseLock(text, "harness.lock");
    expect(lock.skills["brainstorming"]?.files["SKILL.md"]).toBe(`sha256:${HEX}`);
    expect(lock.agents).toEqual({});
  });

  it("names the file path on broken JSON", () => {
    expect(() => parseLock("[", "/repo/harness.lock")).toThrow(/\/repo\/harness\.lock/);
  });

  it("rejects a malformed hash", () => {
    const text = JSON.stringify({ version: 1, skills: { a: { ...entry, files: { "SKILL.md": "sha256:short" } } } });
    expect(() => parseLock(text, "harness.lock")).toThrow(/sha256/);
  });

  it("rejects a malformed extendsCommit", () => {
    const text = JSON.stringify({ version: 1, extendsCommit: "xyz" });
    expect(() => parseLock(text, "harness.lock")).toThrow(/extendsCommit/);
  });
});

describe("serializeLock", () => {
  it("is deterministic: sorted keys, sorted dirs, trailing newline", () => {
    const lock = emptyLock();
    lock.skills["zeta"] = { ...entry, dirs: [".claude/skills", ".agents/skills"] };
    lock.skills["alpha"] = { ...entry, dirs: [".claude/skills"] };
    const text = serializeLock(lock);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zeta"'));
    const parsed = JSON.parse(text) as { skills: Record<string, { dirs: string[] }> };
    expect(parsed.skills["zeta"]?.dirs).toEqual([".agents/skills", ".claude/skills"]);
    // round trip is byte-stable
    expect(serializeLock(parseLock(text, "x"))).toBe(text);
  });

  it("never contains a timestamp", () => {
    const text = serializeLock(emptyLock());
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
