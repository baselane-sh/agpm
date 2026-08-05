# agpm M1 Offline Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the offline heart of agpm: the harness.json and harness.lock formats, the directory scanner, sha256 hashing, and the `check` and `list` commands, all runnable with zero network.

**Architecture:** Small pure modules (parse, hash, scan, check, list) composed by a thin CLI. The scanner reads the four observed directories; `check` is a pure function over (manifest, lock, scan); the CLI only does IO and dispatch. agpm writes no files in M1.

**Tech Stack:** TypeScript (strict, NodeNext) compiled by tsc to plain JS. Node >= 20. Dev deps: typescript, vitest, and @types/node (types only; tsc needs it to check `node:` builtin imports). Zero runtime dependencies. (Amended 2026-08-05: @types/node added after Task 1 hit TS2591 on `node:crypto` without it.)

## Global Constraints

Copied from the spec (`docs/superpowers/specs/2026-08-05-agpm-design.md`, commit a0c8825):

- Zero runtime dependencies. `node:crypto` for hashes. No new npm packages beyond dev deps `typescript`, `vitest`, and `@types/node`.
- Node 20 or newer (`"engines": { "node": ">=20" }`).
- ESM throughout (`"type": "module"`). Relative imports use the `.js` extension (`import { x } from "./hash.js"`) because tsc emits real JS for npm. Vitest resolves these to the `.ts` sources.
- agpm never installs, copies, updates, or removes a skill folder. M1 writes no files at all.
- harness.lock rules: no timestamps, keys sorted at every level, so branches merge cleanly.
- `check` exit codes: 0 clean, 1 violations, 2 internal error.
- Fail loud. Broken harness.json or harness.lock is a clear parse error naming the file path. Never guess, never swallow.
- No em-dashes in any output text, label, or message.
- No `console.log` in `src/` (the CLI writes through an injected writer; the bin uses `process.stdout`).
- All work happens in `/Users/mohammad/Desktop/agpm`. Use absolute paths in commands; do not rely on `cd`.
- Extends: M1 parses and validates the `extends` field but does not resolve it. Resolution is M3 by spec. `runCheck` ignores it.

## File Structure

```
package.json            scripts, bin, engines, dev deps
tsconfig.json           strict NodeNext, outDir dist
.gitignore              node_modules, dist
src/errors.ts           AgpmError
src/types.ts            Manifest, Lock, ScanResult, Finding, CheckResult
src/hash.ts             sha256(), hashDir()
src/manifest.ts         parseManifest()
src/lock.ts             parseLock(), serializeLock()
src/scan.ts             scanRepo()
src/check.ts            runCheck()
src/list.ts             formatList()
src/cli.ts              runCli()
src/bin.ts              #!/usr/bin/env node entry
test/helpers.ts         makeRepo() temp-dir fixture builder
test/*.test.ts          one test file per module
```

---

### Task 1: Scaffold + hash module

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/errors.ts`, `src/hash.ts`
- Test: `test/hash.test.ts`, `test/helpers.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `class AgpmError extends Error` (src/errors.ts). `sha256(data: string | Uint8Array): string` returning `"sha256:<64 lowercase hex>"`. `hashDir(absDir: string): Promise<Record<string, string>>` returning posix relative path -> `"sha256:..."`, keys sorted, recursive, throws AgpmError on any symlink. `makeRepo(files: Record<string, string>): Promise<string>` (test/helpers.ts) writing the given relpath -> content map into a fresh temp dir and returning its absolute path.

- [ ] **Step 1: Scaffold the project**

Write `package.json`:

```json
{
  "name": "agpm",
  "version": "0.0.0",
  "description": "The approval and audit layer for agent skills.",
  "type": "module",
  "license": "Apache-2.0",
  "engines": { "node": ">=20" },
  "bin": { "agpm": "dist/bin.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

Write `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

Write `.gitignore`:

```
node_modules/
dist/
```

Run: `npm --prefix /Users/mohammad/Desktop/agpm install -D typescript vitest @types/node`
Expected: installs cleanly, `package-lock.json` created, zero runtime deps in `dependencies`.

- [ ] **Step 2: Write the failing hash tests**

Write `test/helpers.ts`:

```ts
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
```

Write `test/hash.test.ts`:

```ts
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256, hashDir } from "../src/hash.js";
import { makeRepo } from "./helpers.js";

describe("sha256", () => {
  it("prefixes the lowercase hex digest with sha256:", () => {
    // known digest of "abc"
    expect(sha256("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("hashDir", () => {
  it("hashes every file recursively with sorted posix relpaths", async () => {
    const root = await makeRepo({
      "skill/SKILL.md": "hello",
      "skill/ref/notes.md": "world",
      "skill/a.txt": "a",
    });
    const result = await hashDir(join(root, "skill"));
    expect(Object.keys(result)).toEqual(["SKILL.md", "a.txt", "ref/notes.md"]);
    expect(result["SKILL.md"]).toBe(sha256("hello"));
    expect(result["ref/notes.md"]).toBe(sha256("world"));
  });

  it("throws AgpmError on a symlink", async () => {
    const root = await makeRepo({ "skill/SKILL.md": "hello" });
    await symlink("/etc/hosts", join(root, "skill", "link.md"));
    await expect(hashDir(join(root, "skill"))).rejects.toThrow(/symlink/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test`
Expected: FAIL, cannot resolve `../src/hash.js`.

- [ ] **Step 4: Write the implementation**

Write `src/errors.ts`:

```ts
export class AgpmError extends Error {}
```

