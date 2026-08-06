// CLI wiring tests for the six registry commands added to runCli: install, remove,
// update, login, logout, publish. These exercise argument routing, usage/exit-code
// rules, and that CliDeps (registryFetch, homeDir, promptSecret) actually reach the
// underlying command modules -- not the full registry protocol (see
// test/install.test.ts, test/update.test.ts, test/login.test.ts, test/publish.test.ts
// for that, and test/e2e-registry.test.ts for a real stub HTTP server end to end).

import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { createTarball } from "../src/tar.js";
import { makeRepo } from "./helpers.js";

const REGISTRY_URL = "https://registry.test";
const USAGE =
  "usage: agpm <init|sync|check|audit|list|install|remove|update|track|untrack|login|logout|publish>; check accepts --strict and --json; publish accepts --pack and --description";

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

interface StubSkill {
  org: string;
  name: string;
  version: string;
  files: Record<string, string>;
}

interface PublishedCall {
  org: string;
  name: string;
  version: string;
  manifest: unknown;
  tarball: Buffer | undefined;
  authorization: string | undefined;
}

class RegistryStub {
  packages: Record<string, { name: string; kind: "skill" | "pack"; latest: string; versions: string[] }> = {};
  manifests: Record<string, unknown> = {};
  tarballs: Record<string, Buffer> = {};
  users: Record<string, { user: string; orgs: { org: string; role: string }[] }> = {};
  published: PublishedCall[] = [];
  authHeadersSeen: (string | undefined)[] = [];

