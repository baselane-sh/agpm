import { describe, expect, it } from "vitest";
import { githubExtendsFetcher, type FetchLike } from "../src/github.js";

const ref = { owner: "acme", repo: "policy", ref: "main" };

function fetchReturning(status: number, body: string, calls: { url: string; headers: Record<string, string> }[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { status, text: async () => body };
  };
}

describe("githubExtendsFetcher", () => {
  it("resolves a ref to the sha via the commits endpoint", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = githubExtendsFetcher({}, fetchReturning(200, "a".repeat(40) + "\n", calls));
    expect(await fetcher.resolveCommit(ref)).toBe("a".repeat(40));
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/policy/commits/main");
    expect(calls[0]!.headers["accept"]).toBe("application/vnd.github.sha");
    expect(calls[0]!.headers["user-agent"]).toBe("agpm");
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
  });

  it("fetches harness.json from raw at the pinned commit", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = githubExtendsFetcher({}, fetchReturning(200, "{}", calls));
    expect(await fetcher.fetchManifest(ref, "b".repeat(40))).toBe("{}");
    expect(calls[0]!.url).toBe(`https://raw.githubusercontent.com/acme/policy/${"b".repeat(40)}/harness.json`);
  });

  it("sends the token from GITHUB_TOKEN, preferring it over GH_TOKEN", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = githubExtendsFetcher({ GITHUB_TOKEN: "t1", GH_TOKEN: "t2" }, fetchReturning(200, "a".repeat(40), calls));
    await fetcher.resolveCommit(ref);
    expect(calls[0]!.headers["authorization"]).toBe("Bearer t1");
  });

  it("maps 404 to a named error with the auth hint", async () => {
    const fetcher = githubExtendsFetcher({}, fetchReturning(404, "not found"));
    await expect(fetcher.resolveCommit(ref)).rejects.toThrow(/github:acme\/policy@main.*GITHUB_TOKEN/);
  });

  it("maps another status to a named error with the code", async () => {
    const fetcher = githubExtendsFetcher({}, fetchReturning(500, "boom"));
    await expect(fetcher.resolveCommit(ref)).rejects.toThrow(/500/);
  });

  it("maps a network failure to a named error", async () => {
    const down: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const fetcher = githubExtendsFetcher({}, down);
    await expect(fetcher.resolveCommit(ref)).rejects.toThrow(/acme\/policy.*unreachable/);
  });
});