Write `src/hash.ts`:

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git -C /Users/mohammad/Desktop/agpm add -A
git -C /Users/mohammad/Desktop/agpm commit -m "feat: scaffold agpm package and sha256 tree hashing"
```

---

### Task 2: Manifest parsing and validation

**Files:**
- Create: `src/types.ts`, `src/manifest.ts`
- Test: `test/manifest.test.ts`

**Interfaces:**
- Consumes: `AgpmError` from Task 1.
- Produces: in `src/types.ts`:

```ts
export type Kind = "skills" | "agents" | "commands";
export const KINDS: readonly Kind[] = ["skills", "agents", "commands"];

export interface Manifest {
  version: 1;
  extends?: string;                    // "github:owner/repo@ref"
  skills: Record<string, string>;      // name -> provenance
  agents: Record<string, string>;
  commands: Record<string, string>;
}
```

  and in `src/manifest.ts`: `parseManifest(text: string, filePath: string): Manifest`. Provenance values are exactly `local`, `unknown`, or `github:owner/repo[/path]` with NO `@ref` (provenance is a record, not an install instruction). The `extends` value REQUIRES `@ref`. Missing sections default to `{}`. Unknown top-level keys are an error. Names must match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`.

- [ ] **Step 1: Write the failing tests**

Write `test/manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/manifest.js";

const ok = JSON.stringify({
  version: 1,
  extends: "github:acme/policy@main",
  skills: {
    brainstorming: "github:obra/superpowers/skills/brainstorming",
    "release-checklist": "local",
    mystery: "unknown",
  },
  agents: {},
  commands: {},
});

describe("parseManifest", () => {
  it("parses a valid manifest and defaults missing sections to empty", () => {
    const m = parseManifest(JSON.stringify({ version: 1, skills: { a: "local" } }), "harness.json");
    expect(m.version).toBe(1);
    expect(m.skills).toEqual({ a: "local" });
    expect(m.agents).toEqual({});
    expect(m.commands).toEqual({});
    expect(m.extends).toBeUndefined();
  });

  it("accepts github, local, and unknown provenance and an extends ref", () => {
    const m = parseManifest(ok, "harness.json");
    expect(m.extends).toBe("github:acme/policy@main");
    expect(m.skills["mystery"]).toBe("unknown");
  });

  it("names the file path on broken JSON", () => {
    expect(() => parseManifest("{nope", "/repo/harness.json")).toThrow(/\/repo\/harness\.json/);
  });

  it("rejects a wrong version", () => {
    expect(() => parseManifest(JSON.stringify({ version: 2 }), "harness.json")).toThrow(/version/);
  });

  it("rejects provenance with an @ref (provenance is a record, not a pin)", () => {
    const bad = JSON.stringify({ version: 1, skills: { a: "github:o/r/p@v1" } });
    expect(() => parseManifest(bad, "harness.json")).toThrow(/@/);
  });

  it("rejects extends without an @ref", () => {
    const bad = JSON.stringify({ version: 1, extends: "github:acme/policy" });
    expect(() => parseManifest(bad, "harness.json")).toThrow(/extends/);
  });

  it("rejects unknown top-level keys", () => {
    const bad = JSON.stringify({ version: 1, hooks: {} });
    expect(() => parseManifest(bad, "harness.json")).toThrow(/hooks/);
  });

  it("rejects a bad entry name", () => {
    const bad = JSON.stringify({ version: 1, skills: { "../evil": "local" } });
    expect(() => parseManifest(bad, "harness.json")).toThrow(/name/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test -- manifest`
Expected: FAIL, cannot resolve `../src/manifest.js`.

- [ ] **Step 3: Write the implementation**

Write `src/types.ts` exactly as in the Interfaces block above.

Write `src/manifest.ts`:

