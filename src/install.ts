// Install engine: resolves a "@org/name" or "@org/name@version" registry ref (skill or
// pack) against a RegistryClient, verifies every byte against its declared sha256, writes
// the skill(s) into every existing skill root, and records registry provenance via the
// same computeSync path agpm sync uses.

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgpmError } from "./errors.js";
import { emptyLock, parseLock, serializeLock } from "./lock.js";
import { parseManifest, serializeManifest } from "./manifest.js";
import { readProvenance } from "./provenance.js";
import type { RegistryClient, SkillVersionManifest, VersionManifest } from "./registry.js";
import { formatRegistryRef, parseRegistryRef } from "./registryRef.js";
import { scanRepo } from "./scan.js";
import { computeSync, type SyncResult } from "./sync.js";
import { extractTarball } from "./tar.js";
import type { Lock, Manifest } from "./types.js";

const REMINDER = "install is not approval; commit the harness diff and approve it by PR";
const SKILL_ROOTS = [".claude/skills", ".agents/skills"];

interface ResolvedSkill {
  org: string;
  name: string;
  version: string;
  manifest: SkillVersionManifest;
  provenance: string;
}

interface InstallEntry {
  name: string;
  provenance: string;
  files: Record<string, Buffer>;
}

export async function runInstall(
  cwd: string,
  refValue: string,
  client: RegistryClient,
): Promise<{ lines: string[] }> {
  const parsed = parseRegistryRef(refValue);
  if (parsed === undefined) {
    throw new AgpmError("install takes @org/name or @org/name@version");
  }

  const version = parsed.version ?? (await client.getPackageInfo(parsed.org, parsed.name)).latest;
  const topManifest = await client.getVersionManifest(parsed.org, parsed.name, version);
  const resolved = await resolvePending(client, parsed.org, parsed.name, version, topManifest);

  const entries: InstallEntry[] = [];
  for (const skill of resolved) {
    entries.push(await fetchAndVerify(client, skill));
  }

  const roots = await targetRoots(cwd);
  const { manifest, lock } = await loadHarnessFiles(cwd);
  await checkCollisions(cwd, roots, manifest, entries);

  for (const entry of entries) {
    await writeEntry(cwd, roots, entry);
    manifest.skills[entry.name] = entry.provenance;
  }

  const { sources } = await readProvenance(cwd);
  const result = computeSync(manifest, lock, await scanRepo(cwd), sources);
  await writeHarnessFiles(cwd, result);

  const lines = entries.map((entry) => `installed skills/${entry.name} (${entry.provenance})`);
  lines.push(REMINDER);
  return { lines };
}

async function resolvePending(
  client: RegistryClient,
  org: string,
  name: string,
  version: string,
  manifest: VersionManifest,
): Promise<ResolvedSkill[]> {
  if (manifest.kind === "skill") {
    return [{ org, name, version, manifest, provenance: `registry:${formatRegistryRef({ org, name, version })}` }];
  }

  const packRef = formatRegistryRef({ org, name, version });
  const members = Object.entries(manifest.skills)
    .map(([memberRef, memberVersion]) => {
      const parsedMember = parseRegistryRef(memberRef);
      if (parsedMember === undefined) {
        throw new AgpmError(`registry error invalid_package: bad pack member ref "${memberRef}"`);
      }
      return { org: parsedMember.org, name: parsedMember.name, version: memberVersion };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const resolved: ResolvedSkill[] = [];
  for (const member of members) {
    const memberManifest = await client.getVersionManifest(member.org, member.name, member.version);
    if (memberManifest.kind !== "skill") {
      throw new AgpmError("registry error invalid_package: pack members must be skills");
    }
    const provenance = `registry:${packRef}/${formatRegistryRef(member)}`;
    resolved.push({ ...member, manifest: memberManifest, provenance });
  }
  return resolved;
}

async function fetchAndVerify(client: RegistryClient, skill: ResolvedSkill): Promise<InstallEntry> {
  const { org, name, version, manifest, provenance } = skill;
  const ref = formatRegistryRef({ org, name, version });

  const gz = await client.getTarball(manifest.tarball.url);
  if (sha256Hex(gz) !== manifest.tarball.sha256) {
    throw new AgpmError(`tarball hash mismatch for ${ref}`);
  }

  const extracted = extractTarball(gz);
  const manifestPaths = new Set(manifest.files.map((entry) => entry.path));
  for (const path of Object.keys(extracted).sort()) {
    if (!manifestPaths.has(path)) throw new AgpmError(`file hash mismatch for ${ref}: ${path}`);
  }
  for (const entry of [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const content = extracted[entry.path];
    if (content === undefined || sha256Hex(content) !== entry.sha256) {
      throw new AgpmError(`file hash mismatch for ${ref}: ${entry.path}`);
    }
  }
  if (!manifestPaths.has("SKILL.md")) {
    throw new AgpmError(`${ref} has no SKILL.md; not a skill package`);
  }

  return { name, provenance, files: extracted };
}

function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function targetRoots(cwd: string): Promise<string[]> {
  const existing: string[] = [];
  for (const dir of SKILL_ROOTS) {
    if (await isDirectory(join(cwd, dir))) existing.push(dir);
  }
  return existing.length > 0 ? existing : [SKILL_ROOTS[0]!];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function checkCollisions(
  cwd: string,
  roots: string[],
  manifest: Manifest,
  entries: InstallEntry[],
): Promise<void> {
  for (const entry of entries) {
    const existing = Object.hasOwn(manifest.skills, entry.name) ? manifest.skills[entry.name] : undefined;
    if (existing !== undefined) {
      if (existing !== entry.provenance) {
        throw new AgpmError(
          `skills/${entry.name} exists with provenance "${existing}"; remove it first (agpm remove ${entry.name})`,
        );
      }
      continue;
    }
    for (const root of roots) {
      if (await isDirectory(join(cwd, root, entry.name))) {
        throw new AgpmError(
          `skills/${entry.name} exists with provenance "unapproved"; remove it first (agpm remove ${entry.name})`,
        );
      }
    }
  }
}

async function writeEntry(cwd: string, roots: string[], entry: InstallEntry): Promise<void> {
  for (const root of roots) {
    const base = join(cwd, root, entry.name);
    for (const [relPath, content] of Object.entries(entry.files)) {
      const dest = join(base, relPath);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, content);
    }
  }
}

async function loadHarnessFiles(cwd: string): Promise<{ manifest: Manifest; lock: Lock }> {
  const manifestPath = join(cwd, "harness.json");
  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgpmError(`no harness.json found in ${cwd}; run agpm init`);
    }
    throw error;
  }
  const manifest = parseManifest(manifestText, manifestPath);
  const lockPath = join(cwd, "harness.lock");
  let lock: Lock;
  try {
    lock = parseLock(await readFile(lockPath, "utf8"), lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      lock = emptyLock();
    } else {
      throw error;
    }
  }
  return { manifest, lock };
}

async function writeHarnessFiles(cwd: string, result: SyncResult): Promise<void> {
  await writeFile(join(cwd, "harness.json"), serializeManifest(result.manifest), "utf8");
  await writeFile(join(cwd, "harness.lock"), serializeLock(result.lock), "utf8");
}