  addSkill(fixture: StubSkill): void {
    const tarballBufs: Record<string, Uint8Array> = {};
    for (const [path, content] of Object.entries(fixture.files)) tarballBufs[path] = Buffer.from(content, "utf8");
    const tarball = createTarball(tarballBufs);
    const tarballUrl = `${REGISTRY_URL}/v1/tarballs/${fixture.org}-${fixture.name}-${fixture.version}.tgz`;
    const files = Object.entries(fixture.files)
      .map(([path, content]) => ({ path, sha256: sha256Hex(content), size: Buffer.byteLength(content, "utf8") }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    this.manifests[`${fixture.org}/${fixture.name}@${fixture.version}`] = {
      name: `@${fixture.org}/${fixture.name}`,
      kind: "skill",
      version: fixture.version,
      description: "test skill",
      files,
      tarball: { url: tarballUrl, sha256: sha256Hex(tarball), size: tarball.length },
    };
    this.tarballs[tarballUrl] = tarball;
    const key = `${fixture.org}/${fixture.name}`;
    const prior = this.packages[key];
    const versions = prior === undefined ? [fixture.version] : [...prior.versions, fixture.version];
    this.packages[key] = { name: `@${fixture.org}/${fixture.name}`, kind: "skill", latest: fixture.version, versions };
  }

  addUser(token: string, user: string, orgs: { org: string; role: string }[]): void {
    this.users[token] = { user, orgs };
  }

  fetchImpl(): typeof fetch {
    const self = this;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers["Authorization"];
      self.authHeadersSeen.push(auth);
      const method = init?.method ?? "GET";
      const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;

      if (method === "GET" && url.pathname === "/v1/whoami") {
        const who = token !== undefined ? self.users[token] : undefined;
        if (who === undefined) {
          return jsonResponse(401, { error: { code: "unauthorized", message: "missing or invalid token" } });
        }
        return jsonResponse(200, who);
      }

      if (method === "GET" && url.pathname.startsWith("/v1/tarballs/")) {
        const bytes = self.tarballs[url.toString()];
        if (bytes === undefined) return jsonResponse(404, { error: { code: "not_found", message: "no such tarball" } });
        return new Response(new Uint8Array(bytes), { status: 200 });
      }

      const packageMatch = /^\/v1\/packages\/@([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
      if (packageMatch !== null) {
        const [, org, name, version] = packageMatch;
        if (method === "PUT") {
          const form = init!.body as FormData;
          const manifest = JSON.parse(form.get("manifest") as string);
          const tarballField = form.get("tarball") as Blob | null;
          const tarball = tarballField === null ? undefined : Buffer.from(await tarballField.arrayBuffer());
          self.published.push({ org: org!, name: name!, version: version!, manifest, tarball, authorization: auth });
          return jsonResponse(201, { ...(manifest as object), publishedAt: "2026-08-06T00:00:00Z" });
        }
        if (method === "GET" && version === undefined) {
          const info = self.packages[`${org}/${name}`];
          if (info === undefined) return jsonResponse(404, { error: { code: "not_found", message: "no such package" } });
          return jsonResponse(200, info);
        }
        if (method === "GET" && version !== undefined) {
          const manifest = self.manifests[`${org}/${name}@${version}`];
          if (manifest === undefined) return jsonResponse(404, { error: { code: "not_found", message: "no such version" } });
          return jsonResponse(200, manifest);
        }
      }

      return jsonResponse(404, { error: { code: "not_found", message: `no route for ${method} ${url.pathname}` } });
    }) as typeof fetch;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function run(argv: string[], cwd: string, deps: Parameters<typeof runCli>[3] = {}) {
  const lines: string[] = [];
  const code = await runCli(argv, cwd, (line) => lines.push(line), deps);
  return { code, lines };
}

let originalRegistry: string | undefined;
let originalToken: string | undefined;

beforeEach(() => {
  originalRegistry = process.env["AGPM_REGISTRY"];
  originalToken = process.env["AGPM_TOKEN"];
  process.env["AGPM_REGISTRY"] = REGISTRY_URL;
  delete process.env["AGPM_TOKEN"];
});

afterEach(() => {
  if (originalRegistry === undefined) delete process.env["AGPM_REGISTRY"];
  else process.env["AGPM_REGISTRY"] = originalRegistry;
  if (originalToken === undefined) delete process.env["AGPM_TOKEN"];
  else process.env["AGPM_TOKEN"] = originalToken;
});

async function makeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agpm-cli-home-"));
}

function baseRepo(extra: Record<string, string> = {}): Record<string, string> {
  return { "harness.json": JSON.stringify({ version: 1, skills: {} }), ...extra };
}

describe("runCli install", () => {
  it("wires a bare ref through to install and prints the reminder line", async () => {
    const stub = new RegistryStub();
    stub.addSkill({ org: "acme", name: "tdd-cycle", version: "1.2.0", files: { "SKILL.md": "# TDD\n" } });
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));
    const home = await makeHome();

    const { code, lines } = await run(["install", "@acme/tdd-cycle@1.2.0"], root, {
      registryFetch: stub.fetchImpl(),
      homeDir: home,
    });

    expect(code).toBe(0);
    expect(lines).toEqual([
      "installed skills/tdd-cycle (registry:@acme/tdd-cycle@1.2.0)",
      "install is not approval; commit the harness diff and approve it by PR",
    ]);
    expect(await readFile(join(root, ".claude/skills/tdd-cycle/SKILL.md"), "utf8")).toBe("# TDD\n");
  });

  it("exits 2 with usage on no args", async () => {
    const { code, lines } = await run(["install"], await makeRepo(baseRepo()), { homeDir: await makeHome() });
    expect(code).toBe(2);
    expect(lines).toEqual([USAGE]);
  });

  it("exits 2 with usage on too many args", async () => {
    const { code, lines } = await run(["install", "@acme/a", "extra"], await makeRepo(baseRepo()), {
      homeDir: await makeHome(),
    });
    expect(code).toBe(2);
    expect(lines).toEqual([USAGE]);
  });
});

describe("runCli remove", () => {
  it("wires a name through to remove and never touches the registry", async () => {
    const throwingFetch = (() => {
      throw new Error("remove must not touch the network");
    }) as unknown as typeof fetch;
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({ version: 1, skills: { a: "local" } }),
        ".claude/skills/a/SKILL.md": "x",
      }),
    );

    const { code, lines } = await run(["remove", "a"], root, { registryFetch: throwingFetch });

    expect(code).toBe(0);
    expect(lines).toEqual(["removed skills/a"]);
  });

  it("exits 2 with usage on no args", async () => {
    const { code, lines } = await run(["remove"], await makeRepo(baseRepo()));
    expect(code).toBe(2);
    expect(lines).toEqual([USAGE]);
  });

  it("exits 2 with usage on too many args", async () => {
    const { code, lines } = await run(["remove", "a", "b"], await makeRepo(baseRepo()));
    expect(code).toBe(2);
    expect(lines).toEqual([USAGE]);
  });
});

