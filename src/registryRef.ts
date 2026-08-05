// Registry reference parsing: "@org/name" and "@org/name@version" strings, plus the
// "registry:..." provenance grammar built on top of them (protocol spec: registry refs).

// Duplicated from manifest.ts's NAME_RE rather than imported, to avoid a
// manifest.ts <-> registryRef.ts import cycle (manifest.ts imports isRegistryProvenance).
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_MAX_LENGTH = 100;

export const ORG_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
export const VERSION_RE = /^\d+\.\d+\.\d+$/;

export interface RegistryRef {
  org: string;
  name: string;
  version?: string;
}

export function parseRegistryRef(value: string): RegistryRef | undefined {
  if (!value.startsWith("@")) return undefined;
  const slash = value.indexOf("/");
  if (slash === -1) return undefined;
  const org = value.slice(1, slash);
  const rest = value.slice(slash + 1);
  const at = rest.indexOf("@");
  const name = at === -1 ? rest : rest.slice(0, at);
  const version = at === -1 ? undefined : rest.slice(at + 1);
  if (!ORG_RE.test(org)) return undefined;
  if (name.length > NAME_MAX_LENGTH || !NAME_RE.test(name)) return undefined;
  if (version !== undefined && !VERSION_RE.test(version)) return undefined;
  return version === undefined ? { org, name } : { org, name, version };
}

export function formatRegistryRef(ref: { org: string; name: string; version: string }): string {
  return `@${ref.org}/${ref.name}@${ref.version}`;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Accepts "registry:@org/name@version" and the pack-member form
// "registry:@org/pack@version/@org/name@version". Both refs must carry a version;
// exactly one or two refs are allowed, never more.
export function isRegistryProvenance(value: string): boolean {
  if (!value.startsWith("registry:")) return false;
  const rest = value.slice("registry:".length);
  if (rest === "") return false;
  const segments = rest.split("/");
  if (segments.length === 2) {
    return isVersionedRef(`${segments[0]!}/${segments[1]!}`);
  }
  if (segments.length === 4) {
    return isVersionedRef(`${segments[0]!}/${segments[1]!}`) && isVersionedRef(`${segments[2]!}/${segments[3]!}`);
  }
  return false;
}

function isVersionedRef(candidate: string): boolean {
  const ref = parseRegistryRef(candidate);
  return ref !== undefined && ref.version !== undefined;
}
