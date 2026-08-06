import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgpmError } from "../src/errors.js";
import { runInstall } from "../src/install.js";
import { parseLock } from "../src/lock.js";
import { parseManifest } from "../src/manifest.js";
import { runCheck } from "../src/check.js";
import type {
  PackageInfo,
  PackVersionManifest,
  RegistryClient,
  SkillVersionManifest,
  VersionManifest,
  WhoamiResult,
} from "../src/registry.js";
import { scanRepo } from "../src/scan.js";
import { createTarball } from "../src/tar.js";
import { makeRepo } from "./helpers.js";

// --- Fixture registry: builds skill/pack manifests and matching tarballs, served by an
// in-memory RegistryClient stub. ---

interface FixtureSkill {
  org: string;
  name: string;
  version: string;
  files: Record<string, string>;
  tarballFiles?: Record<string, string>; // when set, diverges from `files` to test mismatches
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function buildSkillManifest(fixture: FixtureSkill): { manifest: SkillVersionManifest; tarball: Buffer } {
  const tarballFiles = fixture.tarballFiles ?? fixture.files;
  const tarballBufs: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(tarballFiles)) tarballBufs[path] = Buffer.from(content, "utf8");
  const tarball = createTarball(tarballBufs);

  const files = Object.entries(fixture.files)
    .map(([path, content]) => ({
      path,
      sha256: sha256Hex(content),
      size: Buffer.byteLength(content, "utf8"),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  const manifest: SkillVersionManifest = {
    name: `@${fixture.org}/${fixture.name}`,
    kind: "skill",
    version: fixture.version,
    description: "test skill",
    files,
    tarball: {
      url: `https://registry.test/tarballs/${fixture.org}-${fixture.name}-${fixture.version}.tgz`,
      sha256: sha256Hex(tarball),
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
    const { manifest, tarball } = buildSkillManifest(fixture);
    this.manifests[`${fixture.org}/${fixture.name}@${fixture.version}`] = manifest;
    this.tarballs[manifest.tarball.url] = tarball;
    const key = `${fixture.org}/${fixture.name}`;
    const prior = this.packages[key];
    const versions = prior === undefined ? [fixture.version] : [...prior.versions, fixture.version];
    this.packages[key] = { name: manifest.name, kind: "skill", latest: fixture.version, versions };
    return manifest;
  }

  addPack(org: string, name: string, version: string, skills: Record<string, string>): PackVersionManifest {
    const manifest: PackVersionManifest = {
      name: `@${org}/${name}`,
      kind: "pack",
      version,
      description: "test pack",
      skills,
    };
    this.manifests[`${org}/${name}@${version}`] = manifest;
    this.packages[`${org}/${name}`] = { name: manifest.name, kind: "pack", latest: version, versions: [version] };
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

describe("runInstall: ref parsing", () => {
  it("rejects a value that is not a registry ref", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    await expect(runInstall(root, "not-a-ref", new FakeRegistry().client())).rejects.toThrow(
      new AgpmError("install takes @org/name or @org/name@version"),
    );
  });
});

describe("runInstall: target roots", () => {
  it("installs into an existing .claude/skills root only", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    const registry = new FakeRegistry();
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.2.0", files: { "SKILL.md": "# TDD\n" } });

    const { lines } = await runInstall(root, "@acme/tdd-cycle@1.2.0", registry.client());

    expect(lines).toEqual([
      "installed skills/tdd-cycle (registry:@acme/tdd-cycle@1.2.0)",
      "install is not approval; commit the harness diff and approve it by PR",
    ]);
    expect(await readFile(join(root, ".claude/skills/tdd-cycle/SKILL.md"), "utf8")).toBe("# TDD\n");
    await expect(stat(join(root, ".agents/skills/tdd-cycle"))).rejects.toThrow();
  });

  it("installs into every existing skill root", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "", ".agents/skills/.gitkeep": "" }));
    const registry = new FakeRegistry();
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.0.0", files: { "SKILL.md": "content\n" } });

    await runInstall(root, "@acme/tdd-cycle@1.0.0", registry.client());

    expect(await readFile(join(root, ".claude/skills/tdd-cycle/SKILL.md"), "utf8")).toBe("content\n");
    expect(await readFile(join(root, ".agents/skills/tdd-cycle/SKILL.md"), "utf8")).toBe("content\n");
  });

  it("creates .claude/skills when neither root exists", async () => {
    const root = await makeRepo(baseRepo());
    const registry = new FakeRegistry();
    registry.addSkill({ org: "acme", name: "solo", version: "1.0.0", files: { "SKILL.md": "x\n" } });

    await runInstall(root, "@acme/solo@1.0.0", registry.client());

    expect(await readFile(join(root, ".claude/skills/solo/SKILL.md"), "utf8")).toBe("x\n");
    await expect(stat(join(root, ".agents/skills"))).rejects.toThrow();
  });
});