describe("runCli update", () => {
  it("wires an optional name through to update", async () => {
    const stub = new RegistryStub();
    stub.addSkill({ org: "acme", name: "tdd-cycle", version: "1.0.0", files: { "SKILL.md": "old\n" } });
    stub.addSkill({ org: "acme", name: "tdd-cycle", version: "1.2.0", files: { "SKILL.md": "new\n" } });
    const root = await makeRepo(
      baseRepo({
        "harness.json": JSON.stringify({ version: 1, skills: { "tdd-cycle": "registry:@acme/tdd-cycle@1.0.0" } }),
        ".claude/skills/tdd-cycle/SKILL.md": "old\n",
      }),
    );

    const { code, lines } = await run(["update", "tdd-cycle"], root, {
      registryFetch: stub.fetchImpl(),
      homeDir: await makeHome(),
    });

    expect(code).toBe(0);
    expect(lines).toEqual([
      "updated skills/tdd-cycle 1.0.0 -> 1.2.0",
      "install is not approval; commit the harness diff and approve it by PR",
    ]);
  });

  it("runs a bulk update with no name given", async () => {
    const root = await makeRepo(baseRepo({ "harness.json": JSON.stringify({ version: 1, skills: {} }) }));
    const { code, lines } = await run(["update"], root, { homeDir: await makeHome() });
    expect(code).toBe(0);
    expect(lines).toEqual([]);
  });

  it("exits 2 with usage on too many args", async () => {
    const { code, lines } = await run(["update", "a", "b"], await makeRepo(baseRepo()));
    expect(code).toBe(2);
    expect(lines).toEqual([USAGE]);
  });
});

describe("runCli login and logout", () => {
  it("wires the prompted token through login, verifies it, and stores it", async () => {
    const stub = new RegistryStub();
    stub.addUser("secret-token", "ada", [{ org: "acme", role: "owner" }]);
    const home = await makeHome();
    const prompts: string[] = [];

    const { code, lines } = await run(["login"], await makeRepo({}), {
      registryFetch: stub.fetchImpl(),
      homeDir: home,
      promptSecret: async (msg) => {
        prompts.push(msg);
        return "secret-token";
      },
    });

    expect(code).toBe(0);
    expect(prompts).toEqual([`paste a token from ${REGISTRY_URL}/settings/tokens: `]);
    expect(lines).toEqual([`logged in to ${REGISTRY_URL} as ada (orgs: acme)`]);
    for (const line of lines) expect(line).not.toContain("secret-token");
    const stored = JSON.parse(await readFile(join(home, ".agpm", "credentials"), "utf8"));
    expect(stored.registries[REGISTRY_URL].token).toBe("secret-token");
  });

  it("exits 2 with usage when login is given extra args", async () => {
    const { code, lines } = await run(["login", "extra"], await makeRepo({}), { homeDir: await makeHome() });
    expect(code).toBe(2);
    expect(lines).toEqual([USAGE]);
  });

  it("wires logout through to delete the stored token, offline", async () => {
    const throwingFetch = (() => {
      throw new Error("logout must not touch the network");
    }) as unknown as typeof fetch;
    const home = await makeHome();
    const { writeToken } = await import("../src/credentials.js");
    await writeToken(REGISTRY_URL, "tok", home);

    const { code, lines } = await run(["logout"], await makeRepo({}), { registryFetch: throwingFetch, homeDir: home });

    expect(code).toBe(0);
    expect(lines).toEqual([`logged out of ${REGISTRY_URL}`]);
  });

  it("exits 2 with usage when logout is given extra args", async () => {
    const { code, lines } = await run(["logout", "extra"], await makeRepo({}), { homeDir: await makeHome() });
    expect(code).toBe(2);
    expect(lines).toEqual([USAGE]);
  });
});

