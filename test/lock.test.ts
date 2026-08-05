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
    const text = JSON.stringify({
      version: 1,
      extends: "github:acme/policy@main",
      extendsCommit: "b".repeat(40),
      skills: { brainstorming: entry },
    });
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

describe("parseLock path-key validation", () => {
  const H = "sha256:" + "0".repeat(64);
  const withDirs = (dirs: string[]) =>
    JSON.stringify({ version: 1, skills: { a: { source: "local", dirs, files: { "SKILL.md": H } } } });
  const withFileKey = (rel: string) =>
    JSON.stringify({ version: 1, skills: { a: { source: "local", dirs: [".claude/skills"], files: { [rel]: H } } } });

  it("rejects dirs that escape the repo or use backslashes", () => {
    expect(() => parseLock(withDirs(["../outside"]), "L")).toThrow(/dirs/);
    expect(() => parseLock(withDirs(["/absolute"]), "L")).toThrow(/dirs/);
    expect(() => parseLock(withDirs(["a\\b"]), "L")).toThrow(/dirs/);
    expect(() => parseLock(withDirs(["./x"]), "L")).toThrow(/dirs/);
    expect(() => parseLock(withDirs([""]), "L")).toThrow(/dirs/);
  });

  it("rejects file keys that escape the unit directory", () => {
    expect(() => parseLock(withFileKey("../x.md"), "L")).toThrow(/files/);
    expect(() => parseLock(withFileKey("/abs.md"), "L")).toThrow(/files/);
    expect(() => parseLock(withFileKey("a\\b.md"), "L")).toThrow(/files/);
    expect(() => parseLock(withFileKey("a//b.md"), "L")).toThrow(/files/);
  });

  it("still accepts clean nested relative paths", () => {
    expect(() => parseLock(withFileKey("references/deep/file.md"), "L")).not.toThrow();
  });
});

describe("extendsManifest", () => {
  const pin = {
    version: 1,
    extends: "github:acme/policy@main",
    extendsCommit: "a".repeat(40),
    extendsManifest: { skills: { brainstorming: "github:obra/superpowers/skills/brainstorming" }, agents: {}, commands: {} },
    skills: {},
    agents: {},
    commands: {},
  };

  it("round-trips extendsManifest byte-identically", () => {
    const text = serializeLock(parseLock(JSON.stringify(pin), "harness.lock"));
    expect(serializeLock(parseLock(text, "harness.lock"))).toBe(text);
    const lock = parseLock(text, "harness.lock");
    expect(lock.extendsManifest?.skills["brainstorming"]).toBe("github:obra/superpowers/skills/brainstorming");
  });

  it("rejects extendsManifest without extendsCommit", () => {
    const bad = { ...pin, extends: undefined, extendsCommit: undefined };
    expect(() => parseLock(JSON.stringify(bad), "harness.lock")).toThrow(/extendsManifest requires extendsCommit/);
  });

  it("rejects a bad name and a bad provenance value inside extendsManifest", () => {
    const badName = { ...pin, extendsManifest: { skills: { "/evil": "local" }, agents: {}, commands: {} } };
    expect(() => parseLock(JSON.stringify(badName), "harness.lock")).toThrow(/name/);
    const badValue = { ...pin, extendsManifest: { skills: { ok: "not-a-source" }, agents: {}, commands: {} } };
    expect(() => parseLock(JSON.stringify(badValue), "harness.lock")).toThrow(/provenance/);
  });

  it("rejects unknown keys inside extendsManifest", () => {
    const bad = { ...pin, extendsManifest: { skills: {}, agents: {}, commands: {}, hooks: {} } };
    expect(() => parseLock(JSON.stringify(bad), "harness.lock")).toThrow(/hooks/);
  });
});

describe("extends pin", () => {
  const base = {
    version: 1,
    extends: "github:acme/policy@main",
    extendsCommit: "a".repeat(40),
    skills: {},
    agents: {},
    commands: {},
  };

  it("accepts the full trio: extends, extendsCommit, extendsManifest", () => {
    const withManifest = { ...base, extendsManifest: { skills: {}, agents: {}, commands: {} } };
    const lock = parseLock(JSON.stringify(withManifest), "harness.lock");
    expect(lock.extends).toBe("github:acme/policy@main");
    expect(lock.extendsCommit).toBe("a".repeat(40));
    expect(lock.extendsManifest?.skills).toEqual({});
  });

  it("rejects extends without extendsCommit", () => {
    const bad = { ...base, extendsCommit: undefined };
    expect(() => parseLock(JSON.stringify(bad), "harness.lock")).toThrow(/extends and extendsCommit must appear together/);
  });

  it("rejects extendsCommit without extends", () => {
    const bad = { ...base, extends: undefined };
    expect(() => parseLock(JSON.stringify(bad), "harness.lock")).toThrow(/extends and extendsCommit must appear together/);
  });

  it("rejects a malformed extends value", () => {
    const bad = { ...base, extends: "not-github" };
    expect(() => parseLock(JSON.stringify(bad), "harness.lock")).toThrow(/extends must look like "github:owner\/repo@ref"/);
  });

  it("rejects a dot-segment owner or repo in extends (path traversal guard)", () => {
    const bad = { ...base, extends: "github:../..@main" };
    expect(() => parseLock(JSON.stringify(bad), "harness.lock")).toThrow(/extends must look like "github:owner\/repo@ref"/);
  });
});
