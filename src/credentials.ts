// Registry credentials store: reads and writes <homeDir>/.agpm/credentials, holding one
// bearer token per registry URL. AGPM_TOKEN always overrides whatever is on disk.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgpmError } from "./errors.js";

interface CredentialsFile {
  registries: Record<string, { token: string }>;
}

function credentialsPath(homeDir: string): string {
  return join(homeDir, ".agpm", "credentials");
}

function normalizeRegistryUrl(url: string): string {
  let out = url;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function brokenFileError(path: string): AgpmError {
  return new AgpmError(`broken credentials file at ${path}; delete it and run agpm login again`);
}

async function readCredentials(homeDir: string): Promise<CredentialsFile> {
  const path = credentialsPath(homeDir);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { registries: Object.create(null) as Record<string, { token: string }> };
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw brokenFileError(path);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw brokenFileError(path);
  }
  const registriesRaw = (raw as Record<string, unknown>)["registries"];
  if (typeof registriesRaw !== "object" || registriesRaw === null || Array.isArray(registriesRaw)) {
    throw brokenFileError(path);
  }

  const registries: Record<string, { token: string }> = Object.create(null);
  for (const [url, entry] of Object.entries(registriesRaw as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw brokenFileError(path);
    }
    const token = (entry as Record<string, unknown>)["token"];
    if (typeof token !== "string") {
      throw brokenFileError(path);
    }
    registries[normalizeRegistryUrl(url)] = { token };
  }
  return { registries };
}

function serializeCredentials(file: CredentialsFile): string {
  const sorted: Record<string, { token: string }> = Object.create(null);
  for (const url of Object.keys(file.registries).sort()) {
    sorted[url] = { token: file.registries[url]!.token };
  }
  return JSON.stringify({ registries: sorted }, null, 2) + "\n";
}

async function writeCredentials(homeDir: string, file: CredentialsFile): Promise<void> {
  const dir = join(homeDir, ".agpm");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(credentialsPath(homeDir), serializeCredentials(file), { mode: 0o600 });
}

export async function resolveToken(
  registryUrl: string,
  env: Record<string, string | undefined>,
  homeDir: string,
): Promise<string | undefined> {
  const envToken = env["AGPM_TOKEN"];
  if (envToken !== undefined) return envToken;
  const credentials = await readCredentials(homeDir);
  return credentials.registries[normalizeRegistryUrl(registryUrl)]?.token;
}

export async function writeToken(registryUrl: string, token: string, homeDir: string): Promise<void> {
  const credentials = await readCredentials(homeDir);
  const normalized = normalizeRegistryUrl(registryUrl);
  const registries: Record<string, { token: string }> = Object.create(null);
  for (const [url, entry] of Object.entries(credentials.registries)) {
    registries[url] = entry;
  }
  registries[normalized] = { token };
  await writeCredentials(homeDir, { registries });
}

export async function deleteToken(registryUrl: string, homeDir: string): Promise<boolean> {
  const credentials = await readCredentials(homeDir);
  const normalized = normalizeRegistryUrl(registryUrl);
  if (!Object.hasOwn(credentials.registries, normalized)) return false;

  const registries: Record<string, { token: string }> = Object.create(null);
  for (const [url, entry] of Object.entries(credentials.registries)) {
    if (url !== normalized) registries[url] = entry;
  }
  await writeCredentials(homeDir, { registries });
  return true;
}