```ts
import { AgpmError } from "./errors.js";
import { KINDS, type Kind, type Manifest } from "./types.js";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROVENANCE_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./-]+)?$/;
const EXTENDS_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[^\s@]+$/;
const TOP_KEYS = new Set(["version", "extends", ...KINDS]);

export function parseManifest(text: string, filePath: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AgpmError(`broken harness.json at ${filePath}: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgpmError(`broken harness.json at ${filePath}: top level must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!TOP_KEYS.has(key)) {
      throw new AgpmError(`${filePath}: unknown key "${key}" (allowed: version, extends, skills, agents, commands)`);
    }
  }
  if (obj["version"] !== 1) {
    throw new AgpmError(`${filePath}: version must be 1`);
  }
  let ext: string | undefined;
  if (obj["extends"] !== undefined) {
    if (typeof obj["extends"] !== "string" || !EXTENDS_RE.test(obj["extends"])) {
      throw new AgpmError(`${filePath}: extends must look like "github:owner/repo@ref"`);
    }
    ext = obj["extends"];
  }
  const sections = {} as Record<Kind, Record<string, string>>;
  for (const kind of KINDS) {
    sections[kind] = parseSection(obj[kind], kind, filePath);
  }
  return { version: 1, ...(ext === undefined ? {} : { extends: ext }), ...sections };
}

function parseSection(raw: unknown, kind: Kind, filePath: string): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgpmError(`${filePath}: "${kind}" must be an object of name to provenance`);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) {
      throw new AgpmError(`${filePath}: bad ${kind} name "${name}" (letters, digits, dot, dash, underscore)`);
    }
    if (typeof value !== "string" || !isProvenance(value)) {
      throw new AgpmError(
        `${filePath}: ${kind}/${name} provenance must be "local", "unknown", or "github:owner/repo[/path]" with no @ref`,
      );
    }
    out[name] = value;
  }
  return out;
}

function isProvenance(value: string): boolean {
  return value === "local" || value === "unknown" || PROVENANCE_RE.test(value);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test`
Expected: PASS (all tasks so far green).

- [ ] **Step 5: Commit**

```bash
git -C /Users/mohammad/Desktop/agpm add -A
git -C /Users/mohammad/Desktop/agpm commit -m "feat: harness.json parsing and validation"
```

---

### Task 3: Lock parsing and deterministic serialization

**Files:**
- Create: `src/lock.ts`
- Modify: `src/types.ts` (append the Lock types)
- Test: `test/lock.test.ts`

**Interfaces:**
- Consumes: `AgpmError`; `KINDS`, `Kind` from `src/types.ts`; provenance rules from Task 2 (re-implemented locally via import of nothing new: `src/lock.ts` imports `isProvenance` is NOT exported; instead lock validates `source` with the same regex duplicated as a shared export: ADD `export function isProvenance(value: string): boolean` to `src/manifest.ts` and use it from lock).
- Produces: appended to `src/types.ts`:

```ts
export interface LockEntry {
  source: string;                      // provenance string
  dirs: string[];                      // repo-relative dirs, sorted
  files: Record<string, string>;       // relpath -> "sha256:<64 hex>", sorted
}

export interface Lock {
  version: 1;
  extendsCommit?: string;              // 40 lowercase hex
  skills: Record<string, LockEntry>;
  agents: Record<string, LockEntry>;
  commands: Record<string, LockEntry>;
}
```

  and in `src/lock.ts`: `parseLock(text: string, filePath: string): Lock`, `emptyLock(): Lock`, `serializeLock(lock: Lock): string` (JSON, 2-space indent, keys sorted at every level, `dirs` arrays sorted, trailing newline, no timestamps anywhere).

- [ ] **Step 1: Write the failing tests**

Write `test/lock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { emptyLock, parseLock, serializeLock } from "../src/lock.js";

const HEX = "a".repeat(64);
const entry = {
  source: "github:obra/superpowers/skills/brainstorming",
  dirs: [".claude/skills", ".agents/skills"],
  files: { "SKILL.md": `sha256:${HEX}` },
};

describe("parseLock", () => {
  it("parses a valid lock", () => {
    const text = JSON.stringify({ version: 1, extendsCommit: "b".repeat(40), skills: { brainstorming: entry } });
    const lock = parseLock(text, "harness.lock");
    expect(lock.skills["brainstorming"]?.files["SKILL.md"]).toBe(`sha256:${HEX}`);
    expect(lock.agents).toEqual({});
  });

  it("names the file path on broken JSON", () => {
    expect(() => parseLock("[", "/repo/harness.lock")).toThrow(/\/repo\/harness\.lock/);
  });

  it("rejects a malformed hash", () => {
    const text = JSON.stringify({ version: 1, skills: { a: { ...entry, files: { "SKILL.md": "sha256:short" } } } });
    expect(() => parseLock(text, "harness.lock")).toThrow(/sha256/);
  });

  it("rejects a malformed extendsCommit", () => {
    const text = JSON.stringify({ version: 1, extendsCommit: "xyz" });
    expect(() => parseLock(text, "harness.lock")).toThrow(/extendsCommit/);
  });
});

describe("serializeLock", () => {
  it("is deterministic: sorted keys, sorted dirs, trailing newline", () => {
    const lock = emptyLock();
    lock.skills["zeta"] = { ...entry, dirs: [".claude/skills", ".agents/skills"] };
    lock.skills["alpha"] = { ...entry, dirs: [".claude/skills"] };
    const text = serializeLock(lock);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zeta"'));
    const parsed = JSON.parse(text) as { skills: Record<string, { dirs: string[] }> };
    expect(parsed.skills["zeta"]?.dirs).toEqual([".agents/skills", ".claude/skills"]);
    // round trip is byte-stable
    expect(serializeLock(parseLock(text, "x"))).toBe(text);
  });

  it("never contains a timestamp", () => {
    const text = serializeLock(emptyLock());
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test -- lock`
Expected: FAIL, cannot resolve `../src/lock.js`.

- [ ] **Step 3: Write the implementation**

Append the `LockEntry` and `Lock` interfaces from the Interfaces block to `src/types.ts`. Add to `src/manifest.ts` an `export` keyword on `isProvenance` (move it above `parseManifest` and export it).

Write `src/lock.ts`:

```ts
import { AgpmError } from "./errors.js";
import { isProvenance } from "./manifest.js";
import { KINDS, type Kind, type Lock, type LockEntry } from "./types.js";

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export function emptyLock(): Lock {
  return { version: 1, skills: {}, agents: {}, commands: {} };
}

export function parseLock(text: string, filePath: string): Lock {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AgpmError(`broken harness.lock at ${filePath}: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgpmError(`broken harness.lock at ${filePath}: top level must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== 1) throw new AgpmError(`${filePath}: version must be 1`);
  const lock = emptyLock();
  if (obj["extendsCommit"] !== undefined) {
    if (typeof obj["extendsCommit"] !== "string" || !COMMIT_RE.test(obj["extendsCommit"])) {
      throw new AgpmError(`${filePath}: extendsCommit must be a 40 hex commit`);
    }
    lock.extendsCommit = obj["extendsCommit"];
  }
  for (const kind of KINDS) {
    const section = obj[kind];
    if (section === undefined) continue;
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
      throw new AgpmError(`${filePath}: "${kind}" must be an object`);
    }
    for (const [name, value] of Object.entries(section)) {
      lock[kind][name] = parseEntry(value, `${filePath}: ${kind}/${name}`);
    }
  }
  return lock;
}

function parseEntry(raw: unknown, where: string): LockEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgpmError(`${where}: entry must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const { source, dirs, files } = obj;
  if (typeof source !== "string" || !isProvenance(source)) {
    throw new AgpmError(`${where}: source must be a provenance string`);
  }
  if (!Array.isArray(dirs) || dirs.length === 0 || !dirs.every((d) => typeof d === "string")) {
    throw new AgpmError(`${where}: dirs must be a non-empty string array`);
  }
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new AgpmError(`${where}: files must be an object`);
  }
  const outFiles: Record<string, string> = {};
  for (const [rel, hash] of Object.entries(files)) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) {
      throw new AgpmError(`${where}: files["${rel}"] must be "sha256:<64 hex>"`);
    }
    outFiles[rel] = hash;
  }
  return { source, dirs: [...(dirs as string[])].sort(), files: outFiles };
}

