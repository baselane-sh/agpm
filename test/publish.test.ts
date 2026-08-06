import { createHash } from "node:crypto";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgpmError } from "../src/errors.js";
import { runPublish } from "../src/publishCmd.js";
import type { RegistryClient } from "../src/registry.js";
import { createTarball } from "../src/tar.js";
import { makeRepo } from "./helpers.js";

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

interface PublishCall {
  org: string;
  name: string;
  version: string;
  manifest: unknown;
  tarball?: Buffer;
}

function fakeClient(): { client: RegistryClient; calls: PublishCall[] } {
  const calls: PublishCall[] = [];
  const client: RegistryClient = {
    async getPackageInfo() {
      throw new Error("not implemented in fixture");
    },
    async getVersionManifest() {
      throw new Error("not implemented in fixture");
    },
    async getTarball() {
      throw new Error("not implemented in fixture");
    },
    async whoami() {
      throw new Error("not implemented in fixture");
    },
    async publish(org, name, version, manifest, tarball) {
      calls.push({ org, name, version, manifest, tarball });
    },
  };
  return { client, calls };
}

describe("runPublish: ref validation", () => {
  it("rejects a ref with no version", async () => {
    const root = await makeRepo({ "skill/SKILL.md": "# Title\ndescribes the skill\n" });
    const { client } = fakeClient();
    await expect(
      runPublish(root, { folder: join(root, "skill"), ref: "@acme/tdd-cycle" }, client),
    ).rejects.toThrow(new AgpmError("publish takes @org/name@version"));
  });

  it("rejects a value that is not a registry ref at all", async () => {
    const root = await makeRepo({ "skill/SKILL.md": "# Title\ndescribes the skill\n" });
    const { client } = fakeClient();
    await expect(runPublish(root, { folder: join(root, "skill"), ref: "not-a-ref" }, client)).rejects.toThrow(
      new AgpmError("publish takes @org/name@version"),
    );
  });
});

describe("runPublish: argument shape", () => {
  it("rejects when neither folder nor pack file is given", async () => {
    const root = await makeRepo({});
    const { client } = fakeClient();
    await expect(runPublish(root, { ref: "@acme/tdd-cycle@1.0.0" }, client)).rejects.toThrow(
      new AgpmError("publish takes a folder or --pack"),
    );
  });

  it("rejects when both folder and pack file are given", async () => {
    const root = await makeRepo({ "skill/SKILL.md": "# Title\ndescribes the skill\n", "pack.json": "{}" });
    const { client } = fakeClient();
    await expect(
      runPublish(
        root,
        { folder: join(root, "skill"), packFile: join(root, "pack.json"), ref: "@acme/tdd-cycle@1.0.0" },
        client,
      ),
    ).rejects.toThrow(new AgpmError("publish takes a folder or --pack, not both"));
  });
});

describe("runPublish: skill folder reading", () => {
  it("refuses a symlink anywhere in the folder", async () => {
    const root = await makeRepo({ "skill/SKILL.md": "# Title\ndescribes the skill\n" });
    const target = join(root, "skill", "SKILL.md");
    const linkPath = join(root, "skill", "link.md");
    await symlink(target, linkPath);

    await expect(
      runPublish(root, { folder: join(root, "skill"), ref: "@acme/tdd-cycle@1.0.0" }, fakeClient().client),
    ).rejects.toThrow(new AgpmError(`refusing symlink in ${linkPath}`));
  });

  it("refuses a symlink nested in a subdirectory", async () => {
    const root = await makeRepo({
      "skill/SKILL.md": "# Title\ndescribes the skill\n",
      "skill/sub/real.md": "content\n",
    });
    const target = join(root, "skill", "sub", "real.md");
    const linkPath = join(root, "skill", "sub", "link.md");
    await symlink(target, linkPath);

    await expect(
      runPublish(root, { folder: join(root, "skill"), ref: "@acme/tdd-cycle@1.0.0" }, fakeClient().client),
    ).rejects.toThrow(new AgpmError(`refusing symlink in ${linkPath}`));
  });

  it("requires SKILL.md at the folder root", async () => {
    const root = await makeRepo({ "skill/notes.md": "not a skill\n" });
    await expect(
      runPublish(root, { folder: join(root, "skill"), ref: "@acme/tdd-cycle@1.0.0" }, fakeClient().client),
    ).rejects.toThrow(AgpmError);
  });
});