describe("runInstall: pack expansion", () => {
  it("expands a pack into its skill members with pack-member provenance, sorted by name", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    const registry = new FakeRegistry();
    registry.addSkill({ org: "acme", name: "design-review", version: "1.4.0", files: { "SKILL.md": "dr\n" } });
    registry.addSkill({ org: "baselane", name: "tdd-cycle", version: "1.2.0", files: { "SKILL.md": "tdd\n" } });
    registry.addPack("acme", "frontend-baseline", "3.0.0", {
      "@baselane/tdd-cycle": "1.2.0",
      "@acme/design-review": "1.4.0",
    });

    const { lines } = await runInstall(root, "@acme/frontend-baseline@3.0.0", registry.client());

    expect(lines).toEqual([
      "installed skills/design-review (registry:@acme/frontend-baseline@3.0.0/@acme/design-review@1.4.0)",
      "installed skills/tdd-cycle (registry:@acme/frontend-baseline@3.0.0/@baselane/tdd-cycle@1.2.0)",
      "install is not approval; commit the harness diff and approve it by PR",
    ]);
    const manifestJson = JSON.parse(await readFile(join(root, "harness.json"), "utf8"));
    expect(manifestJson.skills["design-review"]).toBe(
      "registry:@acme/frontend-baseline@3.0.0/@acme/design-review@1.4.0",
    );
    expect(manifestJson.skills["tdd-cycle"]).toBe(
      "registry:@acme/frontend-baseline@3.0.0/@baselane/tdd-cycle@1.2.0",
    );
  });

  it("rejects a pack member that is itself a pack", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    const registry = new FakeRegistry();
    registry.addPack("acme", "inner", "1.0.0", {});
    registry.addPack("acme", "outer", "1.0.0", { "@acme/inner": "1.0.0" });

    await expect(runInstall(root, "@acme/outer@1.0.0", registry.client())).rejects.toThrow(
      new AgpmError("registry error invalid_package: pack members must be skills"),
    );
  });

  it("rejects a pack whose members resolve to the same folder name", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    const registry = new FakeRegistry();
    registry.addSkill({ org: "a", name: "x", version: "1.0.0", files: { "SKILL.md": "a\n" } });
    registry.addSkill({ org: "b", name: "x", version: "2.0.0", files: { "SKILL.md": "b\n" } });
    registry.addPack("acme", "colliding-pack", "1.0.0", {
      "@a/x": "1.0.0",
      "@b/x": "2.0.0",
    });

    await expect(runInstall(root, "@acme/colliding-pack@1.0.0", registry.client())).rejects.toThrow(
      new AgpmError(
        "registry error invalid_package: pack members @a/x@1.0.0 and @b/x@2.0.0 both resolve to skills/x",
      ),
    );
    await expect(stat(join(root, ".claude/skills/x"))).rejects.toThrow();
  });
});

describe("runInstall: version resolution", () => {
  it("resolves latest when no version is given", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    const registry = new FakeRegistry();
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.0.0", files: { "SKILL.md": "old\n" } });
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.2.0", files: { "SKILL.md": "new\n" } });

    const { lines } = await runInstall(root, "@acme/tdd-cycle", registry.client());

    expect(lines[0]).toBe("installed skills/tdd-cycle (registry:@acme/tdd-cycle@1.2.0)");
    expect(await readFile(join(root, ".claude/skills/tdd-cycle/SKILL.md"), "utf8")).toBe("new\n");
  });
});

describe("runInstall: verification", () => {
  it("rejects a tarball whose bytes do not match the declared sha256", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    const registry = new FakeRegistry();
    const manifest = registry.addSkill({
      org: "acme",
      name: "bad-tarball",
      version: "1.0.0",
      files: { "SKILL.md": "x\n" },
    });
    registry.tarballs[manifest.tarball.url] = Buffer.from("tampered bytes");

    await expect(runInstall(root, "@acme/bad-tarball@1.0.0", registry.client())).rejects.toThrow(
      new AgpmError("tarball hash mismatch for @acme/bad-tarball@1.0.0"),
    );
  });

  it("rejects a file whose content does not match its declared sha256", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    const registry = new FakeRegistry();
    const manifest = registry.addSkill({
      org: "acme",
      name: "bad-file",
      version: "1.0.0",
      files: { "SKILL.md": "x\n" },
    });
    manifest.files[0]!.sha256 = sha256Hex("something else");

    await expect(runInstall(root, "@acme/bad-file@1.0.0", registry.client())).rejects.toThrow(
      new AgpmError("file hash mismatch for @acme/bad-file@1.0.0: SKILL.md"),
    );
  });

  it("rejects a tarball containing a file the manifest does not declare", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    const registry = new FakeRegistry();
    registry.addSkill({
      org: "acme",
      name: "extra-file",
      version: "1.0.0",
      files: { "SKILL.md": "x\n" },
      tarballFiles: { "SKILL.md": "x\n", "sneaky.md": "surprise\n" },
    });

    await expect(runInstall(root, "@acme/extra-file@1.0.0", registry.client())).rejects.toThrow(
      new AgpmError("file hash mismatch for @acme/extra-file@1.0.0: sneaky.md"),
    );
  });

  it("rejects a package whose declared files never include SKILL.md", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    const registry = new FakeRegistry();
    registry.addSkill({ org: "acme", name: "no-skill-md", version: "1.0.0", files: { "notes.md": "hi\n" } });

    await expect(runInstall(root, "@acme/no-skill-md@1.0.0", registry.client())).rejects.toThrow(
      new AgpmError("@acme/no-skill-md@1.0.0 has no SKILL.md; not a skill package"),
    );
  });
});

