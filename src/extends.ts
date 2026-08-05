import { AgpmError } from "./errors.js";
import { parseExtendsValue, parseManifest } from "./manifest.js";
import { KINDS, type ExtendsRef, type Kind, type Lock, type Manifest, type ResolvedExtends } from "./types.js";

export type { ExtendsRef } from "./types.js";

export interface ExtendsFetcher {
  resolveCommit(ref: ExtendsRef): Promise<string>;
  fetchManifest(ref: ExtendsRef, commit: string): Promise<string>;
}

const COMMIT_RE = /^[0-9a-f]{40}$/;

export function parseExtends(value: string): ExtendsRef {
  const ref = parseExtendsValue(value);
  if (ref === undefined) {
    throw new AgpmError(`extends must look like "github:owner/repo@ref", got "${value}"`);
  }
  return ref;
}

export async function resolveExtends(value: string, fetcher: ExtendsFetcher): Promise<ResolvedExtends> {
  const ref = parseExtends(value);
  const commit = await fetcher.resolveCommit(ref);
  if (!COMMIT_RE.test(commit)) {
    throw new AgpmError(`extends ${value}: resolved commit "${commit}" is not a 40 hex sha`);
  }
  const text = await fetcher.fetchManifest(ref, commit);
  const parent = parseManifest(text, `${ref.owner}/${ref.repo} harness.json at ${commit.slice(0, 12)}`);
  if (parent.extends !== undefined) {
    throw new AgpmError(
      `extends ${value}: the policy repo itself extends "${parent.extends}"; nested extends is not supported`,
    );
  }
  const sections = Object.create(null) as Record<Kind, Record<string, string>>;
  for (const kind of KINDS) {
    const copy = Object.create(null) as Record<string, string>;
    for (const name of Object.keys(parent[kind]).sort()) {
      copy[name] = parent[kind][name]!;
    }
    sections[kind] = copy;
  }
  return { commit, sections };
}

export function parentApproval(manifest: Manifest, lock: Lock, kind: Kind, name: string): string | undefined {
  // Freshness gate: a pin only suppresses the unlisted warning while it still matches the
  // manifest's current extends value. If harness.json's extends was added, removed, or
  // changed without running sync, the pin is stale and grants no approval.
  if (manifest.extends !== lock.extends) return undefined;
  const section = lock.extendsManifest?.[kind];
  if (section !== undefined && Object.hasOwn(section, name)) return section[name];
  return undefined;
}
