import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgpmError } from "../src/errors.js";
import { parseManifest } from "../src/manifest.js";
import type { PackageInfo, RegistryClient, SkillVersionManifest, VersionManifest, WhoamiResult } from "../src/registry.js";
import { createTarball } from "../src/tar.js";
import { runUpdate } from "../src/update.js";
import { makeRepo } from "./helpers.js";

// --- Fixture registry, mirroring test/install.test.ts's FakeRegistry but scoped to what
// runUpdate needs: getPackageInfo (for `latest`) and getVersionManifest/getTarball for the
// fetch-verify-place path reused from install.ts. ---

interface FixtureSkill {
  org: string;
  name: string;
  version: string;
  content: string;
}

function skillManifest(fixture: FixtureSkill): { manifest: SkillVersionManifest; tarball: Buffer } {
  const tarball = createTarball({ "SKILL.md": Buffer.from(fixture.content, "utf8") });
  const sha256 = createHash("sha256").update(fixture.content, "utf8").digest("hex");
  const manifest: SkillVersionManifest = {
    name: `@${fixture.org}/${fixture.name}`,
    kind: "skill",
    version: fixture.version,
    description: "test skill",
    files: [{ path: "SKILL.md", sha256, size: Buffer.byteLength(fixture.content, "utf8") }],
    tarball: {
      url: `https://registry.test/tarballs/${fixture.org}-${fixture.name}-${fixture.version}.tgz`,
      sha256: createHash("sha256").update(tarball).digest("hex"),
      size: tarball.length,
    },
  };
  return { manifest, tarball };
}

class FakeRegistry {
  packages: Record<string, PackageInfo> = {};
  manifests: Record<string, VersionManifest> = {};
  tarballs: Record<string, Buffer> = {};

  addSkill(fixture: FixtureSkill): SkillVersionManifest {
    const { manifest, tarball } = skillManifest(fixture);
    this.manifests[`${fixture.org}/${fixture.name}@${fixture.version}`] = manifest;
    this.tarballs[manifest.tarball.url] = tarball;
    const key = `${fixture.org}/${fixture.name}`;
    const prior = this.packages[key];
    const versions = prior === undefined ? [fixture.version] : [...prior.versions, fixture.version];
    this.packages[key] = { name: manifest.name, kind: "skill", latest: fixture.version, versions };
    return manifest;
  }

  client(): RegistryClient {
    const self = this;
    return {
      async getPackageInfo(org, name) {
        const info = self.packages[`${org}/${name}`];
        if (info === undefined) throw new AgpmError(`registry error not_found: no such package @${org}/${name}`);
        return info;
      },
      async getVersionManifest(org, name, version) {
        const manifest = self.manifests[`${org}/${name}@${version}`];
        if (manifest === undefined) throw new AgpmError(`registry error not_found: no such version`);
        return manifest;
      },
      async getTarball(url) {
        const tarball = self.tarballs[url];
        if (tarball === undefined) throw new AgpmError(`registry error not_found: no such tarball`);
        return tarball;
      },
      async whoami(): Promise<WhoamiResult> {
        throw new Error("not implemented in fixture");
      },
      async publish(): Promise<void> {
        throw new Error("not implemented in fixture");
      },
    };
  }
}

function baseRepo(extra: Record<string, string> = {}): Record<string, string> {
  return { "harness.json": JSON.stringify({ version: 1, skills: {} }), ...extra };
}

describe("runUpdate: named entry validation", () => {
  it("rejects a name with no manifest entry", async () => {
    const root = await makeRepo(baseRepo());
    await expect(runUpdate(root, "missing", new FakeRegistry().client())).rejects.toThrow(
      new AgpmError("skills/missing is not installed"),
    );
  });

  it("rejects a name whose provenance is not registry:", async () => {
    const root = await makeRepo(
      baseRepo({ "harness.json": JSON.stringify({ version: 1, skills: { local1: "local" } }) }),
    );
    await expect(runUpdate(root, "local1", new FakeRegistry().client())).rejects.toThrow(
      new AgpmError('skills/local1 has provenance "local"; update handles only registry: entries'),
    );
  });

  it("rejects a name whose provenance is github:", async () => {
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({ version: 1, skills: { ghskill: "github:acme/repo/ghskill" } }),
      }),
    );
    await expect(runUpdate(root, "ghskill", new FakeRegistry().client())).rejects.toThrow(
      new AgpmError('skills/ghskill has provenance "github:acme/repo/ghskill"; update handles only registry: entries'),
    );
  });
});

