// HTTP client for the baselane registry protocol v1 (see
// docs/superpowers/specs/2026-08-06-registry-protocol-design.md). Raw fetch only, zero
// runtime dependencies. The bearer token is attached only to requests whose URL origin
// equals the registry base URL's origin, so a tarball hosted on a third-party CDN never
// sees the token.

import { Buffer } from "node:buffer";
import { AgpmError } from "./errors.js";

const SHA256_RE = /^[0-9a-f]{64}$/;

export interface RegistryFileEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface SkillVersionManifest {
  name: string;
  kind: "skill";
  version: string;
  description: string;
  files: RegistryFileEntry[];
  tarball: { url: string; sha256: string; size: number };
}

export interface PackVersionManifest {
  name: string;
  kind: "pack";
  version: string;
  description: string;
  skills: Record<string, string>;
}

export type VersionManifest = SkillVersionManifest | PackVersionManifest;

export interface PackageInfo {
  name: string;
  kind: "skill" | "pack";
  latest: string;
  versions: string[];
}

export interface WhoamiResult {
  user: string;
  orgs: { org: string; role: string }[];
}

export interface RegistryClient {
  getPackageInfo(org: string, name: string): Promise<PackageInfo>;
  getVersionManifest(org: string, name: string, version: string): Promise<VersionManifest>;
  getTarball(url: string): Promise<Buffer>;
  whoami(): Promise<WhoamiResult>;
  publish(org: string, name: string, version: string, manifest: unknown, tarball?: Buffer): Promise<void>;
}

