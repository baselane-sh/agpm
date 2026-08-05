import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256, hashDir } from "../src/hash.js";
import { makeRepo } from "./helpers.js";

describe("sha256", () => {
  it("prefixes the lowercase hex digest with sha256:", () => {
    // known digest of "abc"
    expect(sha256("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("hashDir", () => {
  it("hashes every file recursively with sorted posix relpaths", async () => {
    const root = await makeRepo({
      "skill/SKILL.md": "hello",
      "skill/ref/notes.md": "world",
      "skill/a.txt": "a",
    });
    const result = await hashDir(join(root, "skill"));
    expect(Object.keys(result)).toEqual(["SKILL.md", "a.txt", "ref/notes.md"]);
    expect(result["SKILL.md"]).toBe(sha256("hello"));
    expect(result["ref/notes.md"]).toBe(sha256("world"));
  });

  it("throws AgpmError on a symlink", async () => {
    const root = await makeRepo({ "skill/SKILL.md": "hello" });
    await symlink("/etc/hosts", join(root, "skill", "link.md"));
    await expect(hashDir(join(root, "skill"))).rejects.toThrow(/symlink/);
  });
});

describe("hashDir prototype-name hardening", () => {
  it("includes a file named __proto__ in the hash set", async () => {
    const root = await makeRepo({ "skill/SKILL.md": "hello", "skill/__proto__": "evil" });
    const result = await hashDir(join(root, "skill"));
    expect(result["__proto__"]).toBe(sha256("evil"));
    expect(Object.keys(result)).toEqual(["SKILL.md", "__proto__"]);
  });
});
