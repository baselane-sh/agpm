import { AgpmError } from "./errors.js";
import { parseManifest } from "./manifest.js";
import { KINDS, type Kind, type Lock, type ResolvedExtends } from "./types.js";

export interface ExtendsRef {
  owner: string;
  repo: string;
  ref: string;
}

export interface ExtendsFetcher {
  resolveCommit(ref: ExtendsRef): Promise<string>;
  fetchManifest(ref: ExtendsRef, commit: string): Promise<string>;
}

const EXTENDS_PARSE_RE = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([^\s@]+)$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export function parseExtends(value: string): ExtendsRef {
  const m = EXTENDS_PARSE_RE.exec(value);
  if (m === null) {
    throw new AgpmError(`extends must look like "github:owner/repo@ref", got "${value}"`);
  }
  return { owner: m[1]!, repo: m[2]!, ref: m[3]! };
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

export function parentApproval(lock: Lock, kind: Kind, name: string): string | undefined {
  const section = lock.extendsManifest?.[kind];
  if (section !== undefined && Object.hasOwn(section, name)) return section[name];
  return undefined;
}
