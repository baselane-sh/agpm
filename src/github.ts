import { AgpmError } from "./errors.js";
import type { ExtendsFetcher, ExtendsRef } from "./extends.js";

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ status: number; text(): Promise<string> }>;

export function githubExtendsFetcher(
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): ExtendsFetcher {
  function headers(accept: string): Record<string, string> {
    const h: Record<string, string> = Object.create(null) as Record<string, string>;
    h["user-agent"] = "agpm";
    h["accept"] = accept;
    const token = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"];
    if (token !== undefined && token !== "") h["authorization"] = `Bearer ${token}`;
    return h;
  }

  async function request(url: string, accept: string, ref: ExtendsRef, what: string): Promise<string> {
    let res: { status: number; text(): Promise<string> };
    try {
      res = await fetchImpl(url, { headers: headers(accept) });
    } catch {
      throw new AgpmError(`extends github:${ref.owner}/${ref.repo}@${ref.ref}: network unreachable while trying to ${what}`);
    }
    if (res.status === 404) {
      throw new AgpmError(
        `extends github:${ref.owner}/${ref.repo}@${ref.ref}: ${what} returned 404; if the repo is private, set GITHUB_TOKEN`,
      );
    }
    if (res.status !== 200) {
      throw new AgpmError(`extends github:${ref.owner}/${ref.repo}@${ref.ref}: ${what} returned status ${res.status}`);
    }
    return await res.text();
  }

  return {
    async resolveCommit(ref: ExtendsRef): Promise<string> {
      const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(ref.ref)}`;
      return (await request(url, "application/vnd.github.sha", ref, "resolve the ref")).trim();
    },
    async fetchManifest(ref: ExtendsRef, commit: string): Promise<string> {
      const url = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${commit}/harness.json`;
      return await request(url, "application/json", ref, "fetch harness.json");
    },
  };
}