describe("runPublish: description", () => {
  it("uses args.description when given", async () => {
    const root = await makeRepo({ "skill/SKILL.md": "# Title\nfallback text\n" });
    const { client, calls } = fakeClient();
    await runPublish(
      root,
      { folder: join(root, "skill"), ref: "@acme/tdd-cycle@1.0.0", description: "explicit description" },
      client,
    );
    expect((calls[0]!.manifest as { description: string }).description).toBe("explicit description");
  });

  it("falls back to the first non-heading, non-empty line of SKILL.md", async () => {
    const root = await makeRepo({ "skill/SKILL.md": "# Title\n\n  \nActual description here\nMore text\n" });
    const { client, calls } = fakeClient();
    await runPublish(root, { folder: join(root, "skill"), ref: "@acme/tdd-cycle@1.0.0" }, client);
    expect((calls[0]!.manifest as { description: string }).description).toBe("Actual description here");
  });

  it("throws when no description is found and none is passed", async () => {
    const root = await makeRepo({ "skill/SKILL.md": "# Title\n# Another heading\n\n" });
    await expect(
      runPublish(root, { folder: join(root, "skill"), ref: "@acme/tdd-cycle@1.0.0" }, fakeClient().client),
    ).rejects.toThrow(new AgpmError("no description found; pass --description"));
  });

  it("truncates a description over 200 chars to 197 chars plus an ellipsis", async () => {
    const root = await makeRepo({ "skill/SKILL.md": "# Title\ndescribes the skill\n" });
    const long = "x".repeat(250);
    const { client, calls } = fakeClient();
    await runPublish(root, { folder: join(root, "skill"), ref: "@acme/tdd-cycle@1.0.0", description: long }, client);
    const description = (calls[0]!.manifest as { description: string }).description;
    expect(description).toBe("x".repeat(197) + "...");
    expect(description.length).toBe(200);
  });
});

describe("runPublish: skill manifest and tarball", () => {
  it("builds a sorted files list, a deterministic tarball, and calls client.publish with the tarball bytes", async () => {
    const root = await makeRepo({
      "skill/SKILL.md": "# Title\ndescribes the skill\n",
      "skill/reference.md": "reference content\n",
    });
    const { client, calls } = fakeClient();

    const { lines } = await runPublish(
      root,
      { folder: join(root, "skill"), ref: "@acme/tdd-cycle@1.2.0" },
      client,
    );

    expect(lines).toEqual(["published @acme/tdd-cycle@1.2.0"]);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.org).toBe("acme");
    expect(call.name).toBe("tdd-cycle");
    expect(call.version).toBe("1.2.0");

    const manifest = call.manifest as {
      name: string;
      kind: string;
      version: string;
      description: string;
      files: { path: string; sha256: string; size: number }[];
      tarball: { sha256: string; size: number };
    };
    expect(manifest.name).toBe("@acme/tdd-cycle");
    expect(manifest.kind).toBe("skill");
    expect(manifest.version).toBe("1.2.0");
    expect(manifest).not.toHaveProperty("publishedAt");
    expect((manifest.tarball as Record<string, unknown>)).not.toHaveProperty("url");
    expect(manifest.files).toEqual([
      {
        path: "SKILL.md",
        sha256: sha256Hex("# Title\ndescribes the skill\n"),
        size: Buffer.byteLength("# Title\ndescribes the skill\n", "utf8"),
      },
      {
        path: "reference.md",
        sha256: sha256Hex("reference content\n"),
        size: Buffer.byteLength("reference content\n", "utf8"),
      },
    ]);

    expect(call.tarball).toBeInstanceOf(Buffer);
    const expectedTarball = createTarball({
      "SKILL.md": Buffer.from("# Title\ndescribes the skill\n", "utf8"),
      "reference.md": Buffer.from("reference content\n", "utf8"),
    });
    expect(call.tarball).toEqual(expectedTarball);
    expect(manifest.tarball.sha256).toBe(sha256Hex(expectedTarball));
    expect(manifest.tarball.size).toBe(expectedTarball.length);
  });

  it("produces byte-identical tarballs across two publishes of the same folder contents", async () => {
    const rootA = await makeRepo({ "skill/SKILL.md": "# Title\ndescribes the skill\n" });
    const rootB = await makeRepo({ "skill/SKILL.md": "# Title\ndescribes the skill\n" });
    const a = fakeClient();
    const b = fakeClient();

    await runPublish(rootA, { folder: join(rootA, "skill"), ref: "@acme/tdd-cycle@1.0.0" }, a.client);
    await runPublish(rootB, { folder: join(rootB, "skill"), ref: "@acme/tdd-cycle@1.0.0" }, b.client);

    expect(a.calls[0]!.tarball).toEqual(b.calls[0]!.tarball);
  });
});

