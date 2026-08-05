import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgpmError } from "../src/errors.js";
import { deleteToken, resolveToken, writeToken } from "../src/credentials.js";

async function makeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agpm-home-"));
}

describe("resolveToken", () => {
  it("prefers AGPM_TOKEN over the credentials file", async () => {
    const home = await makeHome();
    await writeToken("https://reg.example.com", "file-token", home);
    const token = await resolveToken("https://reg.example.com", { AGPM_TOKEN: "env-token" }, home);
    expect(token).toBe("env-token");
  });

  it("falls back to the credentials file when AGPM_TOKEN is unset", async () => {
    const home = await makeHome();
    await writeToken("https://reg.example.com", "file-token", home);
    const token = await resolveToken("https://reg.example.com", {}, home);
    expect(token).toBe("file-token");
  });

  it("returns undefined when neither the env var nor the file has a token", async () => {
    const home = await makeHome();
    const token = await resolveToken("https://reg.example.com", {}, home);
    expect(token).toBeUndefined();
  });

  it("resolves the same token regardless of a trailing slash on the registry URL", async () => {
    const home = await makeHome();
    await writeToken("https://reg.example.com/", "file-token", home);
    expect(await resolveToken("https://reg.example.com", {}, home)).toBe("file-token");
    expect(await resolveToken("https://reg.example.com/", {}, home)).toBe("file-token");
  });

  it("throws AgpmError with the exact message for a broken credentials file", async () => {
    const home = await makeHome();
    await mkdir(join(home, ".agpm"), { recursive: true });
    const path = join(home, ".agpm", "credentials");
    await writeFile(path, "{not json", "utf8");
    await expect(resolveToken("https://reg.example.com", {}, home)).rejects.toThrow(
      new AgpmError(`broken credentials file at ${path}; delete it and run agpm login again`),
    );
  });
});

describe("writeToken", () => {
  it("round trips: write then resolve returns the same token", async () => {
    const home = await makeHome();
    await writeToken("https://reg.example.com", "my-token", home);
    expect(await resolveToken("https://reg.example.com", {}, home)).toBe("my-token");
  });

  it("writes the credentials file with mode 0o600", async () => {
    const home = await makeHome();
    await writeToken("https://reg.example.com", "my-token", home);
    const info = await stat(join(home, ".agpm", "credentials"));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("creates the .agpm directory with mode 0o700", async () => {
    const home = await makeHome();
    await writeToken("https://reg.example.com", "my-token", home);
    const info = await stat(join(home, ".agpm"));
    expect(info.mode & 0o777).toBe(0o700);
  });

  it("preserves other registries' tokens when writing a new one", async () => {
    const home = await makeHome();
    await writeToken("https://reg-a.example.com", "token-a", home);
    await writeToken("https://reg-b.example.com", "token-b", home);
    expect(await resolveToken("https://reg-a.example.com", {}, home)).toBe("token-a");
    expect(await resolveToken("https://reg-b.example.com", {}, home)).toBe("token-b");
  });

  it("stores registry URLs without a trailing slash", async () => {
    const home = await makeHome();
    await writeToken("https://reg.example.com/", "my-token", home);
    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(join(home, ".agpm", "credentials"), "utf8"));
    expect(Object.keys(raw.registries)).toEqual(["https://reg.example.com"]);
  });
});

describe("deleteToken", () => {
  it("removes only the given registry's entry", async () => {
    const home = await makeHome();
    await writeToken("https://reg-a.example.com", "token-a", home);
    await writeToken("https://reg-b.example.com", "token-b", home);
    const result = await deleteToken("https://reg-a.example.com", home);
    expect(result).toBe(true);
    expect(await resolveToken("https://reg-a.example.com", {}, home)).toBeUndefined();
    expect(await resolveToken("https://reg-b.example.com", {}, home)).toBe("token-b");
  });

  it("returns false when nothing was stored for that registry", async () => {
    const home = await makeHome();
    const result = await deleteToken("https://reg.example.com", home);
    expect(result).toBe(false);
  });

  it("returns false when the registry was never stored, even if others exist", async () => {
    const home = await makeHome();
    await writeToken("https://reg-a.example.com", "token-a", home);
    const result = await deleteToken("https://reg-b.example.com", home);
    expect(result).toBe(false);
  });
});
