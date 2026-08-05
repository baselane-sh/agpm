import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agpm-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}