describe("runInstall: collisions", () => {
  it("rejects installing over a name recorded with a different provenance", async () => {
    const root = await makeRepo(
      baseRepo({
        ".claude/skills/.gitkeep": "",
        "harness.json": JSON.stringify({
          version: 1,
          skills: { "tdd-cycle": "github:acme/other-repo/tdd-cycle" },
        }),
      }),
    );
    const registry = new FakeRegistry();
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.0.0", files: { "SKILL.md": "x\n" } });

    await expect(runInstall(root, "@acme/tdd-cycle@1.0.0", registry.client())).rejects.toThrow(
      new AgpmError(
        'skills/tdd-cycle exists with provenance "github:acme/other-repo/tdd-cycle"; remove it first (agpm remove tdd-cycle)',
      ),
    );
  });

  it("rejects installing over an unapproved folder already on disk", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/tdd-cycle/SKILL.md": "existing\n" }));
    const registry = new FakeRegistry();
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.0.0", files: { "SKILL.md": "x\n" } });

    await expect(runInstall(root, "@acme/tdd-cycle@1.0.0", registry.client())).rejects.toThrow(
      new AgpmError('skills/tdd-cycle exists with provenance "unapproved"; remove it first (agpm remove tdd-cycle)'),
    );
  });

  it("allows reinstalling the same ref at the same version and rewrites bytes", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    const registry = new FakeRegistry();
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.0.0", files: { "SKILL.md": "first\n" } });
    await runInstall(root, "@acme/tdd-cycle@1.0.0", registry.client());

    // Simulate re-fetching the same published version (bytes identical in practice, but
    // the collision rule only compares provenance, not content, so this also proves the
    // rewrite happens rather than being silently skipped).
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.0.0", files: { "SKILL.md": "second\n" } });
    const { lines } = await runInstall(root, "@acme/tdd-cycle@1.0.0", registry.client());

    expect(lines[0]).toBe("installed skills/tdd-cycle (registry:@acme/tdd-cycle@1.0.0)");
    expect(await readFile(join(root, ".claude/skills/tdd-cycle/SKILL.md"), "utf8")).toBe("second\n");
  });

  it("removes a file dropped from the tarball on a same-provenance reinstall", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    const registry = new FakeRegistry();
    registry.addSkill({
      org: "acme",
      name: "tdd-cycle",
      version: "1.0.0",
      files: { "SKILL.md": "keep\n", "extra.md": "stale\n" },
    });
    await runInstall(root, "@acme/tdd-cycle@1.0.0", registry.client());
    expect(await readFile(join(root, ".claude/skills/tdd-cycle/extra.md"), "utf8")).toBe("stale\n");

    // Same version republished without extra.md (e.g. a repair reinstall over a locally
    // tampered folder). The stale file must not survive and get re-blessed under the
    // new provenance write.
    registry.addSkill({
      org: "acme",
      name: "tdd-cycle",
      version: "1.0.0",
      files: { "SKILL.md": "keep\n" },
    });
    await runInstall(root, "@acme/tdd-cycle@1.0.0", registry.client());

    await expect(stat(join(root, ".claude/skills/tdd-cycle/extra.md"))).rejects.toThrow();
    expect(await readFile(join(root, ".claude/skills/tdd-cycle/SKILL.md"), "utf8")).toBe("keep\n");
  });
});

describe("runInstall: post-install state", () => {
  it("leaves the repo check-green with registry provenance recorded in harness.json", async () => {
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    const registry = new FakeRegistry();
    registry.addSkill({ org: "acme", name: "tdd-cycle", version: "1.2.0", files: { "SKILL.md": "x\n" } });

    await runInstall(root, "@acme/tdd-cycle@1.2.0", registry.client());

    const manifestPath = join(root, "harness.json");
    const manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
    expect(manifest.skills["tdd-cycle"]).toBe("registry:@acme/tdd-cycle@1.2.0");

    const lockPath = join(root, "harness.lock");
    const lock = parseLock(await readFile(lockPath, "utf8"), lockPath);
    const result = runCheck(manifest, lock, await scanRepo(root));
    expect(result.findings.filter((f) => f.level === "fail")).toEqual([]);
  });
});
