import { describe, expect, it } from "vitest";
import { AgpmError } from "../src/errors.js";
import { makeRegistryClient } from "../src/registry.js";
import type {
  PackageInfo,
  PackVersionManifest,
  SkillVersionManifest,
  WhoamiResult,
} from "../src/registry.js";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetchStub(responses: Response[]): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
        headers[key] = value;
      }
    }
    calls.push({
      url: input.toString(),
      method: init?.method ?? "GET",
      headers,
      body: init?.body,
    });
    const response = responses[index];
    index += 1;
    if (response === undefined) throw new Error("registry.test.ts: stub ran out of responses");
    return response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown, statusText?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: statusText ?? "",
    headers: { "content-type": "application/json" },
  });
}

const BASE_URL = "https://registry.example.com";
const TOKEN = "tok_abc123";

const FILE_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const TARBALL_SHA = "1f5c0a4e0b8d9c7f6a5e4d3c2b1a09f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2";

function skillManifestBody(): unknown {
  return {
    name: "@acme/tdd-cycle",
    kind: "skill",
    version: "1.2.0",
    description: "Red, green, refactor loop for agents",
    files: [{ path: "SKILL.md", sha256: FILE_SHA, size: 1834 }],
    tarball: { url: "https://registry.example.com/v1/tarballs/abc.tgz", sha256: TARBALL_SHA, size: 4096 },
    publishedAt: "2026-08-06T00:00:00Z",
  };
}

function packManifestBody(): unknown {
  return {
    name: "@acme/frontend-baseline",
    kind: "pack",
    version: "3.0.0",
    description: "Everything a frontend repo at acme uses",
    skills: { "@acme/design-review": "1.4.0", "@baselane/tdd-cycle": "1.2.0" },
    publishedAt: "2026-08-06T00:00:00Z",
  };
}