export function makeRegistryClient(baseUrl: string, token: string | undefined, fetchImpl: typeof fetch): RegistryClient {
  const base = new URL(baseUrl);

  function authHeaders(url: URL): Record<string, string> {
    if (token !== undefined && url.origin === base.origin) {
      return { Authorization: `Bearer ${token}` };
    }
    return {};
  }

  function packageUrl(org: string, name: string, version?: string): URL {
    const path = version === undefined
      ? `/v1/packages/@${encodeURIComponent(org)}/${encodeURIComponent(name)}`
      : `/v1/packages/@${encodeURIComponent(org)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
    return new URL(path, base);
  }

  // Defense in depth against a misbehaving or hostile server echoing the Authorization
  // header back in an error body: strip the configured token before it ever reaches
  // AgpmError text (protocol spec section 7).
  function redact(text: string): string {
    return token !== undefined ? text.split(token).join("<redacted>") : text;
  }

  async function throwForErrorResponse(response: Response): Promise<never> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AgpmError(`registry error http_${response.status}: ${redact(response.statusText)}`);
    }
    const code = errorField(body, "code");
    const message = errorField(body, "message");
    if (code === undefined || message === undefined) {
      throw new AgpmError(`registry error http_${response.status}: ${redact(response.statusText)}`);
    }
    throw new AgpmError(`registry error ${code}: ${redact(message)}`);
  }

  function errorField(body: unknown, field: "code" | "message"): string | undefined {
    if (typeof body !== "object" || body === null) return undefined;
    const error = (body as Record<string, unknown>)["error"];
    if (typeof error !== "object" || error === null) return undefined;
    const value = (error as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
  }

  async function requestJson(url: URL): Promise<unknown> {
    const response = await fetchImpl(url, { headers: authHeaders(url) });
    if (!response.ok) await throwForErrorResponse(response);
    try {
      return await response.json();
    } catch {
      bad("response body is not valid JSON");
    }
  }

  return {
    async getPackageInfo(org, name) {
      const body = await requestJson(packageUrl(org, name));
      return validatePackageInfo(body);
    },

    async getVersionManifest(org, name, version) {
      const body = await requestJson(packageUrl(org, name, version));
      return validateVersionManifest(body);
    },

    async getTarball(url) {
      const target = new URL(url);
      const response = await fetchImpl(target, { headers: authHeaders(target) });
      if (!response.ok) await throwForErrorResponse(response);
      return Buffer.from(await response.arrayBuffer());
    },

    async whoami() {
      const body = await requestJson(new URL("/v1/whoami", base));
      return validateWhoami(body);
    },

    async publish(org, name, version, manifest, tarball) {
      const form = new FormData();
      form.set("manifest", JSON.stringify(manifest));
      if (tarball !== undefined) {
        form.set("tarball", new Blob([new Uint8Array(tarball)]));
      }
      const url = packageUrl(org, name, version);
      const response = await fetchImpl(url, {
        method: "PUT",
        headers: authHeaders(url),
        body: form,
      });
      if (!response.ok) await throwForErrorResponse(response);
    },
  };
}

function bad(what: string): never {
  throw new AgpmError(`registry error bad_response: ${what}`);
}

function requireObject(body: unknown, label: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    bad(`${label} is not an object`);
  }
  return body as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== "string") bad(`missing or invalid field "${field}"`);
  return value;
}

function requireNumber(obj: Record<string, unknown>, field: string): number {
  const value = obj[field];
  if (typeof value !== "number") bad(`missing or invalid field "${field}"`);
  return value;
}

function requireSha256(obj: Record<string, unknown>, field: string): string {
  const value = requireString(obj, field);
  if (!SHA256_RE.test(value)) bad(`field "${field}" is not a 64-character lowercase hex sha256`);
  return value;
}

function requireKind(obj: Record<string, unknown>): "skill" | "pack" {
  const kind = obj["kind"];
  if (kind !== "skill" && kind !== "pack") bad(`field "kind" is not "skill" or "pack"`);
  return kind;
}

function validatePackageInfo(body: unknown): PackageInfo {
  const obj = requireObject(body, "package info response");
  const name = requireString(obj, "name");
  const kind = requireKind(obj);
  const latest = requireString(obj, "latest");
  const versionsRaw = obj["versions"];
  if (!Array.isArray(versionsRaw) || !versionsRaw.every((entry) => typeof entry === "string")) {
    bad(`field "versions" is not an array of strings`);
  }
  return { name, kind, latest, versions: versionsRaw as string[] };
}

function validateVersionManifest(body: unknown): VersionManifest {
  const obj = requireObject(body, "version manifest response");
  const name = requireString(obj, "name");
  const kind = requireKind(obj);
  const version = requireString(obj, "version");
  const description = requireString(obj, "description");

  if (kind === "pack") {
    return { name, kind, version, description, skills: validateSkillsMap(obj) };
  }

  const filesRaw = obj["files"];
  if (!Array.isArray(filesRaw)) bad(`field "files" is not an array`);
  const files = filesRaw.map((entry, index) => validateFileEntry(entry, index));
  const tarballObj = requireObject(obj["tarball"], `field "tarball"`);
  const tarball = {
    url: requireString(tarballObj, "url"),
    sha256: requireSha256(tarballObj, "sha256"),
    size: requireNumber(tarballObj, "size"),
  };
  return { name, kind, version, description, files, tarball };
}

function validateSkillsMap(obj: Record<string, unknown>): Record<string, string> {
  const skillsRaw = obj["skills"];
  if (typeof skillsRaw !== "object" || skillsRaw === null || Array.isArray(skillsRaw)) {
    bad(`field "skills" is not an object`);
  }
  const skills: Record<string, string> = Object.create(null);
  for (const [memberRef, version] of Object.entries(skillsRaw as Record<string, unknown>)) {
    if (typeof version !== "string") bad(`field "skills.${memberRef}" is not a string`);
    skills[memberRef] = version;
  }
  return skills;
}

function validateFileEntry(entry: unknown, index: number): RegistryFileEntry {
  const obj = requireObject(entry, `files[${index}]`);
  return {
    path: requireString(obj, "path"),
    sha256: requireSha256(obj, "sha256"),
    size: requireNumber(obj, "size"),
  };
}

function validateWhoami(body: unknown): WhoamiResult {
  const obj = requireObject(body, "whoami response");
  const user = requireString(obj, "user");
  const orgsRaw = obj["orgs"];
  if (!Array.isArray(orgsRaw)) bad(`field "orgs" is not an array`);
  const orgs = orgsRaw.map((entry, index) => validateOrgEntry(entry, index));
  return { user, orgs };
}

function validateOrgEntry(entry: unknown, index: number): { org: string; role: string } {
  const obj = requireObject(entry, `orgs[${index}]`);
  return { org: requireString(obj, "org"), role: requireString(obj, "role") };
}
