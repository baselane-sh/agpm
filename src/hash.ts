import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AgpmError } from "./errors.js";

export function sha256(data: string | Uint8Array): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

export async function hashDir(absDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await walk(absDir, "");
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new AgpmError(`refusing symlink at ${join(dir, entry.name)}; agpm hashes regular files only`);
      }
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        out[rel] = sha256(await readFile(join(dir, entry.name)));
      }
    }
  }
}