describe("makeRegistryClient auth header", () => {
  it("attaches the bearer token to a same-origin request", async () => {
    const { fetchImpl, calls } = makeFetchStub([
      jsonResponse(200, { name: "@acme/foo", kind: "skill", latest: "1.0.0", versions: ["1.0.0"] }),
    ]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    await client.getPackageInfo("acme", "foo");
    expect(calls[0]!.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("does not attach the bearer token to a tarball URL on a different origin", async () => {
    const { fetchImpl, calls } = makeFetchStub([new Response(Buffer.from("tarball-bytes"), { status: 200 })]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    await client.getTarball("https://cdn.example.com/x.tgz");
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
  });

  it("attaches the bearer token to a tarball URL on the registry's own origin", async () => {
    const { fetchImpl, calls } = makeFetchStub([new Response(Buffer.from("tarball-bytes"), { status: 200 })]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    await client.getTarball(`${BASE_URL}/v1/tarballs/abc.tgz`);
    expect(calls[0]!.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("sends no Authorization header at all when no token is configured", async () => {
    const { fetchImpl, calls } = makeFetchStub([
      jsonResponse(200, { name: "@acme/foo", kind: "skill", latest: "1.0.0", versions: ["1.0.0"] }),
    ]);
    const client = makeRegistryClient(BASE_URL, undefined, fetchImpl);
    await client.getPackageInfo("acme", "foo");
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
  });
});

describe("makeRegistryClient error mapping", () => {
  it("maps a protocol error body to registry error <code>: <message>", async () => {
    const { fetchImpl } = makeFetchStub([
      jsonResponse(404, { error: { code: "not_found", message: "no such package" } }),
    ]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    await expect(client.getPackageInfo("acme", "missing")).rejects.toThrow(
      new AgpmError("registry error not_found: no such package"),
    );
  });

  it("maps an unparseable HTML error body to registry error http_<status>: <statusText>", async () => {
    const { fetchImpl } = makeFetchStub([
      new Response("<html><body>Internal Server Error</body></html>", {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "content-type": "text/html" },
      }),
    ]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    await expect(client.getPackageInfo("acme", "foo")).rejects.toThrow(
      new AgpmError("registry error http_500: Internal Server Error"),
    );
  });

  it("never includes the token in a thrown error message", async () => {
    const { fetchImpl } = makeFetchStub([
      jsonResponse(401, { error: { code: "unauthorized", message: "missing token" } }),
    ]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    try {
      await client.whoami();
      throw new Error("expected whoami to throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });

  it("redacts the token when a hostile or misbehaving server echoes it back in the error message", async () => {
    const { fetchImpl } = makeFetchStub([
      jsonResponse(401, { error: { code: "unauthorized", message: `bad token ${TOKEN} rejected` } }),
    ]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    await expect(client.whoami()).rejects.toThrow(
      new AgpmError("registry error unauthorized: bad token <redacted> rejected"),
    );
  });

  it("redacts the token when it is echoed back in an unparseable response's statusText", async () => {
    const { fetchImpl } = makeFetchStub([
      new Response("<html>error</html>", {
        status: 500,
        statusText: `boom ${TOKEN}`,
        headers: { "content-type": "text/html" },
      }),
    ]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    await expect(client.getPackageInfo("acme", "foo")).rejects.toThrow(
      new AgpmError(`registry error http_500: boom <redacted>`),
    );
  });
});

describe("makeRegistryClient response shape validation", () => {
  it("rejects a skill manifest missing files with registry error bad_response", async () => {
    const body = skillManifestBody() as Record<string, unknown>;
    delete body["files"];
    const { fetchImpl } = makeFetchStub([jsonResponse(200, body)]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    await expect(client.getVersionManifest("acme", "tdd-cycle", "1.2.0")).rejects.toThrow(AgpmError);
    const { fetchImpl: fetchImpl2 } = makeFetchStub([jsonResponse(200, body)]);
    const client2 = makeRegistryClient(BASE_URL, TOKEN, fetchImpl2);
    await expect(client2.getVersionManifest("acme", "tdd-cycle", "1.2.0")).rejects.toThrow(
      /^registry error bad_response: /,
    );
  });

  it("rejects a file entry whose sha256 is not 64 lowercase hex chars", async () => {
    const body = skillManifestBody() as Record<string, unknown>;
    (body["files"] as Record<string, unknown>[])[0]!["sha256"] = "NOT-VALID";
    const { fetchImpl } = makeFetchStub([jsonResponse(200, body)]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    await expect(client.getVersionManifest("acme", "tdd-cycle", "1.2.0")).rejects.toThrow(
      /^registry error bad_response: /,
    );
  });

  it("rejects package info missing the versions array", async () => {
    const { fetchImpl } = makeFetchStub([jsonResponse(200, { name: "@acme/foo", kind: "skill", latest: "1.0.0" })]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    await expect(client.getPackageInfo("acme", "foo")).rejects.toThrow(/^registry error bad_response: /);
  });

  it("rejects a whoami response with a non-array orgs field", async () => {
    const { fetchImpl } = makeFetchStub([jsonResponse(200, { user: "mohammad", orgs: "nope" })]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    await expect(client.whoami()).rejects.toThrow(/^registry error bad_response: /);
  });

  it("rejects package info whose latest field is not a valid version, without echoing it", async () => {
    const { fetchImpl } = makeFetchStub([
      jsonResponse(200, {
        name: "@acme/foo",
        kind: "skill",
        latest: "not-a-version\nInjected: header",
        versions: ["1.0.0"],
      }),
    ]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    let caught: Error | undefined;
    try {
      await client.getPackageInfo("acme", "foo");
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(AgpmError);
    expect(caught!.message).toMatch(/^registry error bad_response: /);
    expect(caught!.message).not.toContain("Injected");
  });

  it("rejects package info whose versions array has an invalid entry, without echoing it", async () => {
    const { fetchImpl } = makeFetchStub([
      jsonResponse(200, {
        name: "@acme/foo",
        kind: "skill",
        latest: "1.0.0",
        versions: ["1.0.0", "totally-bogus\ninjected"],
      }),
    ]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    let caught: Error | undefined;
    try {
      await client.getPackageInfo("acme", "foo");
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(AgpmError);
    expect(caught!.message).toMatch(/^registry error bad_response: /);
    expect(caught!.message).not.toContain("injected");
  });

  it("rejects a pack manifest whose skills map has an invalid member ref key, without echoing it", async () => {
    const body = packManifestBody() as Record<string, unknown>;
    body["skills"] = { "not-a-valid-ref\nInjected: header": "1.0.0" };
    const { fetchImpl } = makeFetchStub([jsonResponse(200, body)]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    let caught: Error | undefined;
    try {
      await client.getVersionManifest("acme", "frontend-baseline", "3.0.0");
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(AgpmError);
    expect(caught!.message).toMatch(/^registry error bad_response: /);
    expect(caught!.message).not.toContain("Injected");
  });

  it("rejects a pack manifest whose skills map has an invalid version value, without echoing it", async () => {
    const body = packManifestBody() as Record<string, unknown>;
    body["skills"] = { "@acme/design-review": "not-a-version\ninjected" };
    const { fetchImpl } = makeFetchStub([jsonResponse(200, body)]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    let caught: Error | undefined;
    try {
      await client.getVersionManifest("acme", "frontend-baseline", "3.0.0");
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(AgpmError);
    expect(caught!.message).toMatch(/^registry error bad_response: /);
    expect(caught!.message).not.toContain("injected");
  });
});

describe("makeRegistryClient happy paths", () => {
  it("getPackageInfo returns a typed PackageInfo", async () => {
    const { fetchImpl, calls } = makeFetchStub([
      jsonResponse(200, { name: "@acme/tdd-cycle", kind: "skill", latest: "1.2.0", versions: ["1.0.0", "1.2.0"] }),
    ]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    const info: PackageInfo = await client.getPackageInfo("acme", "tdd-cycle");
    expect(info).toEqual({
      name: "@acme/tdd-cycle",
      kind: "skill",
      latest: "1.2.0",
      versions: ["1.0.0", "1.2.0"],
    });
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/packages/@acme/tdd-cycle`);
  });

  it("getVersionManifest returns a typed SkillVersionManifest", async () => {
    const { fetchImpl, calls } = makeFetchStub([jsonResponse(200, skillManifestBody())]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    const manifest = (await client.getVersionManifest("acme", "tdd-cycle", "1.2.0")) as SkillVersionManifest;
    expect(manifest.kind).toBe("skill");
    expect(manifest.files).toEqual([{ path: "SKILL.md", sha256: FILE_SHA, size: 1834 }]);
    expect(manifest.tarball).toEqual({
      url: "https://registry.example.com/v1/tarballs/abc.tgz",
      sha256: TARBALL_SHA,
      size: 4096,
    });
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/packages/@acme/tdd-cycle/1.2.0`);
  });

  it("getVersionManifest returns a typed PackVersionManifest", async () => {
    const { fetchImpl } = makeFetchStub([jsonResponse(200, packManifestBody())]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    const manifest = (await client.getVersionManifest(
      "acme",
      "frontend-baseline",
      "3.0.0",
    )) as PackVersionManifest;
    expect(manifest.kind).toBe("pack");
    expect(manifest.skills).toEqual({ "@acme/design-review": "1.4.0", "@baselane/tdd-cycle": "1.2.0" });
  });

  it("getTarball returns the raw bytes as a Buffer", async () => {
    const { fetchImpl } = makeFetchStub([new Response(Buffer.from("tarball-bytes"), { status: 200 })]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    const bytes = await client.getTarball(`${BASE_URL}/v1/tarballs/abc.tgz`);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString("utf8")).toBe("tarball-bytes");
  });

  it("whoami returns a typed WhoamiResult", async () => {
    const { fetchImpl, calls } = makeFetchStub([
      jsonResponse(200, { user: "mohammad", orgs: [{ org: "baselane", role: "owner" }] }),
    ]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    const result: WhoamiResult = await client.whoami();
    expect(result).toEqual({ user: "mohammad", orgs: [{ org: "baselane", role: "owner" }] });
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/whoami`);
  });
});

describe("makeRegistryClient publish", () => {
  it("sends a PUT with multipart form fields manifest and tarball", async () => {
    const { fetchImpl, calls } = makeFetchStub([jsonResponse(201, skillManifestBody())]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    const manifest = { name: "@acme/tdd-cycle", kind: "skill", version: "1.2.0", description: "x", files: [] };
    const tarballBytes = Buffer.from("gzip-bytes");

    await client.publish("acme", "tdd-cycle", "1.2.0", manifest, tarballBytes);

    const call = calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url).toBe(`${BASE_URL}/v1/packages/@acme/tdd-cycle/1.2.0`);
    expect(call.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toBeInstanceOf(FormData);
    const form = call.body as FormData;
    expect(form.get("manifest")).toBe(JSON.stringify(manifest));
    const tarballField = form.get("tarball") as Blob;
    expect(tarballField).toBeInstanceOf(Blob);
    const receivedBytes = Buffer.from(await tarballField.arrayBuffer());
    expect(receivedBytes.equals(tarballBytes)).toBe(true);
  });

  it("sends only the manifest field when no tarball is given (pack publish)", async () => {
    const { fetchImpl, calls } = makeFetchStub([jsonResponse(201, packManifestBody())]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    const manifest = { name: "@acme/frontend-baseline", kind: "pack", version: "3.0.0", description: "x", skills: {} };

    await client.publish("acme", "frontend-baseline", "3.0.0", manifest);

    const form = calls[0]!.body as FormData;
    expect(form.get("manifest")).toBe(JSON.stringify(manifest));
    expect(form.get("tarball")).toBeNull();
  });

  it("maps a publish error (409 version_exists) to AgpmError", async () => {
    const { fetchImpl } = makeFetchStub([
      jsonResponse(409, { error: { code: "version_exists", message: "1.2.0 was already published" } }),
    ]);
    const client = makeRegistryClient(BASE_URL, TOKEN, fetchImpl);
    await expect(client.publish("acme", "tdd-cycle", "1.2.0", { name: "x" })).rejects.toThrow(
      new AgpmError("registry error version_exists: 1.2.0 was already published"),
    );
  });
});