describe("runUpdate: named entry, direct registry install", () => {
  it("updates to latest when newer is available", async () => {
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({
          version: 1,
          skills: { "tdd-cycle": "registry:@acme/tdd-cycle@1.0.0" },
        }),
        ".claude/skills/tdd-cycle/SKILL.md": "old\n",
      }),
    );
    const registry = new FakeRegistry();
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.0.0", content: "old\n" });
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.2.0", content: "new\n" });

    const { lines } = await runUpdate(root, "tdd-cycle", registry.client());

    expect(lines).toEqual([
      "updated skills/tdd-cycle 1.0.0 -> 1.2.0",
      "install is not approval; commit the harness diff and approve it by PR",
    ]);
    expect(await readFile(join(root, ".claude/skills/tdd-cycle/SKILL.md"), "utf8")).toBe("new\n");
    const manifestPath = join(root, "harness.json");
    const manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
    expect(manifest.skills["tdd-cycle"]).toBe("registry:@acme/tdd-cycle@1.2.0");
  });

  it("reports current when already at latest, with no reminder line", async () => {
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({
          version: 1,
          skills: { "tdd-cycle": "registry:@acme/tdd-cycle@1.2.0" },
        }),
        ".claude/skills/tdd-cycle/SKILL.md": "new\n",
      }),
    );
    const registry = new FakeRegistry();
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.2.0", content: "new\n" });

    const { lines } = await runUpdate(root, "tdd-cycle", registry.client());

    expect(lines).toEqual(["skills/tdd-cycle is current (1.2.0)"]);
  });

  it("writes into every existing skill root", async () => {
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({
          version: 1,
          skills: { "tdd-cycle": "registry:@acme/tdd-cycle@1.0.0" },
        }),
        ".claude/skills/tdd-cycle/SKILL.md": "old\n",
        ".agents/skills/tdd-cycle/SKILL.md": "old\n",
      }),
    );
    const registry = new FakeRegistry();
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.0.0", content: "old\n" });
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.2.0", content: "new\n" });

    await runUpdate(root, "tdd-cycle", registry.client());

    expect(await readFile(join(root, ".claude/skills/tdd-cycle/SKILL.md"), "utf8")).toBe("new\n");
    expect(await readFile(join(root, ".agents/skills/tdd-cycle/SKILL.md"), "utf8")).toBe("new\n");
  });
});

describe("runUpdate: named entry, pack member", () => {
  it("skips a bare pack member with a pointer to the pack instead of erroring", async () => {
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({
          version: 1,
          skills: {
            "design-review": "registry:@acme/frontend-baseline@3.0.0/@acme/design-review@1.4.0",
          },
        }),
        ".claude/skills/design-review/SKILL.md": "x\n",
      }),
    );

    const { lines } = await runUpdate(root, "design-review", new FakeRegistry().client());

    expect(lines).toEqual([
      "skipped skills/design-review: member of @acme/frontend-baseline@3.0.0; update the pack instead",
    ]);
  });
});

describe("runUpdate: no name, bulk update", () => {
  it("handles a mix of registry, local, and pack-member entries", async () => {
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({
          version: 1,
          skills: {
            "tdd-cycle": "registry:@acme/tdd-cycle@1.0.0",
            "already-latest": "registry:@acme/already-latest@2.0.0",
            "local-skill": "local",
            "pack-member": "registry:@acme/some-pack@1.0.0/@acme/pack-member@1.0.0",
          },
        }),
        ".claude/skills/tdd-cycle/SKILL.md": "old\n",
        ".claude/skills/already-latest/SKILL.md": "stays\n",
        ".claude/skills/local-skill/SKILL.md": "local\n",
        ".claude/skills/pack-member/SKILL.md": "member\n",
      }),
    );
    const registry = new FakeRegistry();
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.0.0", content: "old\n" });
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.2.0", content: "new\n" });
    registry.addSkill({ org: "acme", name: "already-latest", version: "2.0.0", content: "stays\n" });

    const { lines } = await runUpdate(root, undefined, registry.client());

    expect(lines).toEqual([
      "skills/already-latest is current (2.0.0)",
      "skipped skills/pack-member: member of @acme/some-pack@1.0.0; update the pack instead",
      "updated skills/tdd-cycle 1.0.0 -> 1.2.0",
      "install is not approval; commit the harness diff and approve it by PR",
    ]);
    expect(await readFile(join(root, ".claude/skills/tdd-cycle/SKILL.md"), "utf8")).toBe("new\n");
  });

  it("emits no lines and no reminder when there are no registry entries", async () => {
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({ version: 1, skills: { "local-skill": "local" } }),
        ".claude/skills/local-skill/SKILL.md": "x\n",
      }),
    );

    const { lines } = await runUpdate(root, undefined, new FakeRegistry().client());

    expect(lines).toEqual([]);
  });
});
