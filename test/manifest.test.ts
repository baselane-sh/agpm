import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/manifest.js";

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

  it("rejects unknown top-level keys", () => {
    const bad = JSON.stringify({ version: 1, hooks: {} });
    expect(() => parseManifest(bad, "harness.json")).toThrow(/hooks/);
  });

  it("rejects a bad entry name", () => {
    const bad = JSON.stringify({ version: 1, skills: { "../evil": "local" } });
    expect(() => parseManifest(bad, "harness.json")).toThrow(/name/);
  });
});
