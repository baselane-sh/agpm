import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgpmError } from "../src/errors.js";
import { writeToken } from "../src/credentials.js";
import type { RegistryClient, WhoamiResult } from "../src/registry.js";
import { runLogin, runLogout } from "../src/login.js";

async function makeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agpm-home-"));
}

function stubClient(
  behavior: { result?: WhoamiResult; error?: Error },
): { client: (token: string) => RegistryClient; tokensSeen: string[] } {
  const tokensSeen: string[] = [];
  const client = (token: string): RegistryClient => {
    tokensSeen.push(token);
    return {
      async getPackageInfo() {
        throw new Error("not implemented");
      },
      async getVersionManifest() {
        throw new Error("not implemented");
      },
      async getTarball() {
        throw new Error("not implemented");
      },
      async whoami() {
        if (behavior.error !== undefined) throw behavior.error;
        return behavior.result!;
      },
      async publish() {
        throw new Error("not implemented");
      },
    };
  };
  return { client, tokensSeen };
}

function promptReturning(value: string): (msg: string) => Promise<string> {
  return async () => value;
}

describe("runLogin", () => {
  it("prompts with the registry origin and the exact prompt text", async () => {
    const home = await makeHome();
    const { client } = stubClient({ result: { user: "ada", orgs: [] } });
    const prompts: string[] = [];
    const promptSecret = async (msg: string): Promise<string> => {
      prompts.push(msg);
      return "tok_123";
    };
    await runLogin("https://registry.example.com", promptSecret, client, home);
    expect(prompts).toEqual(["paste a token from https://registry.example.com/settings/tokens: "]);
  });

  it("throws AgpmError('no token entered') when the prompt returns an empty string", async () => {
    const home = await makeHome();
    const { client } = stubClient({ result: { user: "ada", orgs: [] } });
    await expect(runLogin("https://registry.example.com", promptReturning(""), client, home)).rejects.toThrow(
      new AgpmError("no token entered"),
    );
  });

  it("throws AgpmError('no token entered') when the prompt returns only whitespace", async () => {
    const home = await makeHome();
    const { client } = stubClient({ result: { user: "ada", orgs: [] } });
    await expect(runLogin("https://registry.example.com", promptReturning("   "), client, home)).rejects.toThrow(
      new AgpmError("no token entered"),
    );
  });

  it("does not write a token when the prompt is empty", async () => {
    const home = await makeHome();
    const { client } = stubClient({ result: { user: "ada", orgs: [] } });
    await expect(runLogin("https://registry.example.com", promptReturning(""), client, home)).rejects.toThrow();
    await expect(readFile(join(home, ".agpm", "credentials"), "utf8")).rejects.toThrow();
  });

  it("verifies the token via whoami() on a client built with that token", async () => {
    const home = await makeHome();
    const { client, tokensSeen } = stubClient({ result: { user: "ada", orgs: [] } });
    await runLogin("https://registry.example.com", promptReturning("tok_123"), client, home);
    expect(tokensSeen).toEqual(["tok_123"]);
  });

  it("surfaces a 401 as the client's registry error unauthorized message", async () => {
    const home = await makeHome();
    const { client } = stubClient({ error: new AgpmError("registry error unauthorized: invalid token") });
    await expect(runLogin("https://registry.example.com", promptReturning("bad-token"), client, home)).rejects.toThrow(
      new AgpmError("registry error unauthorized: invalid token"),
    );
  });

  it("does not write a token when whoami fails", async () => {
    const home = await makeHome();
    const { client } = stubClient({ error: new AgpmError("registry error unauthorized: invalid token") });
    await expect(
      runLogin("https://registry.example.com", promptReturning("bad-token"), client, home),
    ).rejects.toThrow();
    await expect(readFile(join(home, ".agpm", "credentials"), "utf8")).rejects.toThrow();
  });

  it("on success, writes the token to the credentials store", async () => {
    const home = await makeHome();
    const { client } = stubClient({ result: { user: "ada", orgs: [] } });
    await runLogin("https://registry.example.com", promptReturning("tok_123"), client, home);
    const raw = JSON.parse(await readFile(join(home, ".agpm", "credentials"), "utf8"));
    expect(raw.registries["https://registry.example.com"].token).toBe("tok_123");
  });

  it("returns the success line with the user and no orgs shown as 'none'", async () => {
    const home = await makeHome();
    const { client } = stubClient({ result: { user: "ada", orgs: [] } });
    const result = await runLogin("https://registry.example.com", promptReturning("tok_123"), client, home);
    expect(result.lines).toEqual(["logged in to https://registry.example.com as ada (orgs: none)"]);
  });

  it("returns the success line with a comma list of org names", async () => {
    const home = await makeHome();
    const { client } = stubClient({
      result: { user: "ada", orgs: [{ org: "acme", role: "member" }, { org: "widgets", role: "owner" }] },
    });
    const result = await runLogin("https://registry.example.com", promptReturning("tok_123"), client, home);
    expect(result.lines).toEqual(["logged in to https://registry.example.com as ada (orgs: acme, widgets)"]);
  });

  it("never includes the token value in the returned lines", async () => {
    const home = await makeHome();
    const { client } = stubClient({ result: { user: "ada", orgs: [] } });
    const result = await runLogin(
      "https://registry.example.com",
      promptReturning("super-secret-token-value"),
      client,
      home,
    );
    for (const line of result.lines) {
      expect(line).not.toContain("super-secret-token-value");
    }
  });
});

describe("runLogout", () => {
  it("deletes the stored token and returns the logged out line", async () => {
    const home = await makeHome();
    await writeToken("https://registry.example.com", "tok_123", home);
    const result = await runLogout("https://registry.example.com", home);
    expect(result.lines).toEqual(["logged out of https://registry.example.com"]);
  });

  it("actually removes the token from the credentials store", async () => {
    const home = await makeHome();
    await writeToken("https://registry.example.com", "tok_123", home);
    await runLogout("https://registry.example.com", home);
    const raw = JSON.parse(await readFile(join(home, ".agpm", "credentials"), "utf8"));
    expect(Object.hasOwn(raw.registries, "https://registry.example.com")).toBe(false);
  });

  it("returns the no-stored-token line when nothing was stored", async () => {
    const home = await makeHome();
    const result = await runLogout("https://registry.example.com", home);
    expect(result.lines).toEqual(["no stored token for https://registry.example.com"]);
  });

  it("does not affect other registries' stored tokens", async () => {
    const home = await makeHome();
    await writeToken("https://reg-a.example.com", "token-a", home);
    await writeToken("https://reg-b.example.com", "token-b", home);
    await runLogout("https://reg-a.example.com", home);
    const raw = JSON.parse(await readFile(join(home, ".agpm", "credentials"), "utf8"));
    expect(Object.hasOwn(raw.registries, "https://reg-a.example.com")).toBe(false);
    expect(raw.registries["https://reg-b.example.com"].token).toBe("token-b");
  });
});
