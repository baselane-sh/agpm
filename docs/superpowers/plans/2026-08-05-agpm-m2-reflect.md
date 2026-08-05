# agpm M2 Reflect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `agpm init`, `agpm sync`, and `agpm audit`, with best-effort provenance detection from other tools' lockfiles, so a repo goes from nothing to a green `agpm check` with two commands.

**Architecture:** One pure core, `computeSync(manifest, lock, scan, sources)`, produces the new manifest, new lock, and a change list. `init` runs it from empty state; `sync` runs it from the loaded files. `audit` is a read-only formatter over `runCheck` plus provenance notes. The CLI wraps the pure cores with file IO exactly as M1 did. This plan also closes two M1 carry-items first: path-key validation in the lock parser (security) and the README honesty note (last task).

**Tech Stack:** TypeScript strict NodeNext compiled by tsc, Node >= 18, ESM with `.js`-extension relative imports, vitest, zero runtime dependencies.

## Global Constraints

- Zero runtime dependencies. Dev dependencies are exactly: typescript, vitest, @types/node. Never add another.
- Every relative import in src/ and test/ ends in `.js`.
- Null-prototype invariant: every object map keyed by parsed or scanned names or file paths is created with `Object.create(null)`, and membership tests use `Object.hasOwn`, never `in` or a bare bracket read. This holds even for maps that only feed `JSON.stringify`.
- agpm writes exactly two files into a user repo: `harness.json` and `harness.lock`. Never anything else.
- Deterministic serialization: sorted keys, 2-space indent, one trailing newline, no timestamps. `serializeManifest` key order is: version, extends (only if present), skills, agents, commands; names sorted inside each section.
- Symlinks are refused with an `AgpmError`, never skipped (spec, Decided questions).
- No console.log in src/. All CLI output goes through the injected `write` function. Only bin.ts touches process.stdout/stderr.
- Exit codes: 0 clean, 1 check violations, 2 internal or usage error. init, sync, audit, and list return 0 on success. audit returns 0 even when it shows drift; `check` is the gate.
- Immutability: `computeSync` never mutates its inputs; it returns new objects.
- `extends` and `extendsCommit` are parsed and preserved byte-for-byte, never resolved. Resolution is M3.
- Honesty rules (spec): provenance is recorded only when a lockfile explains it, otherwise `local`. Nothing is guessed. Unreadable other-tool lockfiles produce a note, never a crash.
- TDD for every task: write the failing test, watch it fail for the right reason, implement, watch it pass, run the full suite.
- No em-dashes in any authored text (code, comments, docs, output strings).

Existing interfaces this plan builds on (src/types.ts, unchanged): `Kind`, `KINDS`, `Manifest`, `Lock`, `LockEntry`, `ScanResult`, `ScannedUnit`, `Finding`, `CheckResult`. Existing functions: `parseManifest(text, filePath)`, `parseLock(text, filePath)`, `emptyLock()`, `serializeLock(lock)`, `scanRepo(root)`, `hashDir(absDir)`, `sha256(data)`, `runCheck(manifest, lock, scan)`, `formatList(...)`, `runCli(argv, cwd, write)`, `AgpmError`. Test helper: `makeRepo(files)` in test/helpers.ts creates a mkdtemp repo from a path-to-content record.

Work happens on branch `feat/m2-reflect` off main.

---

### Task 1: Lock path-key validation (M1 security carry-item)

**Files:**
- Modify: `src/lock.ts` (parseEntry)
- Test: `test/lock.test.ts`

**Interfaces:**
- Consumes: existing `parseLock` / `parseEntry` internals.
- Produces: no new exports. `parseLock` now rejects `dirs` values and `files` keys that could escape the repo. Later tasks rely on every parsed lock path being repo-relative and clean.

- [ ] **Step 1: Write the failing tests**