describe("runPublish: pack file validation", () => {
  it("rejects a pack file that is not valid JSON", async () => {
    const root = await makeRepo({ "pack.json": "not json" });
    await expect(
      runPublish(root, { packFile: join(root, "pack.json"), ref: "@acme/frontend@1.0.0" }, fakeClient().client),
    ).rejects.toThrow(AgpmError);
  });

  it("rejects a pack file with an unknown top-level field", async () => {
    const root = await makeRepo({
      "pack.json": JSON.stringify({ description: "d", skills: {}, extra: true }),
    });
    await expect(
      runPublish(root, { packFile: join(root, "pack.json"), ref: "@acme/frontend@1.0.0" }, fakeClient().client),
    ).rejects.toThrow(AgpmError);
  });

  it("rejects a skills key that is not a valid unversioned registry ref", async () => {
    const root = await makeRepo({
      "pack.json": JSON.stringify({ description: "d", skills: { "not-a-ref": "1.0.0" } }),
    });
    await expect(
      runPublish(root, { packFile: join(root, "pack.json"), ref: "@acme/frontend@1.0.0" }, fakeClient().client),
    ).rejects.toThrow(AgpmError);
  });

  it("rejects a skills key that carries a version itself", async () => {
    const root = await makeRepo({
      "pack.json": JSON.stringify({ description: "d", skills: { "@acme/tdd-cycle@1.0.0": "1.0.0" } }),
    });
    await expect(
      runPublish(root, { packFile: join(root, "pack.json"), ref: "@acme/frontend@1.0.0" }, fakeClient().client),
    ).rejects.toThrow(AgpmError);
  });

  it("rejects a skills value that is not an exact-version string", async () => {
    const root = await makeRepo({
      "pack.json": JSON.stringify({ description: "d", skills: { "@acme/tdd-cycle": "1.x" } }),
    });
    await expect(
      runPublish(root, { packFile: join(root, "pack.json"), ref: "@acme/frontend@1.0.0" }, fakeClient().client),
    ).rejects.toThrow(AgpmError);
  });
});

describe("runPublish: visibility", () => {
  it("adds visibility public to the skill manifest when requested", async () => {
    const root = await makeRepo({ "skill/SKILL.md": "# Title\ndescribes the skill\n" });
    const { client, calls } = fakeClient();

    await runPublish(
      root,
      { folder: join(root, "skill"), ref: "@acme/tdd-cycle@1.0.0", visibility: "public" },
      client,
    );

    expect(calls).toHaveLength(1);
    expect((calls[0]!.manifest as { visibility?: string }).visibility).toBe("public");
  });

  it("adds visibility public to the pack manifest when requested", async () => {
    const root = await makeRepo({
      "pack.json": JSON.stringify({
        description: "Everything a frontend repo needs",
        skills: { "@baselane/tdd-cycle": "1.2.0" },
      }),
    });
    const { client, calls } = fakeClient();

    await runPublish(
      root,
      { packFile: join(root, "pack.json"), ref: "@acme/frontend@1.0.0", visibility: "public" },
      client,
    );

    expect(calls).toHaveLength(1);
    expect((calls[0]!.manifest as { visibility?: string }).visibility).toBe("public");
  });

  it("omits the visibility field when the flag is not given", async () => {
    const root = await makeRepo({ "skill/SKILL.md": "# Title\ndescribes the skill\n" });
    const { client, calls } = fakeClient();

    await runPublish(root, { folder: join(root, "skill"), ref: "@acme/tdd-cycle@1.0.0" }, client);

    expect(calls).toHaveLength(1);
    expect(Object.hasOwn(calls[0]!.manifest as object, "visibility")).toBe(false);
  });
});

describe("runPublish: pack manifest", () => {
  it("publishes a pack manifest without a tarball", async () => {
    const root = await makeRepo({
      "pack.json": JSON.stringify({
        description: "Everything a frontend repo needs",
        skills: { "@baselane/tdd-cycle": "1.2.0", "@acme/design-review": "1.4.0" },
      }),
    });
    const { client, calls } = fakeClient();

    const { lines } = await runPublish(
      root,
      { packFile: join(root, "pack.json"), ref: "@acme/frontend-baseline@3.0.0" },
      client,
    );

    expect(lines).toEqual(["published @acme/frontend-baseline@3.0.0"]);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.org).toBe("acme");
    expect(call.name).toBe("frontend-baseline");
    expect(call.version).toBe("3.0.0");
    expect(call.tarball).toBeUndefined();
    expect(call.manifest).toEqual({
      name: "@acme/frontend-baseline",
      kind: "pack",
      version: "3.0.0",
      description: "Everything a frontend repo needs",
      skills: { "@acme/design-review": "1.4.0", "@baselane/tdd-cycle": "1.2.0" },
    });
  });
});
