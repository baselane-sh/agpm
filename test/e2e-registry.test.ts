// End-to-end registry test: a real node:http server on a random localhost port stands in
// for the baselane registry (the five endpoints from
// docs/superpowers/specs/2026-08-06-registry-protocol-design.md section 6), backed by
// plain Maps. AGPM_REGISTRY points the CLI at it and every command goes over a real
// loopback HTTP request through the default (un-stubbed) registryFetch, proving the
// wiring works end to end rather than against a fake RegistryClient.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { makeRepo } from "./helpers.js";

const TOKEN = "e2e-secret-token-do-not-print";

interface StoredManifest {
  [key: string]: unknown;
}

interface RegistryHandle {
  baseUrl: string;
  tokens: Map<string, { user: string; orgs: { org: string; role: string }[] }>;
  close: () => Promise<void>;
}

function sortVersions(versions: string[]): string[] {
  return [...versions].sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

async function startRegistryServer(): Promise<RegistryHandle> {
  const packages = new Map<string, { kind: string; versions: string[] }>();
  const manifests = new Map<string, StoredManifest>();
  const tarballs = new Map<string, Buffer>();
  const tokens = new Map<string, { user: string; orgs: { org: string; role: string }[] }>();
  let port = 0;

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyBuffer = Buffer.concat(chunks);
    const authHeader = req.headers["authorization"];
    const token =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;

    if (req.method === "GET" && url.pathname === "/v1/whoami") {
      const who = token !== undefined ? tokens.get(token) : undefined;
      if (who === undefined) return sendJson(res, 401, { error: { code: "unauthorized", message: "missing or invalid token" } });
      return sendJson(res, 200, who);
    }

    if (req.method === "GET" && url.pathname.startsWith("/v1/tarballs/")) {
      const bytes = tarballs.get(url.pathname);
      if (bytes === undefined) return sendJson(res, 404, { error: { code: "not_found", message: "no such tarball" } });
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(bytes);
      return;
    }

    const match = /^\/v1\/packages\/@([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (match !== null) {
      const [, org, name, version] = match;
      const key = `${org}/${name}`;

      if (req.method === "PUT") {
        if (token === undefined || !tokens.has(token)) {
          return sendJson(res, 401, { error: { code: "unauthorized", message: "missing or invalid token" } });
        }
        const contentType = req.headers["content-type"] ?? "";
        const formReq = new Request(url.toString(), {
          method: "PUT",
          headers: { "content-type": contentType },
          body: bodyBuffer,
        });
        const form = await formReq.formData();
        const manifest = JSON.parse(form.get("manifest") as string) as Record<string, unknown>;
        const tarballField = form.get("tarball") as Blob | null;

        let stored: StoredManifest;
        if (tarballField !== null) {
          const tarballBytes = Buffer.from(await tarballField.arrayBuffer());
          const tarballPath = `/v1/tarballs/${org}-${name}-${version}.tgz`;
          tarballs.set(tarballPath, tarballBytes);
          const tarballMeta = manifest["tarball"] as { sha256: string; size: number };
          stored = {
            ...manifest,
            tarball: { url: `http://127.0.0.1:${port}${tarballPath}`, sha256: tarballMeta.sha256, size: tarballMeta.size },
            publishedAt: "2026-08-06T00:00:00Z",
          };
        } else {
          stored = { ...manifest, publishedAt: "2026-08-06T00:00:00Z" };
        }

        manifests.set(`${key}@${version}`, stored);
        const existing = packages.get(key);
        const versions = existing === undefined ? [version!] : sortVersions([...existing.versions, version!]);
        packages.set(key, { kind: manifest["kind"] as string, versions });

        sendJson(res, 201, stored);
        return;
      }

      if (req.method === "GET" && version === undefined) {
        const info = packages.get(key);
        if (info === undefined) return sendJson(res, 404, { error: { code: "not_found", message: "no such package" } });
        return sendJson(res, 200, {
          name: `@${org}/${name}`,
          kind: info.kind,
          latest: info.versions[info.versions.length - 1],
          versions: info.versions,
        });
      }

      if (req.method === "GET" && version !== undefined) {
        const manifest = manifests.get(`${key}@${version}`);
        if (manifest === undefined) return sendJson(res, 404, { error: { code: "not_found", message: "no such version" } });
        return sendJson(res, 200, manifest);
      }
    }

    sendJson(res, 404, { error: { code: "not_found", message: `no route for ${req.method ?? ""} ${url.pathname}` } });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      sendJson(res, 500, { error: { code: "internal", message: String(error) } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    tokens,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

let originalRegistry: string | undefined;

beforeEach(() => {
  originalRegistry = process.env["AGPM_REGISTRY"];
});

afterEach(() => {
  if (originalRegistry === undefined) delete process.env["AGPM_REGISTRY"];
  else process.env["AGPM_REGISTRY"] = originalRegistry;
});

describe("registry end to end", () => {
  it("login, publish, install, sync, check, tamper, check, update, remove, check", async () => {
    const registry = await startRegistryServer();
    registry.tokens.set(TOKEN, { user: "e2e-tester", orgs: [{ org: "baselane", role: "owner" }] });
    process.env["AGPM_REGISTRY"] = registry.baseUrl;

    const allLines: string[] = [];
    const home = await mkdtemp(join(tmpdir(), "agpm-e2e-home-"));
    const root = await makeRepo({
      "fixtures/demo-skill/SKILL.md": "# Demo Skill\nDoes a demo thing.\n",
    });

    const run = async (argv: string[], deps: Parameters<typeof runCli>[3] = {}) => {
      const lines: string[] = [];
      const code = await runCli(argv, root, (line) => lines.push(line), { homeDir: home, ...deps });
      allLines.push(...lines);
      return { code, lines };
    };

    try {
      const initResult = await run(["init"]);
      expect(initResult.code).toBe(0);

      const loginResult = await run(["login"], { promptSecret: async () => TOKEN });
      expect(loginResult.code).toBe(0);
      expect(loginResult.lines).toEqual([`logged in to ${registry.baseUrl} as e2e-tester (orgs: baselane)`]);

      const publishResult = await run(["publish", "fixtures/demo-skill", "@baselane/demo-skill@1.0.0"]);
      expect(publishResult.code).toBe(0);
      expect(publishResult.lines).toEqual(["published @baselane/demo-skill@1.0.0"]);

      const installResult = await run(["install", "@baselane/demo-skill@1.0.0"]);
      expect(installResult.code).toBe(0);
      expect(installResult.lines).toEqual([
        "installed skills/demo-skill (registry:@baselane/demo-skill@1.0.0)",
        "install is not approval; commit the harness diff and approve it by PR",
      ]);
      expect(await readFile(join(root, ".claude/skills/demo-skill/SKILL.md"), "utf8")).toBe(
        "# Demo Skill\nDoes a demo thing.\n",
      );

      const syncResult = await run(["sync"]);
      expect(syncResult.code).toBe(0);

      const greenCheck = await run(["check"]);
      expect(greenCheck.code).toBe(0);
      expect(greenCheck.lines.at(-1)).toBe("check: 0 fail, 0 warn");

      await writeFile(join(root, ".claude/skills/demo-skill/SKILL.md"), "TAMPERED\n", "utf8");
      const driftedCheck = await run(["check", "--json"]);
      expect(driftedCheck.code).toBe(1);
      const driftedDoc = JSON.parse(driftedCheck.lines[0]!);
      expect(driftedDoc.findings[0]).toMatchObject({ level: "fail", kind: "skills", name: "demo-skill", code: "drifted" });

      await writeFile(join(root, "fixtures/demo-skill/SKILL.md"), "# Demo Skill\nDoes a demo thing, v2.\n", "utf8");
      const republishResult = await run(["publish", "fixtures/demo-skill", "@baselane/demo-skill@1.0.1"]);
      expect(republishResult.code).toBe(0);

      const updateResult = await run(["update", "demo-skill"]);
      expect(updateResult.code).toBe(0);
      expect(updateResult.lines).toEqual([
        "updated skills/demo-skill 1.0.0 -> 1.0.1",
        "install is not approval; commit the harness diff and approve it by PR",
      ]);
      expect(await readFile(join(root, ".claude/skills/demo-skill/SKILL.md"), "utf8")).toBe(
        "# Demo Skill\nDoes a demo thing, v2.\n",
      );

      const greenAfterUpdate = await run(["check"]);
      expect(greenAfterUpdate.code).toBe(0);
      expect(greenAfterUpdate.lines.at(-1)).toBe("check: 0 fail, 0 warn");

      const removeResult = await run(["remove", "demo-skill"]);
      expect(removeResult.code).toBe(0);
      expect(removeResult.lines).toEqual(["removed skills/demo-skill"]);

      const greenAfterRemove = await run(["check"]);
      expect(greenAfterRemove.code).toBe(0);
      expect(greenAfterRemove.lines.at(-1)).toBe("check: 0 fail, 0 warn");

      for (const line of allLines) {
        expect(line).not.toContain(TOKEN);
      }
    } finally {
      await registry.close();
    }
  });
});