Append to `test/lock.test.ts` (it already imports `parseLock` and has a valid-hash constant pattern; reuse the file's existing style):

```ts
describe("parseLock path-key validation", () => {
  const H = "sha256:" + "0".repeat(64);
  const withDirs = (dirs: string[]) =>
    JSON.stringify({ version: 1, skills: { a: { source: "local", dirs, files: { "SKILL.md": H } } } });
  const withFileKey = (rel: string) =>
    JSON.stringify({ version: 1, skills: { a: { source: "local", dirs: [".claude/skills"], files: { [rel]: H } } } });

  it("rejects dirs that escape the repo or use backslashes", () => {
    expect(() => parseLock(withDirs(["../outside"]), "L")).toThrow(/dirs/);
    expect(() => parseLock(withDirs(["/absolute"]), "L")).toThrow(/dirs/);
    expect(() => parseLock(withDirs(["a\\b"]), "L")).toThrow(/dirs/);
    expect(() => parseLock(withDirs(["./x"]), "L")).toThrow(/dirs/);
    expect(() => parseLock(withDirs([""]), "L")).toThrow(/dirs/);
  });

  it("rejects file keys that escape the unit directory", () => {
    expect(() => parseLock(withFileKey("../x.md"), "L")).toThrow(/files/);
    expect(() => parseLock(withFileKey("/abs.md"), "L")).toThrow(/files/);
    expect(() => parseLock(withFileKey("a\\b.md"), "L")).toThrow(/files/);
    expect(() => parseLock(withFileKey("a//b.md"), "L")).toThrow(/files/);
  });

  it("still accepts clean nested relative paths", () => {
    expect(() => parseLock(withFileKey("references/deep/file.md"), "L")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test`
Expected: the two rejection tests FAIL because parseLock currently accepts these paths (no throw).

- [ ] **Step 3: Implement**

In `src/lock.ts`, add a helper and call it from `parseEntry`:

```ts
function badPath(p: string): boolean {
  return (
    p === "" ||
    p.startsWith("/") ||
    p.includes("\\") ||
    p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  );
}
```

In `parseEntry`, after the existing `dirs` array-shape check, add:

```ts
  for (const d of dirs as string[]) {
    if (badPath(d)) {
      throw new AgpmError(`${where}: dirs value "${d}" must be a clean repo-relative path (no "..", "\\", or leading "/")`);
    }
  }
```

And inside the existing files loop, before the hash check:

```ts
    if (badPath(rel)) {
      throw new AgpmError(`${where}: files key "${rel}" must be a clean relative path (no "..", "\\", or leading "/")`);
    }
```

- [ ] **Step 4: Run and watch them pass**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lock.ts test/lock.test.ts
git commit -m "fix: reject lock paths that could escape the repo"
```

---

### Task 2: Manifest serialization and name validation helpers

**Files:**
- Modify: `src/manifest.ts`
- Test: `test/manifest.test.ts`

**Interfaces:**
- Consumes: existing `NAME_RE`, `parseManifest`, `Manifest` type.
- Produces: `emptyManifest(): Manifest`, `serializeManifest(manifest: Manifest): string`, `isValidName(name: string): boolean`. Task 4 uses all three; Task 5 uses `serializeManifest` and `emptyManifest`.

- [ ] **Step 1: Write the failing tests**

Append to `test/manifest.test.ts`:

```ts
describe("serializeManifest", () => {
  it("round-trips through parseManifest with sorted names and a trailing newline", () => {
    const text = serializeManifest({
      version: 1,
      extends: "github:acme/policy@main",
      skills: { zeta: "local", alpha: "github:o/r/skills/alpha" },
      agents: {},
      commands: { deploy: "local" },
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zeta"'));
    expect(text.indexOf('"version"')).toBeLessThan(text.indexOf('"extends"'));
    expect(text.indexOf('"extends"')).toBeLessThan(text.indexOf('"skills"'));
    const back = parseManifest(text, "harness.json");
    expect(back.extends).toBe("github:acme/policy@main");
    expect(back.skills["alpha"]).toBe("github:o/r/skills/alpha");
    expect(back.commands["deploy"]).toBe("local");
  });

  it("omits extends when absent and is byte-stable", () => {
    const m = { version: 1 as const, skills: { a: "local" }, agents: {}, commands: {} };
    const text = serializeManifest(m);
    expect(text).not.toContain("extends");
    expect(serializeManifest(m)).toBe(text);
  });
});

describe("emptyManifest and isValidName", () => {
  it("returns an empty manifest that serializes and parses", () => {
    const back = parseManifest(serializeManifest(emptyManifest()), "harness.json");
    expect(Object.keys(back.skills)).toEqual([]);
  });

  it("validates names by the same rule parseManifest enforces", () => {
    expect(isValidName("brainstorming")).toBe(true);
    expect(isValidName("a.b-c_d9")).toBe(true);
    expect(isValidName("__proto__")).toBe(false);
    expect(isValidName("../x")).toBe(false);
    expect(isValidName("")).toBe(false);
  });
});
```

Add `serializeManifest, emptyManifest, isValidName` to the import from `../src/manifest.js`.

- [ ] **Step 2: Run and watch them fail**

Expected: FAIL with "does not provide an export named 'serializeManifest'" (module-level failure for the new describes).

- [ ] **Step 3: Implement**

In `src/manifest.ts`:

```ts
export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function emptyManifest(): Manifest {
  return {
    version: 1,
    skills: Object.create(null) as Record<string, string>,
    agents: Object.create(null) as Record<string, string>,
    commands: Object.create(null) as Record<string, string>,
  };
}

export function serializeManifest(manifest: Manifest): string {
  const out: Record<string, unknown> = Object.create(null);
  out["version"] = 1;
  if (manifest.extends !== undefined) out["extends"] = manifest.extends;
  for (const kind of KINDS) {
    const section: Record<string, string> = Object.create(null);
    for (const name of Object.keys(manifest[kind]).sort()) {
      section[name] = manifest[kind][name]!;
    }
    out[kind] = section;
  }
  return JSON.stringify(out, null, 2) + "\n";
}
```

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git add src/manifest.ts test/manifest.test.ts
git commit -m "feat: manifest serialization, empty manifest, name validator"
```

---

### Task 3: Provenance detection from other tools' lockfiles

**Files:**
- Create: `src/provenance.ts`
- Test: `test/provenance.test.ts`

**Interfaces:**
- Consumes: `makeRepo` test helper; node:fs/promises.
- Produces: `interface ProvenanceInfo { sources: Record<string, string>; notes: string[] }` and `readProvenance(root: string): Promise<ProvenanceInfo>`. `sources` maps a skill name to a provenance string that already passes the manifest's provenance rule. `notes` are human-readable strings for audit. Also exports `normalizeGithub(value: string): string | undefined` for direct testing. Tasks 5 and 6 consume `readProvenance`.

Behavior spec: read `skills-lock.json` then `.claude/skills-lock.json` from the repo root (later files win on a name collision). Missing file: silently fine. Unreadable or unparseable file: one note, never a crash. From the parsed JSON, look at the top-level `skills` object if present, else the top-level object itself. For each entry, the candidate string is the value itself (if a string) or its `source`, `repository`, `repo`, or `url` field (first present, checked with `Object.hasOwn`). Normalize the candidate to `github:owner/repo[/path]`; entries that do not normalize are skipped, never guessed. A key containing `/` contributes its last segment as the skill name.

`normalizeGithub` accepts exactly three shapes (anything else returns undefined):
1. `github:owner/repo[/path][@ref]`: strip a trailing `@ref` if present, then it must match the manifest's PROVENANCE_RE.
2. `https://github.com/owner/repo[/tree/<ref>/<path>|/blob/<ref>/<path>]`: becomes `github:owner/repo[/path]` (the `<ref>` segment is dropped).
3. Bare `owner/repo[/path]` where every segment matches `[A-Za-z0-9_.-]+`: becomes `github:owner/repo[/path]`.

- [ ] **Step 1: Write the failing tests**

Create `test/provenance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeGithub, readProvenance } from "../src/provenance.js";
import { makeRepo } from "./helpers.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

describe("normalizeGithub", () => {
  it("accepts the three known shapes", () => {
    expect(normalizeGithub("github:o/r/skills/brainstorming@abc123")).toBe("github:o/r/skills/brainstorming");
    expect(normalizeGithub("github:o/r")).toBe("github:o/r");
    expect(normalizeGithub("https://github.com/o/r")).toBe("github:o/r");
    expect(normalizeGithub("https://github.com/o/r/tree/main/skills/x")).toBe("github:o/r/skills/x");
    expect(normalizeGithub("https://github.com/o/r/blob/v1.2/skills/x")).toBe("github:o/r/skills/x");
    expect(normalizeGithub("o/r/skills/x")).toBe("github:o/r/skills/x");
  });

  it("refuses everything else", () => {
    expect(normalizeGithub("1.0.0")).toBeUndefined();
    expect(normalizeGithub("just-a-name")).toBeUndefined();
    expect(normalizeGithub("https://gitlab.com/o/r")).toBeUndefined();
    expect(normalizeGithub("github:o")).toBeUndefined();
    expect(normalizeGithub("")).toBeUndefined();
  });
});

describe("readProvenance", () => {
  it("returns empty info when no lockfile exists", async () => {
    const root = await makeRepo({ "README.md": "hi" });
    const info = await readProvenance(root);
    expect(Object.keys(info.sources)).toEqual([]);
    expect(info.notes).toEqual([]);
  });

  it("extracts sources from a skills table, keyed by last path segment", async () => {
    const root = await makeRepo({
      "skills-lock.json": JSON.stringify({
        skills: {
          "o/r/brainstorming": { source: "github:o/r/skills/brainstorming@abc" },
          "plain-name": "https://github.com/o/r/tree/main/skills/plain-name",
          versioned: { source: "1.0.0" },
        },
      }),
    });
    const info = await readProvenance(root);
    expect(info.sources["brainstorming"]).toBe("github:o/r/skills/brainstorming");
    expect(info.sources["plain-name"]).toBe("github:o/r/skills/plain-name");
    expect(Object.hasOwn(info.sources, "versioned")).toBe(false);
    expect(info.notes).toEqual([]);
  });

  it("later lockfiles win and the top-level object works as the table", async () => {
    const root = await makeRepo({
      "skills-lock.json": JSON.stringify({ x: "github:aaa/r" }),
      ".claude/skills-lock.json": JSON.stringify({ x: "github:bbb/r" }),
    });
    expect((await readProvenance(root)).sources["x"]).toBe("github:bbb/r");
  });

  it("notes an unparseable lockfile and never crashes", async () => {
    const root = await makeRepo({ "skills-lock.json": "{nope" });
    const info = await readProvenance(root);
    expect(Object.keys(info.sources)).toEqual([]);
    expect(info.notes).toHaveLength(1);
    expect(info.notes[0]).toContain("skills-lock.json");
  });

  it("notes an unreadable lockfile (a directory) and never crashes", async () => {
    const root = await makeRepo({ "README.md": "hi" });
    await mkdir(join(root, "skills-lock.json"));
    const info = await readProvenance(root);
    expect(info.notes).toHaveLength(1);
    expect(info.notes[0]).toContain("skills-lock.json");
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Expected: FAIL because `src/provenance.ts` does not exist (cannot resolve import).

- [ ] **Step 3: Implement**

Create `src/provenance.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProvenanceInfo {
  sources: Record<string, string>;
  notes: string[];
}

const LOCK_PATHS = ["skills-lock.json", ".claude/skills-lock.json"];
const PROVENANCE_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./-]+)?$/;
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const CANDIDATE_KEYS = ["source", "repository", "repo", "url"];

export async function readProvenance(root: string): Promise<ProvenanceInfo> {
  const sources: Record<string, string> = Object.create(null);
  const notes: string[] = [];
  for (const rel of LOCK_PATHS) {
    let text: string;
    try {
      text = await readFile(join(root, rel), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      notes.push(`could not read ${rel}: ${(error as Error).message}`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      notes.push(`could not parse ${rel}; ignoring it`);
      continue;
    }
    collect(raw, sources);
  }
  return { sources, notes };
}

function collect(raw: unknown, sources: Record<string, string>): void {
  if (!isPlainObject(raw)) return;
  const top = raw as Record<string, unknown>;
  const table = isPlainObject(top["skills"]) ? (top["skills"] as Record<string, unknown>) : top;
  for (const [key, value] of Object.entries(table)) {
    const candidate = candidateOf(value);
    if (candidate === undefined) continue;
    const provenance = normalizeGithub(candidate);
    if (provenance === undefined) continue;
    const name = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
    if (name !== "") sources[name] = provenance;
  }
}

function candidateOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isPlainObject(value)) return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of CANDIDATE_KEYS) {
    if (Object.hasOwn(obj, key) && typeof obj[key] === "string") return obj[key] as string;
  }
  return undefined;
}