describe("runCli publish", () => {
  it("packs a skill folder and PUTs it with the stored token attached", async () => {
    const stub = new RegistryStub();
    const home = await makeHome();
    const { writeToken } = await import("../src/credentials.js");
    await writeToken(REGISTRY_URL, "pub-token", home);
    const root = await makeRepo({ "my-skill/SKILL.md": "# My Skill\nDoes a thing.\n" });

    const { code, lines } = await run(["publish", "my-skill", "@acme/my-skill@1.0.0"], root, {
      registryFetch: stub.fetchImpl(),
      homeDir: home,
    });

    expect(code).toBe(0);
    expect(lines).toEqual(["published @acme/my-skill@1.0.0"]);
    expect(stub.published).toHaveLength(1);
    expect(stub.published[0]!.authorization).toBe("Bearer pub-token");
    for (const line of lines) expect(line).not.toContain("pub-token");
  });

  it("routes --pack publish to the pack manifest path", async () => {
    const stub = new RegistryStub();
    const home = await makeHome();
    const { writeToken } = await import("../src/credentials.js");
    await writeToken(REGISTRY_URL, "pub-token", home);
    const root = await makeRepo({
      "pack.json": JSON.stringify({ description: "a pack", skills: { "@acme/a": "1.0.0" } }),
    });

    const { code, lines } = await run(["publish", "--pack", "pack.json", "@acme/mypack@1.0.0"], root, {
      registryFetch: stub.fetchImpl(),
      homeDir: home,
    });

    expect(code).toBe(0);
    expect(lines).toEqual(["published @acme/mypack@1.0.0"]);
    expect(stub.published[0]!.tarball).toBeUndefined();
  });

  it("accepts --description for a skill folder publish", async () => {
    const stub = new RegistryStub();
    const home = await makeHome();
    const { writeToken } = await import("../src/credentials.js");
    await writeToken(REGISTRY_URL, "pub-token", home);
    const root = await makeRepo({ "my-skill/SKILL.md": "no leading text\n" });

    const { code } = await run(
      ["publish", "my-skill", "@acme/my-skill@1.0.0", "--description", "custom description"],
      root,
      { registryFetch: stub.fetchImpl(), homeDir: home },
    );

    expect(code).toBe(0);
    expect((stub.published[0]!.manifest as { description: string }).description).toBe("custom description");
  });

  it("exits 2 with usage on no args", async () => {
    const { code, lines } = await run(["publish"], await makeRepo({}), { homeDir: await makeHome() });
    expect(code).toBe(2);
    expect(lines).toEqual([USAGE]);
  });

  it("exits 2 with usage when folder and --pack are both missing a ref", async () => {
    const { code, lines } = await run(["publish", "my-skill"], await makeRepo({}), { homeDir: await makeHome() });
    expect(code).toBe(2);
    expect(lines).toEqual([USAGE]);
  });

  it("exits 2 with usage on an unknown flag", async () => {
    const { code, lines } = await run(["publish", "my-skill", "@acme/a@1.0.0", "--bogus", "x"], await makeRepo({}), {
      homeDir: await makeHome(),
    });
    expect(code).toBe(2);
    expect(lines).toEqual([USAGE]);
  });
});

describe("runCli registry base URL", () => {
  it("honors AGPM_REGISTRY for install requests", async () => {
    const stub = new RegistryStub();
    stub.addSkill({ org: "acme", name: "a", version: "1.0.0", files: { "SKILL.md": "x\n" } });
    process.env["AGPM_REGISTRY"] = "https://registry.test/"; // trailing slash must be stripped
    const root = await makeRepo(baseRepo({ ".claude/skills/.gitkeep": "" }));

    const { code } = await run(["install", "@acme/a@1.0.0"], root, {
      registryFetch: stub.fetchImpl(),
      homeDir: await makeHome(),
    });

    expect(code).toBe(0);
  });
});

describe("runCli offline commands stay offline", () => {
  const throwingFetch = (() => {
    throw new Error("offline command touched the network");
  }) as unknown as typeof fetch;

  it("init, sync, check, audit, list never call registryFetch", async () => {
    const root = await makeRepo({ ".claude/skills/a/SKILL.md": "x" });
    const deps = { registryFetch: throwingFetch };
    expect((await run(["init"], root, deps)).code).toBe(0);
    expect((await run(["sync"], root, deps)).code).toBe(0);
    expect((await run(["check"], root, deps)).code).toBe(0);
    expect((await run(["audit"], root, deps)).code).toBe(0);
    expect((await run(["list"], root, deps)).code).toBe(0);
  });
});

describe("runCli unknown or malformed registry commands", () => {
  it("still falls through to usage for a totally unknown command", async () => {
    const { code, lines } = await run(["nope"], await makeRepo({}));
    expect(code).toBe(2);
    expect(lines).toEqual([USAGE]);
  });
});
