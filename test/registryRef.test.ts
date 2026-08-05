import { describe, expect, it } from "vitest";
import { compareVersions, formatRegistryRef, isRegistryProvenance, parseRegistryRef } from "../src/registryRef.js";

describe("parseRegistryRef", () => {
  it("parses a ref without a version", () => {
    expect(parseRegistryRef("@baselane/tdd")).toEqual({ org: "baselane", name: "tdd" });
  });

  it("parses a ref with a version", () => {
    expect(parseRegistryRef("@baselane/tdd@1.2.0")).toEqual({
      org: "baselane",
      name: "tdd",
      version: "1.2.0",
    });
  });

  it("rejects an empty org", () => {
    expect(parseRegistryRef("@/tdd@1.2.0")).toBeUndefined();
  });

  it("rejects an uppercase org", () => {
    expect(parseRegistryRef("@Baselane/tdd@1.2.0")).toBeUndefined();
  });

  it("rejects an org with a leading dash", () => {
    expect(parseRegistryRef("@-baselane/tdd@1.2.0")).toBeUndefined();
  });

  it("rejects an org with a trailing dash", () => {
    expect(parseRegistryRef("@baselane-/tdd@1.2.0")).toBeUndefined();
  });

  it("rejects an org over 39 chars", () => {
    const org = "a".repeat(40);
    expect(parseRegistryRef(`@${org}/tdd@1.2.0`)).toBeUndefined();
  });

  it("accepts an org at exactly 39 chars", () => {
    const org = "a".repeat(39);
    expect(parseRegistryRef(`@${org}/tdd@1.2.0`)?.org).toBe(org);
  });

  it("rejects a value missing the leading @", () => {
    expect(parseRegistryRef("baselane/tdd@1.2.0")).toBeUndefined();
  });

  it("rejects a value missing the org/name separator", () => {
    expect(parseRegistryRef("@baselanetdd@1.2.0")).toBeUndefined();
  });

  it.each(["1.2", "v1.2.0", "1.2.0-rc1"])("rejects a bad version: %s", (version) => {
    expect(parseRegistryRef(`@baselane/tdd@${version}`)).toBeUndefined();
  });

  it("rejects a name starting with a dot", () => {
    expect(parseRegistryRef("@baselane/.tdd@1.2.0")).toBeUndefined();
  });

  it("rejects a name over 100 chars", () => {
    const name = "a".repeat(101);
    expect(parseRegistryRef(`@baselane/${name}@1.2.0`)).toBeUndefined();
  });

  it("accepts a name at exactly 100 chars", () => {
    const name = "a".repeat(100);
    expect(parseRegistryRef(`@baselane/${name}@1.2.0`)?.name).toBe(name);
  });
});

describe("formatRegistryRef", () => {
  it("formats org, name, and version", () => {
    expect(formatRegistryRef({ org: "baselane", name: "tdd", version: "1.2.0" })).toBe("@baselane/tdd@1.2.0");
  });
});

describe("compareVersions", () => {
  it("compares numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });

  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("compares minor and patch segments", () => {
    expect(compareVersions("1.2.0", "1.3.0")).toBeLessThan(0);
    expect(compareVersions("1.2.1", "1.2.0")).toBeGreaterThan(0);
  });
});

describe("isRegistryProvenance", () => {
  it("accepts a plain registry ref", () => {
    expect(isRegistryProvenance("registry:@baselane/tdd@1.2.0")).toBe(true);
  });

  it("accepts a pack-member ref", () => {
    expect(isRegistryProvenance("registry:@baselane/pack@3.0.0/@baselane/tdd@1.2.0")).toBe(true);
  });

  it("rejects registry: alone", () => {
    expect(isRegistryProvenance("registry:")).toBe(false);
  });

  it("rejects three chained refs", () => {
    expect(isRegistryProvenance("registry:@a/b@1.0.0/@a/c@1.0.0/@a/d@1.0.0")).toBe(false);
  });

  it("rejects when any part fails the ref rules", () => {
    expect(isRegistryProvenance("registry:@Baselane/tdd@1.2.0")).toBe(false);
    expect(isRegistryProvenance("registry:@baselane/tdd@1.2")).toBe(false);
    expect(isRegistryProvenance("registry:@baselane/pack@3.0.0/@baselane/tdd")).toBe(false);
  });

  it("rejects a non-registry value", () => {
    expect(isRegistryProvenance("github:o/r")).toBe(false);
  });
});