export function serializeLock(lock: Lock): string {
  return JSON.stringify(sortDeep(lock), null, 2) + "\n";
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return [...value].sort();
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortDeep(v)]),
    );
  }
  return value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/mohammad/Desktop/agpm add -A
git -C /Users/mohammad/Desktop/agpm commit -m "feat: harness.lock parsing and deterministic serialization"
```

---

### Task 4: Directory scanner

**Files:**
- Create: `src/scan.ts`
- Modify: `src/types.ts` (append scan types)
- Test: `test/scan.test.ts`

**Interfaces:**
- Consumes: `hashDir` from Task 1.
- Produces: appended to `src/types.ts`:

```ts
export interface ScannedLocation {
  dir: string;                         // repo-relative, e.g. ".claude/skills"
  files: Record<string, string>;       // relpath inside the unit -> "sha256:..."
}

export interface ScannedUnit {
  kind: Kind;
  name: string;
  locations: ScannedLocation[];        // 1 or 2 (skills can live in both dirs)
}

export interface ScanResult {
  units: ScannedUnit[];                // sorted by kind then name
}
```

  and in `src/scan.ts`: `scanRepo(root: string): Promise<ScanResult>`. Skills: each SUBDIRECTORY of `.claude/skills/` and `.agents/skills/`; the same name in both dirs merges into ONE unit with two locations. Agents: each `*.md` FILE directly in `.claude/agents/`, unit name is the basename without `.md`, files map is `{ "<base>.md": hash }`. Commands: same rule for `.claude/commands/`. Missing directories yield no units. Non-directory entries inside the skills dirs and non-md files in agents/commands are ignored.

- [ ] **Step 1: Write the failing tests**

Write `test/scan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/hash.js";
import { scanRepo } from "../src/scan.js";
import { makeRepo } from "./helpers.js";

