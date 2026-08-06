// Publish command: packs a skill folder or validates a pack manifest file and uploads it
// to the registry via RegistryClient.publish. See docs/superpowers/specs/
// 2026-08-06-registry-protocol-design.md section 8 for the wire format this builds.

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgpmError } from "./errors.js";
import type { RegistryClient } from "./registry.js";
import { formatRegistryRef, parseRegistryRef, VERSION_RE } from "./registryRef.js";
import { createTarball } from "./tar.js";

const DESCRIPTION_MAX_LENGTH = 200;
const DESCRIPTION_TRUNCATE_LENGTH = 197;

export interface PublishArgs {
  folder?: string;
  packFile?: string;
  ref: string;
  description?: string;
}

interface SkillManifestOut {
  name: string;
  kind: "skill";
  version: string;
  description: string;
  files: { path: string; sha256: string; size: number }[];
  tarball: { sha256: string; size: number };
}

interface PackManifestOut {
  name: string;
  kind: "pack";
  version: string;
  description: string;
  skills: Record<string, string>;
}

export async function runPublish(
  cwd: string,
  args: PublishArgs,
  client: RegistryClient,
): Promise<{ lines: string[] }> {
  const parsed = parseRegistryRef(args.ref);
  if (parsed === undefined || parsed.version === undefined) {
    throw new AgpmError("publish takes @org/name@version");
  }
  const { org, name, version } = parsed;

  if (args.folder !== undefined && args.packFile !== undefined) {
    throw new AgpmError("publish takes a folder or --pack, not both");
  }
  if (args.folder === undefined && args.packFile === undefined) {
    throw new AgpmError("publish takes a folder or --pack");
  }

  const ref = formatRegistryRef({ org, name, version });

  if (args.folder !== undefined) {
    const { manifest, tarball } = await buildSkillManifest(cwd, args.folder, org, name, version, args.description);
    await client.publish(org, name, version, manifest, tarball);
  } else {
    const manifest = await buildPackManifest(cwd, args.packFile!, org, name, version);
    await client.publish(org, name, version, manifest);
  }

  return { lines: [`published ${ref}`] };
}

async function buildSkillManifest(
  cwd: string,
  folder: string,
  org: string,
  name: string,
  version: string,
  descriptionArg: string | undefined,
): Promise<{ manifest: SkillManifestOut; tarball: Buffer }> {
  const absFolder = resolve(cwd, folder);
  const files = await readSkillFolder(absFolder);

  if (!Object.hasOwn(files, "SKILL.md")) {
    throw new AgpmError(`no SKILL.md in ${absFolder}`);
  }

  const description = resolveDescription(
    descriptionArg ?? descriptionFromSkillMd(files["SKILL.md"]!.toString("utf8")),
  );

  const fileEntries = Object.entries(files)
    .map(([path, content]) => ({ path, sha256: sha256Hex(content), size: content.length }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const tarball = createTarball(files);

  const manifest: SkillManifestOut = {
    name: `@${org}/${name}`,
    kind: "skill",
    version,
    description,
    files: fileEntries,
    tarball: { sha256: sha256Hex(tarball), size: tarball.length },
  };

  return { manifest, tarball };
}

async function readSkillFolder(absFolder: string): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = Object.create(null);

  try {
    await walk(absFolder, "");
  } catch (error) {
    if (error instanceof AgpmError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgpmError(`no such folder: ${absFolder}`);
    }
    throw error;
  }

  return files;

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new AgpmError(`refusing symlink in ${abs}`);
      }
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        files[rel] = await readFile(abs);
      }
    }
  }
}

function descriptionFromSkillMd(content: string): string | undefined {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    return line;
  }
  return undefined;
}

// Throws when no description was found (skill fallback path); otherwise truncates to the
// protocol's 200-char limit. Shared by both the skill and pack manifest builders.
function resolveDescription(description: string | undefined): string {
  if (description === undefined) {
    throw new AgpmError("no description found; pass --description");
  }
  return description.length > DESCRIPTION_MAX_LENGTH
    ? description.slice(0, DESCRIPTION_TRUNCATE_LENGTH) + "..."
    : description;
}

async function buildPackManifest(
  cwd: string,
  packFile: string,
  org: string,
  name: string,
  version: string,
): Promise<PackManifestOut> {
  const absPackFile = resolve(cwd, packFile);
  let raw: string;
  try {
    raw = await readFile(absPackFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgpmError(`no such file: ${absPackFile}`);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgpmError(`invalid pack file: not valid JSON`);
  }

  const { description, skills } = validatePackFile(parsed);

  return {
    name: `@${org}/${name}`,
    kind: "pack",
    version,
    description: resolveDescription(description),
    skills,
  };
}

function validatePackFile(value: unknown): { description: string; skills: Record<string, string> } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgpmError("invalid pack file: expected a JSON object");
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "description" && key !== "skills") {
      throw new AgpmError(`invalid pack file: unknown field "${key}"`);
    }
  }

  const description = obj["description"];
  if (typeof description !== "string") {
    throw new AgpmError(`invalid pack file: "description" must be a string`);
  }

  const skillsRaw = obj["skills"];
  if (typeof skillsRaw !== "object" || skillsRaw === null || Array.isArray(skillsRaw)) {
    throw new AgpmError(`invalid pack file: "skills" must be an object`);
  }

  const unsorted: Record<string, string> = Object.create(null);
  for (const [memberRef, memberVersion] of Object.entries(skillsRaw as Record<string, unknown>)) {
    const parsedMember = parseRegistryRef(memberRef);
    if (parsedMember === undefined || parsedMember.version !== undefined) {
      throw new AgpmError(`invalid pack file: bad skill ref "${memberRef}"`);
    }
    if (typeof memberVersion !== "string" || !VERSION_RE.test(memberVersion)) {
      throw new AgpmError(`invalid pack file: bad version for "${memberRef}"`);
    }
    unsorted[memberRef] = memberVersion;
  }

  const skills: Record<string, string> = Object.create(null);
  for (const key of Object.keys(unsorted).sort()) skills[key] = unsorted[key]!;

  return { description, skills };
}

function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