export function normalizeGithub(value: string): string | undefined {
  if (value.startsWith("github:")) {
    const at = value.indexOf("@");
    const stripped = at === -1 ? value : value.slice(0, at);
    return PROVENANCE_RE.test(stripped) ? stripped : undefined;
  }
  const url = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/[^/]+(?:\/(.+))?)?\/?$/);
  if (url !== null) {
    const [, owner, repo, path] = url;
    const base = `github:${owner}/${repo}${path === undefined ? "" : `/${path}`}`;
    return PROVENANCE_RE.test(base) ? base : undefined;
  }
  const segments = value.split("/");
  if (segments.length >= 2 && segments.every((s) => SEGMENT_RE.test(s))) {
    const bare = `github:${value}`;
    return PROVENANCE_RE.test(bare) ? bare : undefined;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git add src/provenance.ts test/provenance.test.ts
git commit -m "feat: best-effort provenance from other tools' skill lockfiles"
```

---

### Task 4: computeSync pure core

**Files:**
- Create: `src/sync.ts`
- Test: `test/sync.test.ts`

**Interfaces:**
- Consumes: `emptyManifest`, `isValidName` (Task 2), `emptyLock` (existing), types from types.ts.
- Produces:

```ts
export interface SyncChange {
  action: "added" | "updated" | "removed";
  kind: Kind;
  name: string;
  detail: string; // provenance for added, summary for updated, "" for removed
}
export interface SyncResult { manifest: Manifest; lock: Lock; changes: SyncChange[]; notes: string[]; }
export function computeSync(prev: Manifest, prevLock: Lock, scan: ScanResult, sources: Record<string, string>): SyncResult;
```

Behavior spec:
- Output manifest and lock are rebuilt from the scan; `extends` and `extendsCommit` carry over from the inputs untouched.
- A scanned unit not in the previous manifest: added with source from `sources` (skills kind only) or `"local"`. Change: `added`, detail = source.
- A scanned unit in the previous manifest: source is sticky (kept verbatim, even when bytes changed). If its lock entry differs (dirs or file hashes), change: `updated` with a summary (`"N file(s) changed"` or `dirs now [...]`). If the previous lock had no entry at all, change: `updated`, detail `"lock entry created"`.
- A previous manifest entry with no scanned unit: dropped from both files. Change: `removed`, detail `""`.
- Unchanged entries produce no change record.
- The lock entry's `source` always equals the manifest value; `dirs` are the unit's location dirs sorted; `files` are the files of the location whose dir sorts first.
- A scanned name that fails `isValidName` is skipped with a note telling the user to rename the folder; valid units are still recorded and the command still succeeds. agpm must never write a manifest it cannot parse back.
- Changes are ordered: for each kind in KINDS order, removed entries first (sorted by name), then added/updated (sorted by name).
- Inputs are never mutated.

- [ ] **Step 1: Write the failing tests**

Create `test/sync.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeSync } from "../src/sync.js";
import { emptyLock } from "../src/lock.js";
import { emptyManifest } from "../src/manifest.js";
import { sha256 } from "../src/hash.js";
import type { Lock, Manifest, ScanResult } from "../src/types.js";