describe("scanRepo", () => {
  it("returns no units for an empty repo", async () => {
    const root = await makeRepo({ "README.md": "hi" });
    expect((await scanRepo(root)).units).toEqual([]);
  });

  it("finds skills in both dirs and merges same-name into one unit", async () => {
    const root = await makeRepo({
      ".claude/skills/brainstorming/SKILL.md": "b",
      ".agents/skills/brainstorming/SKILL.md": "b",
      ".agents/skills/solo/SKILL.md": "s",
    });
    const { units } = await scanRepo(root);
    expect(units.map((u) => [u.kind, u.name])).toEqual([
      ["skills", "brainstorming"],
      ["skills", "solo"],
    ]);
    const both = units[0]!;
    expect(both.locations.map((l) => l.dir).sort()).toEqual([".agents/skills", ".claude/skills"]);
    expect(both.locations[0]!.files["SKILL.md"]).toBe(sha256("b"));
  });

  it("finds agents and commands as single md files", async () => {
    const root = await makeRepo({
      ".claude/agents/planner.md": "p",
      ".claude/commands/tdd-task.md": "t",
      ".claude/agents/notes.txt": "ignored",
    });
    const { units } = await scanRepo(root);
    expect(units.map((u) => [u.kind, u.name])).toEqual([
      ["agents", "planner"],
      ["commands", "tdd-task"],
    ]);
    expect(units[0]!.locations).toEqual([
      { dir: ".claude/agents", files: { "planner.md": sha256("p") } },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test -- scan`
Expected: FAIL, cannot resolve `../src/scan.js`.

- [ ] **Step 3: Write the implementation**

Append the scan interfaces to `src/types.ts`. Write `src/scan.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { hashDir, sha256 } from "./hash.js";
import type { Kind, ScanResult, ScannedUnit } from "./types.js";

const SKILL_DIRS = [".agents/skills", ".claude/skills"];
const FILE_DIRS: [Kind, string][] = [
  ["agents", ".claude/agents"],
  ["commands", ".claude/commands"],
];

export async function scanRepo(root: string): Promise<ScanResult> {
  const skills = new Map<string, ScannedUnit>();
  for (const dir of SKILL_DIRS) {
    for (const entry of await listDir(join(root, dir))) {
      if (!entry.isDirectory()) continue;
      const files = await hashDir(join(root, dir, entry.name));
      const unit = skills.get(entry.name) ?? { kind: "skills" as Kind, name: entry.name, locations: [] };
      skills.set(entry.name, { ...unit, locations: [...unit.locations, { dir, files }] });
    }
  }
  const units: ScannedUnit[] = [...skills.values()];
  for (const [kind, dir] of FILE_DIRS) {
    for (const entry of await listDir(join(root, dir))) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const content = await readFile(join(root, dir, entry.name));
      units.push({
        kind,
        name: entry.name.slice(0, -3),
        locations: [{ dir, files: { [entry.name]: sha256(content) } }],
      });
    }
  }
  const order: Record<Kind, number> = { skills: 0, agents: 1, commands: 2 };
  units.sort((a, b) => order[a.kind] - order[b.kind] || (a.name < b.name ? -1 : 1));
  return { units };
}

async function listDir(abs: string) {
  try {
    return await readdir(abs, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/mohammad/Desktop/agpm add -A
git -C /Users/mohammad/Desktop/agpm commit -m "feat: repo scanner for skills, agents, and commands"
```

---

### Task 5: check

**Files:**
- Create: `src/check.ts`
- Modify: `src/types.ts` (append check types)
- Test: `test/check.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `Lock`, `ScanResult`, `KINDS` from `src/types.ts`.
- Produces: appended to `src/types.ts`:

```ts
export type FindingCode = "missing" | "drifted" | "split" | "unsynced" | "unlisted";

export interface Finding {
  level: "fail" | "warn";
  kind: Kind;
  name: string;
  code: FindingCode;
  message: string;
}

export interface CheckResult {
  findings: Finding[];                 // sorted by kind then name
  exitCode: 0 | 1;
}
```

  and in `src/check.ts`: `runCheck(manifest: Manifest, lock: Lock, scan: ScanResult): CheckResult`, a pure function, no IO. Rules (spec section "check rules"):
  - Listed in harness.json but no lock entry, or lock entry with no harness.json entry: FAIL `unsynced` (message says the two files disagree, run agpm sync).
  - In the lock but no folder or file on disk: FAIL `missing`.
  - Skill present in both skills dirs with different bytes: FAIL `split`.
  - On-disk dirs or file hashes differ from the lock entry: FAIL `drifted`.
  - On disk but in neither harness.json nor the lock: WARN `unlisted` (`--strict` upgrade is M3).
  - `manifest.extends` is ignored in M1 (resolution is M3).
  - exitCode 1 if any `fail`, else 0.

- [ ] **Step 1: Write the failing tests**

Write `test/check.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runCheck } from "../src/check.js";
import { emptyLock } from "../src/lock.js";
import { sha256 } from "../src/hash.js";
import type { Manifest, ScanResult } from "../src/types.js";

const manifest = (skills: Record<string, string>): Manifest => ({
  version: 1, skills, agents: {}, commands: {},
});

const scanWith = (name: string, content: string, dirs = [".claude/skills"]): ScanResult => ({
  units: [{ kind: "skills", name, locations: dirs.map((dir) => ({ dir, files: { "SKILL.md": sha256(content) } })) }],
});

function lockWith(name: string, content: string, dirs = [".claude/skills"]) {
  const lock = emptyLock();
  lock.skills[name] = { source: "local", dirs: [...dirs].sort(), files: { "SKILL.md": sha256(content) } };
  return lock;
}

describe("runCheck", () => {
  it("is clean when disk matches lock and manifest", () => {
    const r = runCheck(manifest({ a: "local" }), lockWith("a", "x"), scanWith("a", "x"));
    expect(r.findings).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it("fails unsynced when manifest and lock disagree", () => {
    const r = runCheck(manifest({ a: "local" }), emptyLock(), scanWith("a", "x"));
    expect(r.findings).toEqual([
      expect.objectContaining({ level: "fail", code: "unsynced", name: "a" }),
    ]);
    expect(r.exitCode).toBe(1);
  });

  it("fails missing when a locked entry has no folder", () => {
    const r = runCheck(manifest({ a: "local" }), lockWith("a", "x"), { units: [] });
    expect(r.findings[0]).toMatchObject({ level: "fail", code: "missing" });
  });

  it("fails drifted when bytes differ from the lock", () => {
    const r = runCheck(manifest({ a: "local" }), lockWith("a", "x"), scanWith("a", "CHANGED"));
    expect(r.findings[0]).toMatchObject({ level: "fail", code: "drifted" });
  });

  it("fails drifted when the dirs changed", () => {
    const both = [".agents/skills", ".claude/skills"];
    const r = runCheck(manifest({ a: "local" }), lockWith("a", "x", both), scanWith("a", "x"));
    expect(r.findings[0]).toMatchObject({ level: "fail", code: "drifted" });
  });

  it("fails split when the two skills dirs disagree with each other", () => {
    const scan: ScanResult = {
      units: [{
        kind: "skills", name: "a",
        locations: [
          { dir: ".agents/skills", files: { "SKILL.md": sha256("one") } },
          { dir: ".claude/skills", files: { "SKILL.md": sha256("two") } },
        ],
      }],
    };
    const both = [".agents/skills", ".claude/skills"];
    const r = runCheck(manifest({ a: "local" }), lockWith("a", "one", both), scan);
    expect(r.findings[0]).toMatchObject({ level: "fail", code: "split" });
  });

  it("warns unlisted for a folder in neither file, exit 0", () => {
    const r = runCheck(manifest({}), emptyLock(), scanWith("stray", "x"));
    expect(r.findings).toEqual([
      expect.objectContaining({ level: "warn", code: "unlisted", name: "stray" }),
    ]);
    expect(r.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test -- check`
Expected: FAIL, cannot resolve `../src/check.js`.

- [ ] **Step 3: Write the implementation**

Append the check interfaces to `src/types.ts`. Write `src/check.ts`:

```ts
import { KINDS, type CheckResult, type Finding, type Kind, type Lock, type Manifest, type ScanResult, type ScannedUnit } from "./types.js";

export function runCheck(manifest: Manifest, lock: Lock, scan: ScanResult): CheckResult {
  const findings: Finding[] = [];
  for (const kind of KINDS) {
    const units = new Map(scan.units.filter((u) => u.kind === kind).map((u) => [u.name, u]));
    const names = new Set([...Object.keys(manifest[kind]), ...Object.keys(lock[kind]), ...units.keys()]);
    for (const name of [...names].sort()) {
      const inManifest = name in manifest[kind];
      const entry = lock[kind][name];
      const unit = units.get(name);
      if (inManifest !== (entry !== undefined)) {
        findings.push(fail(kind, name, "unsynced",
          `harness.json and harness.lock disagree about ${kind}/${name}; run agpm sync and approve the diff by PR`));
        continue;
      }
      if (entry !== undefined) {
        if (unit === undefined) {
          findings.push(fail(kind, name, "missing", `${kind}/${name} is approved but not on disk`));
          continue;
        }
        const splitFinding = checkSplit(kind, name, unit);
        if (splitFinding !== undefined) {
          findings.push(splitFinding);
          continue;
        }
        const dirs = unit.locations.map((l) => l.dir).sort();
        if (!sameArray(dirs, entry.dirs)) {
          findings.push(fail(kind, name, "drifted",
            `${kind}/${name} moved: lock says [${entry.dirs.join(", ")}], disk has [${dirs.join(", ")}]`));
          continue;
        }
        if (!sameRecord(unit.locations[0]!.files, entry.files)) {
          findings.push(fail(kind, name, "drifted", `${kind}/${name} bytes differ from the approved hashes`));
        }
        continue;
      }
      if (unit !== undefined) {
        findings.push({ level: "warn", kind, name, code: "unlisted",
          message: `${kind}/${name} exists on disk but nobody approved it in harness.json` });
      }
    }
  }
  return { findings, exitCode: findings.some((f) => f.level === "fail") ? 1 : 0 };
}

function checkSplit(kind: Kind, name: string, unit: ScannedUnit): Finding | undefined {
  const first = unit.locations[0]!;
  for (const location of unit.locations.slice(1)) {
    if (!sameRecord(first.files, location.files)) {
      return fail(kind, name, "split",
        `${kind}/${name} has different bytes in ${first.dir} and ${location.dir}`);
    }
  }
  return undefined;
}

function fail(kind: Kind, name: string, code: Finding["code"], message: string): Finding {
  return { level: "fail", kind, name, code, message };
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/mohammad/Desktop/agpm add -A
git -C /Users/mohammad/Desktop/agpm commit -m "feat: check, the CI gate over manifest, lock, and disk"
```

---

### Task 6: list

**Files:**
- Create: `src/list.ts`
- Test: `test/list.test.ts`

**Interfaces:**
- Consumes: `runCheck` from Task 5; `Manifest`, `Lock`, `ScanResult`, `KINDS`.
- Produces: `formatList(manifest: Manifest, lock: Lock, scan: ScanResult): string[]`. One line per known name (union of manifest, lock, disk), sorted by kind then name. Status per spec is exactly one of `ok`, `drifted`, `missing`, `unlisted`; the internal codes `split` and `unsynced` display as `drifted` (bytes are not in a verified state). Line format: `` `${kind.padEnd(9)} ${name.padEnd(30)} ${status.padEnd(9)} ${source}` `` where source is the manifest provenance, else the lock source, else `unknown`.

- [ ] **Step 1: Write the failing tests**

Write `test/list.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { emptyLock } from "../src/lock.js";
import { formatList } from "../src/list.js";
import { sha256 } from "../src/hash.js";
import type { Manifest, ScanResult } from "../src/types.js";

const manifest: Manifest = { version: 1, skills: { a: "local" }, agents: {}, commands: {} };

describe("formatList", () => {
  it("shows ok, unlisted, and missing statuses with sources", () => {
    const lock = emptyLock();
    lock.skills["a"] = { source: "local", dirs: [".claude/skills"], files: { "SKILL.md": sha256("x") } };
    const scan: ScanResult = {
      units: [
        { kind: "skills", name: "a", locations: [{ dir: ".claude/skills", files: { "SKILL.md": sha256("x") } }] },
        { kind: "skills", name: "stray", locations: [{ dir: ".claude/skills", files: { "SKILL.md": sha256("y") } }] },
      ],
    };
    const lines = formatList(manifest, lock, scan);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^skills\s+a\s+ok\s+local$/);
    expect(lines[1]).toMatch(/^skills\s+stray\s+unlisted\s+unknown$/);
  });

  it("maps unsynced to drifted (spec fixes the four display states)", () => {
    const lines = formatList(manifest, emptyLock(), { units: [] });
    expect(lines[0]).toMatch(/^skills\s+a\s+drifted\s+local$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test -- list`
Expected: FAIL, cannot resolve `../src/list.js`.

- [ ] **Step 3: Write the implementation**

Write `src/list.ts`:

```ts
import { runCheck } from "./check.js";
import { KINDS, type FindingCode, type Lock, type Manifest, type ScanResult } from "./types.js";

const DISPLAY: Record<FindingCode, string> = {
  missing: "missing",
  drifted: "drifted",
  split: "drifted",
  unsynced: "drifted",
  unlisted: "unlisted",
};

export function formatList(manifest: Manifest, lock: Lock, scan: ScanResult): string[] {
  const { findings } = runCheck(manifest, lock, scan);
  const lines: string[] = [];
  for (const kind of KINDS) {
    const units = scan.units.filter((u) => u.kind === kind).map((u) => u.name);
    const names = new Set([...Object.keys(manifest[kind]), ...Object.keys(lock[kind]), ...units]);
    for (const name of [...names].sort()) {
      const finding = findings.find((f) => f.kind === kind && f.name === name);
      const status = finding === undefined ? "ok" : DISPLAY[finding.code];
      const source = manifest[kind][name] ?? lock[kind][name]?.source ?? "unknown";
      lines.push(`${kind.padEnd(9)} ${name.padEnd(30)} ${status.padEnd(9)} ${source}`);
    }
  }
  return lines;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/mohammad/Desktop/agpm add -A
git -C /Users/mohammad/Desktop/agpm commit -m "feat: list, one status line per entry"
```

---

### Task 7: CLI, bin entry, and build

**Files:**
- Create: `src/cli.ts`, `src/bin.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 6.
- Produces: `runCli(argv: string[], cwd: string, write: (line: string) => void): Promise<number>` in `src/cli.ts`. Behavior:
  - `agpm check`: load `<cwd>/harness.json` (ENOENT: write `no harness.json found in <cwd>` and return 2), load `<cwd>/harness.lock` (ENOENT: treat as `emptyLock()`), `scanRepo(cwd)`, print each finding as `FAIL <kind>/<name>: <message>` or `WARN <kind>/<name>: <message>`, then `check: <n> fail, <m> warn`, return the check exit code.
  - `agpm list`: same loading, print `formatList` lines, return 0.
  - Anything else: print `usage: agpm <check|list>` and return 2.
  - Any `AgpmError` thrown anywhere: print its message, return 2.
  - `src/bin.ts` is the npm bin: shebang line, calls `runCli(process.argv.slice(2), process.cwd(), line => process.stdout.write(line + "\n"))`, passes the return value to `process.exit`.

- [ ] **Step 1: Write the failing tests**

Write `test/cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { makeRepo } from "./helpers.js";

async function run(argv: string[], cwd: string) {
  const lines: string[] = [];
  const code = await runCli(argv, cwd, (line) => lines.push(line));
  return { code, lines };
}

const cleanRepo = () =>
  makeRepo({
    ".claude/skills/a/SKILL.md": "x",
    "harness.json": JSON.stringify({ version: 1, skills: { a: "local" } }),
    // sha256("x") = 2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881
    "harness.lock": JSON.stringify({
      version: 1,
      skills: {
        a: {
          source: "local",
          dirs: [".claude/skills"],
          files: { "SKILL.md": "sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" },
        },
      },
    }),
  });

describe("runCli", () => {
  it("check on a clean repo prints the summary and exits 0", async () => {
    const { code, lines } = await run(["check"], await cleanRepo());
    expect(code).toBe(0);
    expect(lines).toEqual(["check: 0 fail, 0 warn"]);
  });

  it("check exits 1 and prints FAIL lines on drift", async () => {
    const root = await makeRepo({
      ".claude/skills/a/SKILL.md": "TAMPERED",
      "harness.json": JSON.stringify({ version: 1, skills: { a: "local" } }),
      "harness.lock": JSON.stringify({
        version: 1,
        skills: {
          a: {
            source: "local",
            dirs: [".claude/skills"],
            files: { "SKILL.md": "sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" },
          },
        },
      }),
    });
    const { code, lines } = await run(["check"], root);
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^FAIL skills\/a: /);
    expect(lines.at(-1)).toBe("check: 1 fail, 0 warn");
  });

  it("check without harness.json exits 2 with a clear message", async () => {
    const root = await makeRepo({ "README.md": "hi" });
    const { code, lines } = await run(["check"], root);
    expect(code).toBe(2);
    expect(lines[0]).toContain("no harness.json found in");
  });

  it("check with broken harness.json exits 2 and names the file", async () => {
    const root = await makeRepo({ "harness.json": "{nope" });
    const { code, lines } = await run(["check"], root);
    expect(code).toBe(2);
    expect(lines[0]).toContain("harness.json");
  });

  it("check with a missing lock reports unsynced entries, exit 1", async () => {
    const root = await makeRepo({
      ".claude/skills/a/SKILL.md": "x",
      "harness.json": JSON.stringify({ version: 1, skills: { a: "local" } }),
    });
    const { code, lines } = await run(["check"], root);
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^FAIL skills\/a: .*sync/);
  });

  it("list prints one line per entry and exits 0", async () => {
    const { code, lines } = await run(["list"], await cleanRepo());
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^skills\s+a\s+ok\s+local$/);
  });

  it("unknown command prints usage and exits 2", async () => {
    const { code, lines } = await run(["frobnicate"], await makeRepo({}));
    expect(code).toBe(2);
    expect(lines[0]).toBe("usage: agpm <check|list>");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test -- cli`
Expected: FAIL, cannot resolve `../src/cli.js`.

- [ ] **Step 3: Write the implementation**

Write `src/cli.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCheck } from "./check.js";
import { AgpmError } from "./errors.js";
import { formatList } from "./list.js";
import { emptyLock, parseLock } from "./lock.js";
import { parseManifest } from "./manifest.js";
import { scanRepo } from "./scan.js";
import type { Lock, Manifest } from "./types.js";

type Writer = (line: string) => void;

export async function runCli(argv: string[], cwd: string, write: Writer): Promise<number> {
  try {
    switch (argv[0]) {
      case "check":
        return await check(cwd, write);
      case "list":
        return await list(cwd, write);
      default:
        write("usage: agpm <check|list>");
        return 2;
    }
  } catch (error) {
    if (error instanceof AgpmError) {
      write(error.message);
      return 2;
    }
    throw error;
  }
}

async function loadFiles(cwd: string): Promise<{ manifest: Manifest; lock: Lock }> {
  const manifestPath = join(cwd, "harness.json");
  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgpmError(`no harness.json found in ${cwd}`);
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

async function check(cwd: string, write: Writer): Promise<number> {
  const { manifest, lock } = await loadFiles(cwd);
  const result = runCheck(manifest, lock, await scanRepo(cwd));
  for (const finding of result.findings) {
    write(`${finding.level === "fail" ? "FAIL" : "WARN"} ${finding.kind}/${finding.name}: ${finding.message}`);
  }
  const fails = result.findings.filter((f) => f.level === "fail").length;
  const warns = result.findings.length - fails;
  write(`check: ${fails} fail, ${warns} warn`);
  return result.exitCode;
}

async function list(cwd: string, write: Writer): Promise<number> {
  const { manifest, lock } = await loadFiles(cwd);
  for (const line of formatList(manifest, lock, await scanRepo(cwd))) write(line);
  return 0;
}
```

Write `src/bin.ts`:

```ts
#!/usr/bin/env node
import { runCli } from "./cli.js";

const code = await runCli(process.argv.slice(2), process.cwd(), (line) => {
  process.stdout.write(line + "\n");
});
process.exit(code);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test`
Expected: PASS, full suite green.

- [ ] **Step 5: Verify the build and the real binary**

Run: `npm --prefix /Users/mohammad/Desktop/agpm run build`
Expected: `dist/` appears, no errors.

Run: `node /Users/mohammad/Desktop/agpm/dist/bin.js frobnicate; echo "exit=$?"`
Expected: prints `usage: agpm <check|list>` then `exit=2`.

- [ ] **Step 6: Commit**

```bash
git -C /Users/mohammad/Desktop/agpm add -A
git -C /Users/mohammad/Desktop/agpm commit -m "feat: agpm CLI with check and list, npm bin entry"
```

---

### Task 8: End-to-end verification and dogfood fixture

**Files:**
- Test: `test/e2e.test.ts`

**Interfaces:**
- Consumes: the built `dist/bin.js` behavior from Task 7 via `runCli` (direct import, no child process).
- Produces: nothing new. This task proves the full loop on a realistic repo shape: install-by-hand, hand-approve, check green, tamper, check red.

- [ ] **Step 1: Write the failing end-to-end test**

Write `test/e2e.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { hashDir } from "../src/hash.js";
import { serializeLock, emptyLock } from "../src/lock.js";
import { makeRepo } from "./helpers.js";

describe("end to end", () => {
  it("approve by hand, check green, tamper, check red, stray folder warns", async () => {
    const root = await makeRepo({
      ".claude/skills/brainstorming/SKILL.md": "# Brainstorming\nrules\n",
      ".agents/skills/brainstorming/SKILL.md": "# Brainstorming\nrules\n",
      ".claude/agents/planner.md": "# Planner\n",
      "harness.json": JSON.stringify({
        version: 1,
        skills: { brainstorming: "github:obra/superpowers/skills/brainstorming" },
        agents: { planner: "local" },
      }),
    });
    // build the lock the way M2's sync will: hash what is on disk
    const lock = emptyLock();
    lock.skills["brainstorming"] = {
      source: "github:obra/superpowers/skills/brainstorming",
      dirs: [".agents/skills", ".claude/skills"],
      files: await hashDir(join(root, ".claude/skills/brainstorming")),
    };
    lock.agents["planner"] = {
      source: "local",
      dirs: [".claude/agents"],
      files: await hashDir(join(root, ".claude/agents")).then((all) => ({ "planner.md": all["planner.md"]! })),
    };
    await writeFile(join(root, "harness.lock"), serializeLock(lock));

    const lines: string[] = [];
    expect(await runCli(["check"], root, (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toBe("check: 0 fail, 0 warn");

    // tamper with one copy: both split (dirs disagree) and drift must surface as FAIL
    await writeFile(join(root, ".claude/skills/brainstorming/SKILL.md"), "# Brainstorming\nEVIL\n");
    const lines2: string[] = [];
    expect(await runCli(["check"], root, (l) => lines2.push(l))).toBe(1);
    expect(lines2.some((l) => l.startsWith("FAIL skills/brainstorming:"))).toBe(true);

    // a stray unapproved folder only warns
    await writeFile(join(root, ".claude/skills/brainstorming/SKILL.md"), "# Brainstorming\nrules\n");
    const strayRoot = join(root, ".claude/skills");
    await makeStray(strayRoot);
    const lines3: string[] = [];
    expect(await runCli(["check"], root, (l) => lines3.push(l))).toBe(0);
    expect(lines3.some((l) => l.startsWith("WARN skills/stray:"))).toBe(true);
  });
});

async function makeStray(skillsDir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(skillsDir, "stray"), { recursive: true });
  await writeFile(join(skillsDir, "stray", "SKILL.md"), "unapproved\n");
}
```

- [ ] **Step 2: Run the test, fix anything it exposes**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test -- e2e`
Expected: PASS if Tasks 1 to 7 are correct. If it fails, the failure is a real integration bug: fix the module at fault (not the test), re-run until green.

- [ ] **Step 3: Full gate**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test && npm --prefix /Users/mohammad/Desktop/agpm run typecheck && npm --prefix /Users/mohammad/Desktop/agpm run build`
Expected: all three green.

- [ ] **Step 4: Commit**

```bash
git -C /Users/mohammad/Desktop/agpm add -A
git -C /Users/mohammad/Desktop/agpm commit -m "test: end-to-end approve, verify, tamper, warn loop"
```

---

## Self-review notes

- Spec coverage for M1: formats with all three sections + extends + provenance (Tasks 2, 3), scanner over the four observed directories (Task 4), hashing (Task 1), check with all five spec rules incl. split and exit codes (Task 5), list with the four display states (Task 6), CLI error handling with file paths and exit 2 (Task 7). Not in M1 by spec: init, sync, audit, provenance detection from other lockfiles (M2); extends resolution, --strict, --json, (M3). `serializeLock` ships in M1 because the e2e test and M2's sync both need the deterministic format.
- The `sha256("x")` literal in Task 7's fixtures is the real digest of `"x"`; the e2e test avoids literals by computing hashes with `hashDir`.
- Type names are consistent across tasks: `Manifest`, `Lock`, `LockEntry`, `ScanResult`, `ScannedUnit`, `ScannedLocation`, `Finding`, `FindingCode`, `CheckResult`, `Kind`, `KINDS`.
