// Update engine: refreshes registry-provenance skill installs to the latest published
// version. Reuses install.ts's fetch-verify-place path (installOneSkill) and the same
// computeSync-based harness.json/harness.lock write pattern install.ts uses.
//
// V1 updates direct skill installs only. A pack member (provenance
// "registry:@org/pack@version/@org/name@version") is reported with a "skipped" line
// pointing at the pack, whether it was named explicitly or picked up during a
// no-argument bulk update; updating a pack is out of scope here.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgpmError } from "./errors.js";
import { installOneSkill } from "./install.js";
import { emptyLock, parseLock, serializeLock } from "./lock.js";
import { parseManifest, serializeManifest } from "./manifest.js";
import { readProvenance } from "./provenance.js";
import type { RegistryClient } from "./registry.js";
import { compareVersions, formatRegistryRef, parseRegistryRef } from "./registryRef.js";
import { scanRepo } from "./scan.js";
import { computeSync, type SyncResult } from "./sync.js";
import type { Lock, Manifest } from "./types.js";

const REMINDER = "install is not approval; commit the harness diff and approve it by PR";

interface DirectRef {
  org: string;
  name: string;
  version: string;
}

export async function runUpdate(
  cwd: string,
  name: string | undefined,
  client: RegistryClient,
): Promise<{ lines: string[] }> {
  const { manifest, lock } = await loadHarnessFiles(cwd);

  const lines: string[] = [];
  let updatedAny = false;

  if (name !== undefined) {
    const provenance = Object.hasOwn(manifest.skills, name) ? manifest.skills[name] : undefined;
    if (provenance === undefined) {
      throw new AgpmError(`skills/${name} is not installed`);
    }
    if (!provenance.startsWith("registry:")) {
      throw new AgpmError(`skills/${name} has provenance "${provenance}"; update handles only registry: entries`);
    }
    updatedAny = await processEntry(cwd, client, manifest, name, provenance, lines);
  } else {
    for (const skillName of Object.keys(manifest.skills).sort()) {
      const provenance = manifest.skills[skillName]!;
      if (!provenance.startsWith("registry:")) continue;
      if (await processEntry(cwd, client, manifest, skillName, provenance, lines)) updatedAny = true;
    }
  }

  const { sources } = await readProvenance(cwd);
  const result = computeSync(manifest, lock, await scanRepo(cwd), sources);
  await writeHarnessFiles(cwd, result);

  if (updatedAny) lines.push(REMINDER);
  return { lines };
}

// Processes one registry: entry in place (mutating `manifest.skills` on update) and
// appends its output line(s) to `lines`, in the order the caller visits entries. Returns
// whether a new version was installed. A pack-member provenance is reported with a
// "skipped" line rather than updated; v1 updates direct skill installs only.
async function processEntry(
  cwd: string,
  client: RegistryClient,
  manifest: Manifest,
  name: string,
  provenance: string,
  lines: string[],
): Promise<boolean> {
  const ref = parseDirectRef(provenance);
  if (ref === undefined) {
    lines.push(`skipped skills/${name}: member of ${packRefOf(provenance)}; update the pack instead`);
    return false;
  }

  const { org, name: pkgName, version } = ref;
  const info = await client.getPackageInfo(org, pkgName);
  if (compareVersions(info.latest, version) <= 0) {
    lines.push(`skills/${name} is current (${version})`);
    return false;
  }

  const newProvenance = `registry:${formatRegistryRef({ org, name: pkgName, version: info.latest })}`;
  const entry = await installOneSkill(cwd, client, org, pkgName, info.latest, newProvenance);
  manifest.skills[name] = entry.provenance;
  lines.push(`updated skills/${name} ${version} -> ${info.latest}`);
  return true;
}

function parseDirectRef(provenance: string): DirectRef | undefined {
  const rest = provenance.slice("registry:".length);
  if (rest.split("/").length !== 2) return undefined;
  const parsed = parseRegistryRef(rest);
  if (parsed === undefined || parsed.version === undefined) return undefined;
  return { org: parsed.org, name: parsed.name, version: parsed.version };
}

function packRefOf(provenance: string): string {
  const rest = provenance.slice("registry:".length);
  const segments = rest.split("/");
  return `${segments[0]!}/${segments[1]!}`;
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