const noSources: Record<string, string> = Object.create(null);

const scanWith = (name: string, content: string, dirs = [".claude/skills"]): ScanResult => ({
  units: [{ kind: "skills", name, locations: dirs.map((dir) => ({ dir, files: { "SKILL.md": sha256(content) } })) }],
});

const manifestWith = (name: string, source: string): Manifest => {
  const m = emptyManifest();
  m.skills[name] = source;
  return m;
};

const lockWith = (name: string, content: string, source = "local", dirs = [".claude/skills"]): Lock => {
  const l = emptyLock();
  l.skills[name] = { source, dirs: [...dirs].sort(), files: { "SKILL.md": sha256(content) } };
  return l;
};

describe("computeSync", () => {
  it("adds a new folder with lockfile provenance when available, else local", () => {
    const sources: Record<string, string> = Object.create(null);
    sources["a"] = "github:o/r/skills/a";
    const r = computeSync(emptyManifest(), emptyLock(), scanWith("a", "x"), sources);
    expect(r.manifest.skills["a"]).toBe("github:o/r/skills/a");
    expect(r.lock.skills["a"]!.source).toBe("github:o/r/skills/a");
    expect(r.changes).toEqual([{ action: "added", kind: "skills", name: "a", detail: "github:o/r/skills/a" }]);
    const local = computeSync(emptyManifest(), emptyLock(), scanWith("b", "y"), noSources);
    expect(local.manifest.skills["b"]).toBe("local");
  });

  it("keeps the source sticky and reports changed bytes as updated", () => {
    const r = computeSync(
      manifestWith("a", "github:o/r/skills/a"),
      lockWith("a", "old", "github:o/r/skills/a"),
      scanWith("a", "new"),
      noSources,
    );
    expect(r.manifest.skills["a"]).toBe("github:o/r/skills/a");
    expect(r.lock.skills["a"]!.files["SKILL.md"]).toBe(sha256("new"));
    expect(r.changes).toEqual([{ action: "updated", kind: "skills", name: "a", detail: "1 file changed" }]);
  });

  it("removes entries whose folder disappeared", () => {
    const r = computeSync(manifestWith("gone", "local"), lockWith("gone", "x"), { units: [] }, noSources);
    expect(Object.keys(r.manifest.skills)).toEqual([]);
    expect(Object.keys(r.lock.skills)).toEqual([]);
    expect(r.changes).toEqual([{ action: "removed", kind: "skills", name: "gone", detail: "" }]);
  });

  it("reports no changes when disk matches the files, and output round-trips byte-identically", () => {
    const r = computeSync(manifestWith("a", "local"), lockWith("a", "x"), scanWith("a", "x"), noSources);
    expect(r.changes).toEqual([]);
    expect(r.manifest.skills["a"]).toBe("local");
  });

  it("creates a missing lock entry for a manifest-listed unit as updated", () => {
    const r = computeSync(manifestWith("a", "local"), emptyLock(), scanWith("a", "x"), noSources);
    expect(r.changes).toEqual([{ action: "updated", kind: "skills", name: "a", detail: "lock entry created" }]);
    expect(r.lock.skills["a"]!.files["SKILL.md"]).toBe(sha256("x"));
  });

  it("preserves extends and extendsCommit untouched", () => {
    const m = emptyManifest();
    m.extends = "github:acme/policy@main";
    const l = emptyLock();
    l.extendsCommit = "a".repeat(40);
    const r = computeSync(m, l, { units: [] }, noSources);
    expect(r.manifest.extends).toBe("github:acme/policy@main");
    expect(r.lock.extendsCommit).toBe("a".repeat(40));
  });

  it("does not mutate its inputs", () => {
    const m = manifestWith("a", "local");
    const l = emptyLock();
    computeSync(m, l, scanWith("a", "x"), noSources);
    expect(Object.keys(l.skills)).toEqual([]);
    expect(m.skills["a"]).toBe("local");
  });

  it("skips a folder name it could not parse back, with a note, and keeps valid siblings", () => {
    const scan: ScanResult = {
      units: [...scanWith("__proto__", "x").units, ...scanWith("good", "y").units],
    };
    const r = computeSync(emptyManifest(), emptyLock(), scan, noSources);
    expect(Object.hasOwn(r.manifest.skills, "__proto__")).toBe(false);
    expect(Object.hasOwn(r.lock.skills, "__proto__")).toBe(false);
    expect(r.manifest.skills["good"]).toBe("local");
    expect(r.changes).toEqual([{ action: "added", kind: "skills", name: "good", detail: "local" }]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain("__proto__");
    expect(r.notes[0]).toContain("rename");
  });

  it("records both dirs and uses the first-sorting location's files", () => {
    const r = computeSync(emptyManifest(), emptyLock(), scanWith("a", "x", [".claude/skills", ".agents/skills"]), noSources);
    expect(r.lock.skills["a"]!.dirs).toEqual([".agents/skills", ".claude/skills"]);
    expect(r.lock.skills["a"]!.files["SKILL.md"]).toBe(sha256("x"));
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Expected: FAIL because `src/sync.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/sync.ts`:

```ts
import { emptyLock } from "./lock.js";
import { emptyManifest, isValidName } from "./manifest.js";
import { KINDS, type Kind, type Lock, type LockEntry, type Manifest, type ScanResult, type ScannedUnit } from "./types.js";

export interface SyncChange {
  action: "added" | "updated" | "removed";
  kind: Kind;
  name: string;
  detail: string;
}

export interface SyncResult {
  manifest: Manifest;
  lock: Lock;
  changes: SyncChange[];
}

export function computeSync(
  prev: Manifest,
  prevLock: Lock,
  scan: ScanResult,
  sources: Record<string, string>,
): SyncResult {
  const manifest = emptyManifest();
  if (prev.extends !== undefined) manifest.extends = prev.extends;
  const lock = emptyLock();
  if (prevLock.extendsCommit !== undefined) lock.extendsCommit = prevLock.extendsCommit;
  const changes: SyncChange[] = [];
  const notes: string[] = [];

  for (const kind of KINDS) {
    const units = new Map(scan.units.filter((u) => u.kind === kind).map((u) => [u.name, u]));
    for (const name of Object.keys(prev[kind]).sort()) {
      if (!units.has(name)) changes.push({ action: "removed", kind, name, detail: "" });
    }
    for (const [name, unit] of [...units.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!isValidName(name)) {
        notes.push(
          `skipped ${kind}/${name}: the name must start with a letter or digit and use only letters, digits, dot, dash, underscore; rename the folder to record it`,
        );
        continue;
      }
      const source = Object.hasOwn(prev[kind], name)
        ? prev[kind][name]!
        : kind === "skills" && Object.hasOwn(sources, name)
          ? sources[name]!
          : "local";
      manifest[kind][name] = source;
      const entry = unitToEntry(unit, source);
      lock[kind][name] = entry;
      const prevEntry = Object.hasOwn(prevLock[kind], name) ? prevLock[kind][name]! : undefined;
      if (prevEntry === undefined) {
        if (Object.hasOwn(prev[kind], name)) {
          changes.push({ action: "updated", kind, name, detail: "lock entry created" });
        } else {
          changes.push({ action: "added", kind, name, detail: source });
        }
      } else if (!sameEntry(prevEntry, entry)) {
        changes.push({ action: "updated", kind, name, detail: diffSummary(prevEntry, entry) });
      }
    }
  }
  return { manifest, lock, changes, notes };
}

function unitToEntry(unit: ScannedUnit, source: string): LockEntry {
  const locations = [...unit.locations].sort((a, b) => (a.dir < b.dir ? -1 : 1));
  return { source, dirs: locations.map((l) => l.dir), files: locations[0]!.files };
}

function sameEntry(a: LockEntry, b: LockEntry): boolean {
  return a.source === b.source && sameArray(a.dirs, b.dirs) && sameRecord(a.files, b.files);
}

function diffSummary(a: LockEntry, b: LockEntry): string {
  if (!sameArray(a.dirs, b.dirs)) return `dirs now [${b.dirs.join(", ")}]`;
  const keys = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
  let n = 0;
  for (const key of keys) {
    const left = Object.hasOwn(a.files, key) ? a.files[key] : undefined;
    const right = Object.hasOwn(b.files, key) ? b.files[key] : undefined;
    if (left !== right) n++;
  }
  return `${n} file${n === 1 ? "" : "s"} changed`;
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}
```

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git add src/sync.ts test/sync.test.ts
git commit -m "feat: computeSync pure core (add, update, remove, sticky sources)"
```

---

### Task 5: init and sync CLI commands

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `computeSync` (Task 4), `readProvenance` (Task 3), `serializeManifest`/`emptyManifest` (Task 2), existing `serializeLock`, `scanRepo`, `loadFiles`.
- Produces: `agpm init` and `agpm sync` commands. Usage line becomes `usage: agpm <init|sync|check|list>` (audit joins in Task 6). `loadFiles`' missing-manifest error message gains `; run agpm init`.

Output contract:
- One line per change: `added skills/a (github:o/r/skills/a)`, `updated skills/a (1 file changed)`, `removed skills/a` (no parentheses when detail is empty).
- One `note: ...` line per provenance note (sync only, before the change lines).
- Summary lines: init prints `init: N entries recorded` (singular `entry` when N is 1); sync prints `sync: A added, U updated, R removed`.
- Both exit 0 on success. init on a repo that already has harness.json exits 2 with a message containing `already exists`. sync without harness.json exits 2 with the loadFiles message.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.ts` (the file already has `run(argv, cwd)`, `makeRepo`, `mkdir`, `join`; add `readFile` to the node:fs/promises import):

```ts
describe("runCli init and sync", () => {
  it("init writes both files, reports entries, and check passes immediately", async () => {
    const root = await makeRepo({
      ".claude/skills/a/SKILL.md": "x",
      ".claude/agents/planner.md": "p",
      "skills-lock.json": JSON.stringify({ skills: { "o/r/a": { source: "github:o/r/skills/a" } } }),
    });
    const { code, lines } = await run(["init"], root);
    expect(code).toBe(0);
    expect(lines).toEqual([
      "added skills/a (github:o/r/skills/a)",
      "added agents/planner (local)",
      "init: 2 entries recorded",
    ]);
    const manifest = JSON.parse(await readFile(join(root, "harness.json"), "utf8"));
    expect(manifest.skills["a"]).toBe("github:o/r/skills/a");
    const check = await run(["check"], root);
    expect(check.code).toBe(0);
  });

  it("init refuses to overwrite an existing harness.json", async () => {
    const root = await makeRepo({ "harness.json": JSON.stringify({ version: 1 }) });
    const { code, lines } = await run(["init"], root);
    expect(code).toBe(2);
    expect(lines[0]).toContain("already exists");
  });

  it("sync without harness.json points at init", async () => {
    const root = await makeRepo({ "README.md": "hi" });
    const { code, lines } = await run(["sync"], root);
    expect(code).toBe(2);
    expect(lines[0]).toContain("run agpm init");
  });

  it("sync refreshes a tampered entry and check goes green again", async () => {
    const root = await makeRepo({ ".claude/skills/a/SKILL.md": "x" });
    await run(["init"], root);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, ".claude", "skills", "a", "SKILL.md"), "TAMPERED", "utf8");
    expect((await run(["check"], root)).code).toBe(1);
    const sync = await run(["sync"], root);
    expect(sync.code).toBe(0);
    expect(sync.lines).toEqual(["updated skills/a (1 file changed)", "sync: 0 added, 1 updated, 0 removed"]);
    expect((await run(["check"], root)).code).toBe(0);
  });

  it("sync with nothing to do says so and stays green", async () => {
    const root = await makeRepo({ ".claude/skills/a/SKILL.md": "x" });
    await run(["init"], root);
    const { code, lines } = await run(["sync"], root);
    expect(code).toBe(0);
    expect(lines).toEqual(["sync: 0 added, 0 updated, 0 removed"]);
  });

  it("sync surfaces provenance notes", async () => {
    const root = await makeRepo({ ".claude/skills/a/SKILL.md": "x" });
    await run(["init"], root);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "skills-lock.json"), "{nope", "utf8");
    const { lines } = await run(["sync"], root);
    expect(lines[0]).toContain("note:");
  });
});
```

Also update the existing usage assertion in the "unknown command" test from `"usage: agpm <check|list>"` to `"usage: agpm <init|sync|check|list>"`.

- [ ] **Step 2: Run and watch them fail**

Expected: the new tests FAIL with `usage: agpm <check|list>` output (unknown command path) and the updated usage test FAILS against the old string.

- [ ] **Step 3: Implement**

In `src/cli.ts`:

Add imports: `access, writeFile` from `node:fs/promises`; `emptyManifest, serializeManifest` from `./manifest.js`; `serializeLock, emptyLock` (emptyLock already imported); `computeSync, type SyncResult` from `./sync.js`; `readProvenance` from `./provenance.js`.

Add cases to the switch:

```ts
      case "init":
        return await init(cwd, write);
      case "sync":
        return await sync(cwd, write);
```

Change the default usage string to `"usage: agpm <init|sync|check|list>"`.

In `loadFiles`, change the missing-manifest message to:

```ts
      throw new AgpmError(`no harness.json found in ${cwd}; run agpm init`);
```

Add the command bodies and helpers:

```ts
async function init(cwd: string, write: Writer): Promise<number> {
  const manifestPath = join(cwd, "harness.json");
  if (await fileExists(manifestPath)) {
    throw new AgpmError(`harness.json already exists in ${cwd}; run agpm sync`);
  }
  const { sources } = await readProvenance(cwd);
  const result = computeSync(emptyManifest(), emptyLock(), await scanRepo(cwd), sources);
  await writeResult(cwd, result);
  reportChanges(result.changes, write);
  const n = result.changes.length;
  write(`init: ${n} ${n === 1 ? "entry" : "entries"} recorded`);
  return 0;
}

async function sync(cwd: string, write: Writer): Promise<number> {
  const { manifest, lock } = await loadFiles(cwd);
  const { sources, notes } = await readProvenance(cwd);
  const result = computeSync(manifest, lock, await scanRepo(cwd), sources);
  await writeResult(cwd, result);
  for (const note of notes) write(`note: ${note}`);
  reportChanges(result.changes, write);
  const count = (action: string) => result.changes.filter((c) => c.action === action).length;
  write(`sync: ${count("added")} added, ${count("updated")} updated, ${count("removed")} removed`);
  return 0;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeResult(cwd: string, result: SyncResult): Promise<void> {
  await writeFile(join(cwd, "harness.json"), serializeManifest(result.manifest), "utf8");
  await writeFile(join(cwd, "harness.lock"), serializeLock(result.lock), "utf8");
}

function reportChanges(changes: SyncResult["changes"], write: Writer): void {
  for (const change of changes) {
    const suffix = change.detail === "" ? "" : ` (${change.detail})`;
    write(`${change.action} ${change.kind}/${change.name}${suffix}`);
  }
}
```

- [ ] **Step 4: Run and watch them pass**

Run the full suite. Also smoke-test the real binary once:

```bash
npm --prefix /Users/mohammad/Desktop/agpm run build
```

Then in a scratch directory with a `.claude/skills/demo/SKILL.md`: `node /Users/mohammad/Desktop/agpm/dist/bin.js init` followed by `node /Users/mohammad/Desktop/agpm/dist/bin.js check`; expect exit 0 and the files present.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: agpm init and agpm sync commands"
```

---

### Task 6: audit command

**Files:**
- Create: `src/audit.ts`
- Modify: `src/check.ts` (extract shared name-union helpers), `src/list.ts` (use them), `src/cli.ts` (register command, final usage line)
- Test: `test/audit.test.ts`, existing usage assertion in `test/cli.test.ts`

**Interfaces:**
- Consumes: `runCheck`, `readProvenance`, existing types.
- Produces in `src/check.ts` (also closes the M1 Minor about duplicated name-union logic):

```ts
export function unitsByName(scan: ScanResult, kind: Kind): Map<string, ScannedUnit>;
export function nameUnion(manifest: Manifest, lock: Lock, units: Map<string, ScannedUnit>, kind: Kind): string[]; // sorted
```

Produces in `src/audit.ts`:

```ts
export function formatAudit(manifest: Manifest, lock: Lock, scan: ScanResult, notes: string[]): string[];
```

Output contract, one row per entry across all kinds:

```
skills    brainstorming    ok         github:obra/superpowers/skills/brainstorming    .agents/skills + .claude/skills
```

Columns: kind (padEnd 9), name (padEnd 30), state (padEnd 9, the finding code or `ok`), source (padEnd 45, the manifest value, or `(unapproved)` when the manifest has no entry), location (the sorted dirs joined with ` + `, or `(not on disk)`). After the rows: one `note: ...` line per note, then the summary line `audit: N entries, D out of approval, U unapproved` where D counts findings with codes missing/drifted/split/unsynced and U counts unlisted. audit always exits 0; facts, not a gate.

- [ ] **Step 1: Write the failing tests**

Create `test/audit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatAudit } from "../src/audit.js";
import { emptyLock } from "../src/lock.js";
import { emptyManifest } from "../src/manifest.js";
import { sha256 } from "../src/hash.js";
import { runCli } from "../src/cli.js";
import { makeRepo } from "./helpers.js";
import type { Lock, Manifest, ScanResult } from "../src/types.js";

const scanWith = (name: string, content: string): ScanResult => ({
  units: [{ kind: "skills", name, locations: [{ dir: ".claude/skills", files: { "SKILL.md": sha256(content) } }] }],
});

describe("formatAudit", () => {
  it("shows ok, unapproved, and missing entries with counts", () => {
    const manifest = emptyManifest();
    manifest.skills["approved"] = "github:o/r/skills/approved";
    manifest.skills["ghost"] = "local";
    const lock = emptyLock();
    lock.skills["approved"] = { source: "github:o/r/skills/approved", dirs: [".claude/skills"], files: { "SKILL.md": sha256("x") } };
    lock.skills["ghost"] = { source: "local", dirs: [".claude/skills"], files: { "SKILL.md": sha256("g") } };
    const scan: ScanResult = {
      units: [
        ...scanWith("approved", "x").units,
        ...scanWith("stray", "s").units,
      ],
    };
    const lines = formatAudit(manifest, lock, scan, []);
    expect(lines.find((l) => l.includes("approved"))).toMatch(/^skills\s+approved\s+ok\s+github:o\/r\/skills\/approved\s+\.claude\/skills$/);
    expect(lines.find((l) => l.includes("ghost"))).toContain("(not on disk)");
    expect(lines.find((l) => l.includes("stray"))).toContain("(unapproved)");
    expect(lines.at(-1)).toBe("audit: 3 entries, 1 out of approval, 1 unapproved");
  });

  it("appends provenance notes before the summary", () => {
    const lines = formatAudit(emptyManifest(), emptyLock(), { units: [] }, ["could not parse skills-lock.json; ignoring it"]);
    expect(lines[0]).toBe("note: could not parse skills-lock.json; ignoring it");
    expect(lines.at(-1)).toBe("audit: 0 entries, 0 out of approval, 0 unapproved");
  });
});

describe("runCli audit", () => {
  it("exits 0 even when the repo has drift", async () => {
    const root = await makeRepo({ ".claude/skills/a/SKILL.md": "x" });
    await runCli(["init"], root, () => {});
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(root, ".claude", "skills", "a", "SKILL.md"), "TAMPERED", "utf8");
    const lines: string[] = [];
    const code = await runCli(["audit"], root, (line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines.find((l) => l.includes(" a "))).toContain("drifted");
  });
});
```

Update the usage assertion in `test/cli.test.ts` to `"usage: agpm <init|sync|check|audit|list>"`.

- [ ] **Step 2: Run and watch them fail**

Expected: FAIL because `src/audit.ts` does not exist, and the usage assertion fails against the Task 5 string.

- [ ] **Step 3: Implement**

In `src/check.ts`, extract the two helpers from `runCheck`'s loop head and export them; `runCheck` calls them:

```ts
export function unitsByName(scan: ScanResult, kind: Kind): Map<string, ScannedUnit> {
  return new Map(scan.units.filter((u) => u.kind === kind).map((u) => [u.name, u]));
}

export function nameUnion(manifest: Manifest, lock: Lock, units: Map<string, ScannedUnit>, kind: Kind): string[] {
  return [...new Set([...Object.keys(manifest[kind]), ...Object.keys(lock[kind]), ...units.keys()])].sort();
}
```

In `src/list.ts`, replace the hand-built union with the same helpers (behavior identical; this closes the parked M1 Minor about duplication).

Create `src/audit.ts`:

```ts
import { nameUnion, runCheck, unitsByName } from "./check.js";
import { KINDS, type Lock, type Manifest, type ScanResult } from "./types.js";

const OUT_OF_APPROVAL = new Set(["missing", "drifted", "split", "unsynced"]);

export function formatAudit(manifest: Manifest, lock: Lock, scan: ScanResult, notes: string[]): string[] {
  const { findings } = runCheck(manifest, lock, scan);
  const lines: string[] = [];
  let total = 0;
  let outOfApproval = 0;
  let unapproved = 0;
  for (const kind of KINDS) {
    const units = unitsByName(scan, kind);
    for (const name of nameUnion(manifest, lock, units, kind)) {
      total++;
      const finding = findings.find((f) => f.kind === kind && f.name === name);
      const state = finding === undefined ? "ok" : finding.code;
      if (OUT_OF_APPROVAL.has(state)) outOfApproval++;
      if (state === "unlisted") unapproved++;
      const source = Object.hasOwn(manifest[kind], name) ? manifest[kind][name]! : "(unapproved)";
      const unit = units.get(name);
      const where = unit === undefined
        ? "(not on disk)"
        : unit.locations.map((l) => l.dir).sort().join(" + ");
      lines.push(`${kind.padEnd(9)} ${name.padEnd(30)} ${state.padEnd(9)} ${source.padEnd(45)} ${where}`);
    }
  }
  for (const note of notes) lines.push(`note: ${note}`);
  lines.push(`audit: ${total} entries, ${outOfApproval} out of approval, ${unapproved} unapproved`);
  return lines;
}
```

In `src/cli.ts`: import `formatAudit`, add the case and body, and set the final usage string `"usage: agpm <init|sync|check|audit|list>"`:

```ts
      case "audit":
        return await audit(cwd, write);
```

```ts
async function audit(cwd: string, write: Writer): Promise<number> {
  const { manifest, lock } = await loadFiles(cwd);
  const { notes } = await readProvenance(cwd);
  for (const line of formatAudit(manifest, lock, await scanRepo(cwd), notes)) write(line);
  return 0;
}
```

- [ ] **Step 4: Run and watch them pass**

Full suite green, including the untouched check/list golden behavior.

- [ ] **Step 5: Commit**

```bash
git add src/audit.ts src/check.ts src/list.ts src/cli.ts test/audit.test.ts test/cli.test.ts
git commit -m "feat: agpm audit command; share the name-union helpers"
```

---

### Task 7: README with the honesty note, and the full-loop e2e test

**Files:**
- Create: `README.md`
- Test: `test/e2e.test.ts` (extend)

**Interfaces:**
- Consumes: everything shipped in Tasks 1 to 6.
- Produces: the repo's README and one end-to-end test that walks the whole M2 story.

- [ ] **Step 1: Write the failing test**

Append to `test/e2e.test.ts` (reuse its existing imports and style; it already builds temp repos and runs `runCli`):

```ts
it("full loop: init, drift, sync, remove, always back to green", async () => {
  const root = await makeRepo({ ".claude/skills/a/SKILL.md": "v1" });
  const out = async (argv: string[]) => {
    const lines: string[] = [];
    const code = await runCli(argv, root, (line) => lines.push(line));
    return { code, lines };
  };

  expect((await out(["init"])).code).toBe(0);
  expect((await out(["check"])).code).toBe(0);

  await mkdir(join(root, ".claude", "skills", "b"), { recursive: true });
  await writeFile(join(root, ".claude", "skills", "b", "SKILL.md"), "new", "utf8");
  const warned = await out(["check"]);
  expect(warned.code).toBe(0);
  expect(warned.lines.some((l) => l.startsWith("WARN skills/b"))).toBe(true);
  expect((await out(["sync"])).lines).toContain("added skills/b (local)");
  expect((await out(["check"])).code).toBe(0);

  await writeFile(join(root, ".claude", "skills", "a", "SKILL.md"), "v2", "utf8");
  expect((await out(["check"])).code).toBe(1);
  expect((await out(["sync"])).lines).toContain("updated skills/a (1 file changed)");
  expect((await out(["check"])).code).toBe(0);

  await rm(join(root, ".claude", "skills", "b"), { recursive: true });
  expect((await out(["check"])).code).toBe(1);
  expect((await out(["sync"])).lines).toContain("removed skills/b");
  expect((await out(["check"])).code).toBe(0);
});
```

Add `mkdir, rm, writeFile` to the test file's node:fs/promises import if missing.

- [ ] **Step 2: Run and watch it fail or pass for the right reason**

Expected: PASS if Tasks 1 to 6 are correct; any failure here is a real integration bug to fix before continuing. Watch it run; do not skip it because "the units cover it".

- [ ] **Step 3: Write the README**

Create `README.md` (content below is the deliverable; adjust nothing without reason):

```markdown
# agpm

The approval and audit layer for agent skills. By baselane.

People install skills with any tool they like: `npx skills`, marketplaces, git, or by hand. agpm never installs, copies, updates, or removes a skill folder. It does three things:

1. `agpm sync` reflects what exists on disk into two files: `harness.json` (what is approved to exist) and `harness.lock` (a sha256 per file).
2. A pull request that changes `harness.json` is the approval.
3. `agpm check` in CI proves the repo still matches what was approved.

## Quick start

Not yet on npm. From a checkout:

    npm install && npm run build
    node dist/bin.js init     # scan the repo, draft both files
    git add harness.json harness.lock && git commit
    node dist/bin.js check    # exit 0: clean, 1: violations, 2: internal error

## Commands

| Command | Job |
|---|---|
| `agpm init`  | Scan the repo, draft harness.json and harness.lock from what already exists |
| `agpm sync`  | Re-scan and update both files; the PR carrying the diff is the approval |
| `agpm check` | CI gate: FAIL on drifted or missing, WARN on unapproved |
| `agpm audit` | Facts view: everything that exists, where it came from, what changed |
| `agpm list`  | One line per entry: ok, drifted, missing, or unlisted |

agpm observes `.claude/skills/`, `.agents/skills/`, `.claude/agents/*.md`, and `.claude/commands/*.md`. Provenance is read, best effort, from `skills-lock.json` when another tool wrote one; anything unexplained is recorded as `local`, never guessed.

## What check proves, honestly

`check` proves nothing changed since a human approved it. It does not prove the approved content is safe. `audit` reports facts; it does not score or judge content. Provenance agpm cannot explain from a lockfile is recorded as `local`, not guessed. `audit` shows `(unapproved)` for anything on disk that `harness.json` does not list.

## Not in this tool

No installing. No registry server. No dashboard. No accounts. No AI. No telemetry. No editing of AGENTS.md, CLAUDE.md, settings files, or any skill folder. agpm writes exactly two files: `harness.json` and `harness.lock`.
```

- [ ] **Step 4: Run the full gate**

Run: `npm --prefix /Users/mohammad/Desktop/agpm test`, then `npm --prefix /Users/mohammad/Desktop/agpm run typecheck`, then `npm --prefix /Users/mohammad/Desktop/agpm run build`.
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add README.md test/e2e.test.ts
git commit -m "docs: README with the honesty note; e2e full loop test"
```

---

## Self-review notes

- Spec coverage: init (Task 5), sync incl. all four sync rules (Tasks 4, 5), provenance detection incl. the unreadable-lockfile note (Task 3), audit (Task 6), honesty rules (Tasks 3, 6, 7), error handling (Tasks 3, 5), M1 carry-items (Tasks 1, 7). Extends resolution, `--strict`, `--json` are M3 by design; `computeSync` preserves the fields untouched (Task 4).
- Type consistency: `isValidName`/`emptyManifest`/`serializeManifest` defined in Task 2, consumed in Tasks 4, 5. `SyncChange`/`SyncResult`/`computeSync` defined in Task 4, consumed in Task 5. `ProvenanceInfo`/`readProvenance` defined in Task 3, consumed in Tasks 5, 6. `unitsByName`/`nameUnion` defined in Task 6 where first shared.
- The usage string changes twice on purpose (Task 5 without audit, Task 6 with it) so each commit's usage line only names commands that exist.
