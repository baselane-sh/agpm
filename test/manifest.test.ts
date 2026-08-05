import { describe, expect, it } from "vitest";
import { emptyManifest, isProvenance, isValidName, parseManifest, serializeManifest } from "../src/manifest.js";

const ok = JSON.stringify({
  version: 1,
  extends: "github:acme/policy@main",
  skills: {
    brainstorming: "github:obra/superpowers/skills/brainstorming",
    "release-checklist": "local",
    mystery: "unknown",
  },
  agents: {},
  commands: {},
});

describe("parseManifest", () => {
  it("parses a valid manifest and defaults missing sections to empty", () => {
    const m = parseManifest(JSON.stringify({ version: 1, skills: { a: "local" } }), "harness.json");
    expect(m.version).toBe(1);
    expect(m.skills).toEqual({ a: "local" });
    expect(m.agents).toEqual({});
    expect(m.commands).toEqual({});
    expect(m.extends).toBeUndefined();
  });

  it("accepts github, local, and unknown provenance and an extends ref", () => {
    const m = parseManifest(ok, "harness.json");
    expect(m.extends).toBe("github:acme/policy@main");
    expect(m.skills["mystery"]).toBe("unknown");
  });

  it("names the file path on broken JSON", () => {
    expect(() => parseManifest("{nope", "/repo/harness.json")).toThrow(/\/repo\/harness\.json/);
  });

  it("rejects a wrong version", () => {
    expect(() => parseManifest(JSON.stringify({ version: 2 }), "harness.json")).toThrow(/version/);
  });

  it("rejects provenance with an @ref (provenance is a record, not a pin)", () => {
    const bad = JSON.stringify({ version: 1, skills: { a: "github:o/r/p@v1" } });
    expect(() => parseManifest(bad, "harness.json")).toThrow(/@/);
  });

  it("rejects extends without an @ref", () => {
    const bad = JSON.stringify({ version: 1, extends: "github:acme/policy" });
    expect(() => parseManifest(bad, "harness.json")).toThrow(/extends/);
  });

  it("rejects a dot-segment owner or repo in extends (path traversal guard)", () => {
    const dotdot = JSON.stringify({ version: 1, extends: "github:../..@main" });
    expect(() => parseManifest(dotdot, "harness.json")).toThrow(/extends/);
    const dot = JSON.stringify({ version: 1, extends: "github:./x@main" });
    expect(() => parseManifest(dot, "harness.json")).toThrow(/extends/);
  });

  it("rejects unknown top-level keys", () => {
    const bad = JSON.stringify({ version: 1, hooks: {} });
    expect(() => parseManifest(bad, "harness.json")).toThrow(/hooks/);
  });

  it("rejects a bad entry name", () => {
    const bad = JSON.stringify({ version: 1, skills: { "../evil": "local" } });
    expect(() => parseManifest(bad, "harness.json")).toThrow(/name/);
  });

  it("rejects provenance with a .. path segment (traversal via an untrusted lockfile)", () => {
    const bad = JSON.stringify({ version: 1, skills: { a: "github:o/r/../../x" } });
    expect(() => parseManifest(bad, "harness.json")).toThrow(/provenance/);
  });
});

describe("serializeManifest", () => {
  it("round-trips through parseManifest with sorted names and a trailing newline", () => {
    const text = serializeManifest({
      version: 1,
      extends: "github:acme/policy@main",
      skills: { zeta: "local", alpha: "github:o/r/skills/alpha" },
      agents: {},
      commands: { deploy: "local" },
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zeta"'));
    expect(text.indexOf('"version"')).toBeLessThan(text.indexOf('"extends"'));
    expect(text.indexOf('"extends"')).toBeLessThan(text.indexOf('"skills"'));
    const back = parseManifest(text, "harness.json");
    expect(back.extends).toBe("github:acme/policy@main");
    expect(back.skills["alpha"]).toBe("github:o/r/skills/alpha");
    expect(back.commands["deploy"]).toBe("local");
  });

  it("omits extends when absent and is byte-stable", () => {
    const m = { version: 1 as const, skills: { a: "local" }, agents: {}, commands: {} };
    const text = serializeManifest(m);
    expect(text).not.toContain("extends");
    expect(serializeManifest(m)).toBe(text);
  });
});

describe("emptyManifest and isValidName", () => {
  it("returns an empty manifest that serializes and parses", () => {
    const back = parseManifest(serializeManifest(emptyManifest()), "harness.json");
    expect(Object.keys(back.skills)).toEqual([]);
  });

  it("validates names by the same rule parseManifest enforces", () => {
    expect(isValidName("brainstorming")).toBe(true);
    expect(isValidName("a.b-c_d9")).toBe(true);
    expect(isValidName("__proto__")).toBe(false);
    expect(isValidName("../x")).toBe(false);
    expect(isValidName("")).toBe(false);
  });
});

describe("isProvenance", () => {
  it("still accepts the known good shapes", () => {
    expect(isProvenance("local")).toBe(true);
    expect(isProvenance("unknown")).toBe(true);
    expect(isProvenance("github:o/r")).toBe(true);
    expect(isProvenance("github:o/r/skills/x")).toBe(true);
    expect(isProvenance("github:obra/superpowers/skills/brainstorming")).toBe(true);
  });

  it("rejects a . or .. path segment anywhere after github:", () => {
    expect(isProvenance("github:o/r/../../x")).toBe(false);
    expect(isProvenance("github:o/../r")).toBe(false);
    expect(isProvenance("github:./o/r")).toBe(false);
    expect(isProvenance("github:o/r/.")).toBe(false);
  });

  it("rejects an empty path segment", () => {
    expect(isProvenance("github:o/r//x")).toBe(false);
    expect(isProvenance("github:o")).toBe(false);
  });
});
