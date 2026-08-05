# agpm CLI Registry Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agpm gains `install`, `remove`, `update`, `login`, `logout`, and `publish` against the baselane registry protocol v1, while `init`, `sync`, `check`, `audit`, `list` stay byte-identical in behavior.

**Architecture:** New modules layer on the existing core: registry reference parsing extends the provenance grammar in `manifest.ts`; a strict ustar reader/writer (`tar.ts`) and a fetch-based registry client (`registry.ts`) feed an install engine (`install.ts`) that places files and records them through the existing `computeSync` path; `cli.ts` wires the commands. All network goes through an injectable fetch on `CliDeps`.

**Tech Stack:** TypeScript strict NodeNext, ESM with ".js" imports, Node >= 18, vitest 3, zero runtime dependencies (`fetch`, `node:zlib`, `node:crypto`, `node:fs/promises`, `node:http` in tests only).

**Specs:** `docs/superpowers/specs/2026-08-06-registry-protocol-design.md` (protocol), `docs/superpowers/specs/2026-08-06-cli-registry-pivot-design.md` (this CLI's behavior). Both bind this plan.

## Global Constraints

- Zero runtime npm dependencies. Node >= 18. TypeScript strict, NodeNext, every relative import ends in ".js".
- Record maps are null-prototype: `Object.create(null)` to build, `Object.hasOwn` to probe.
- All JSON agpm writes: sorted keys, 2-space indent, trailing newline, no timestamps.
- All errors are `AgpmError` with an actionable message; CLI exits 0 clean, 1 violations, 2 internal or usage error. No `console.log` in src/; output goes through the injected `write`.
- No em-dashes in any authored text (code, docs, messages).
- Tokens are never printed, logged, or written anywhere except `~/.agpm/credentials` (mode 0o600). Error messages must not echo tokens.
- The `Authorization` header is sent only to URLs whose origin equals the registry base URL origin.
- Registry default `https://registry.baselane.sh`, overridden by env `AGPM_REGISTRY`.
- Tar profile (both directions): plain ustar, regular files only (dirs implied), UTF-8 forward-slash relative paths, max 100 chars per path, empty prefix field, no pax/GNU entries, no symlinks, no `..` segments, no absolute paths, no duplicates, max 1000 files, max 10 MiB compressed, max 25 MiB extracted, mtime 0, uid/gid 0.
- Exact reminder line printed by install and update: `install is not approval; commit the harness diff and approve it by PR`
- `check`, `audit`, `list` remain offline and behaviorally unchanged except that `registry:` provenance strings display like any other provenance.

---

### Task 1: Registry references and provenance grammar

**Files:**
- Create: `src/registryRef.ts`
- Modify: `src/manifest.ts` (isProvenance, parseSection error message)
- Test: `test/registryRef.test.ts`, extend `test/manifest.test.ts`

**Interfaces:**
- Produces: `parseRegistryRef(value: string): RegistryRef | undefined` where `RegistryRef = { org: string; name: string; version?: string }` (version absent for `@org/name`).
- Produces: `formatRegistryRef(ref: { org: string; name: string; version: string }): string` returning `@org/name@1.2.0`.
- Produces: `compareVersions(a: string, b: string): number` numeric triple compare.
- Produces: `isRegistryProvenance(value: string): boolean` accepting `registry:@org/name@1.2.0` and pack-member form `registry:@org/pack@3.0.0/@org/name@1.2.0`.
- Rules (from the protocol spec): org `^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$`; name is the existing `NAME_RE` and max 100 chars; version `^\d+\.\d+\.\d+$`.

- [ ] **Step 1: Failing tests.** Valid refs with and without version; rejects: empty org, uppercase org, org with leading/trailing dash, org over 39 chars, missing `@`, bad version (`1.2`, `v1.2.0`, `1.2.0-rc1`), name starting with dot, name over 100 chars. `compareVersions("1.10.0","1.9.0") > 0`. `isRegistryProvenance` accepts both forms, rejects `registry:` alone, rejects three chained refs, rejects any part failing the ref rules. In manifest tests: a manifest whose skills entry has `registry:@baselane/tdd@1.2.0` parses; provenance error message now reads `provenance must be "local", "unknown", "github:owner/repo[/path]", or "registry:@org/name@version"`.
- [ ] **Step 2: Implement.** `registryRef.ts` exports the four functions plus `ORG_RE` and `VERSION_RE`. `manifest.ts` imports `isRegistryProvenance` and adds `if (value.startsWith("registry:")) return isRegistryProvenance(value);` at the top of the github branch in `isProvenance`, and updates the `parseSection` message to the exact text above.
- [ ] **Step 3: `npm run test` green, `npm run typecheck` clean. Commit** `feat: registry reference parsing and registry provenance`.

### Task 2: Strict ustar tarball reader and writer

**Files:**
- Create: `src/tar.ts`
- Test: `test/tar.test.ts`

**Interfaces:**
- Produces: `createTarball(files: Record<string, Uint8Array>): Buffer` (gzipped ustar; paths sorted lexicographically; deterministic bytes for identical input).
- Produces: `extractTarball(gz: Uint8Array): Record<string, Buffer>` (null-prototype result keyed by path).
- Produces: `TAR_LIMITS = { maxCompressed: 10 * 1024 * 1024, maxExtracted: 25 * 1024 * 1024, maxFiles: 1000 }`.
- Both throw `AgpmError` starting with `invalid package: ` on any profile violation.

Header layout (write): 512-byte blocks; name (100), mode `"0000644 "` for files (octal, NUL-space variants acceptable to readers; use trailing NUL), uid/gid 0, size octal, mtime 0, checksum (space-filled during compute), typeflag `"0"`, magic `"ustar\0"` version `"00"`, empty uname/gname/devmajor/devminor/prefix. Two zero blocks at the end. Content padded to 512.

Reader: iterate blocks; stop at zero block; verify checksum; accept typeflag `"0"` (file) and `"5"` (directory, skipped); reject any other typeflag with `invalid package: unsupported tar entry type "<flag>"`; reject non-empty prefix field, path with `..` segment, leading `/`, backslash, empty path, duplicate path; enforce limits: compressed size before gunzip (`invalid package: tarball exceeds 10 MiB`), running extracted total (`invalid package: contents exceed 25 MiB`), file count (`invalid package: more than 1000 files`). Gunzip via `gunzipSync` wrapped so a zlib error becomes `invalid package: not a gzip tarball`.

- [ ] **Step 1: Failing tests.** Round trip: create then extract returns identical bytes and paths; deterministic: two `createTarball` calls on the same input are byte-equal; `createTarball` rejects a path over 100 chars with `invalid package: path too long for ustar: <path>`. Hostile inputs built by hand-crafting headers in the test (helper in the test file): traversal name `../x`, absolute `/etc/x`, symlink typeflag `"2"`, non-empty prefix, duplicate path, corrupted checksum, plain-text non-gzip input, tarball whose declared sizes total over 25 MiB, and a gzip whose compressed length exceeds 10 MiB (build with `gzipSync(Buffer.alloc(...))` sized to trip the cap). Each rejects with its exact message.
- [ ] **Step 2: Implement `tar.ts`** (~180 lines). No dependencies beyond `node:zlib`, `node:buffer`, `./errors.js`.
- [ ] **Step 3: Green, typecheck, commit** `feat: strict ustar tarball profile`.

### Task 3: Credentials and token resolution

**Files:**
- Create: `src/credentials.ts`
- Test: `test/credentials.test.ts`

**Interfaces:**
- Produces: `resolveToken(registryUrl: string, env: Record<string, string | undefined>, homeDir: string): Promise<string | undefined>`; `AGPM_TOKEN` wins over the file; absent both returns undefined.
- Produces: `writeToken(registryUrl: string, token: string, homeDir: string): Promise<void>` and `deleteToken(registryUrl: string, homeDir: string): Promise<boolean>` (false when nothing was stored).
- File: `<homeDir>/.agpm/credentials`, shape `{ "registries": { "<url>": { "token": "<token>" } } }`, sorted keys, 2-space indent, trailing newline, written with `{ mode: 0o600 }` and the `.agpm` directory created with `{ recursive: true, mode: 0o700 }`. Registry URLs are stored with no trailing slash (normalize on read and write).
- A credentials file that exists but is unreadable JSON throws `AgpmError` `broken credentials file at <path>; delete it and run agpm login again`.

- [ ] **Step 1: Failing tests** using a temp dir as homeDir: env wins; file fallback; missing both; write then resolve round trip; mode check via `stat` (`mode & 0o777` equals 0o600); delete removes only that registry's entry and reports false on absent; broken JSON message; trailing-slash URL resolves the same as without.
- [ ] **Step 2: Implement. Step 3: Green, typecheck, commit** `feat: registry credentials store`.

### Task 4: Registry client

**Files:**
- Create: `src/registry.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Produces types: `RegistryFileEntry { path: string; sha256: string; size: number }`; `SkillVersionManifest { name: string; kind: "skill"; version: string; description: string; files: RegistryFileEntry[]; tarball: { url: string; sha256: string; size: number } }`; `PackVersionManifest { name: string; kind: "pack"; version: string; description: string; skills: Record<string, string> }`; `VersionManifest = SkillVersionManifest | PackVersionManifest`; `PackageInfo { name: string; kind: "skill" | "pack"; latest: string; versions: string[] }`; `WhoamiResult { user: string; orgs: { org: string; role: string }[] }`.
- Produces: `interface RegistryClient { getPackageInfo(org: string, name: string): Promise<PackageInfo>; getVersionManifest(org: string, name: string, version: string): Promise<VersionManifest>; getTarball(url: string): Promise<Buffer>; whoami(): Promise<WhoamiResult>; publish(org: string, name: string, version: string, manifest: unknown, tarball?: Buffer): Promise<void>; }`
- Produces: `makeRegistryClient(baseUrl: string, token: string | undefined, fetchImpl: typeof fetch): RegistryClient`.
- Behavior: bearer header attached only when `token` is defined AND the request URL origin equals `new URL(baseUrl).origin` (applies to `getTarball` too). Non-2xx responses parse the protocol error body and throw `AgpmError` `registry error <code>: <message>`; an unparseable body throws `registry error http_<status>: <statusText>`. Response JSON is structurally validated (required fields, types, `files` array entries, sha256 is 64 lowercase hex via `/^[0-9a-f]{64}$/`); a bad shape throws `registry error bad_response: <what was wrong>`. `publish` sends `PUT` multipart/form-data using the standard `FormData` and `Blob` globals, field `manifest` (JSON string) and optional field `tarball`.

- [ ] **Step 1: Failing tests** with a recorded stub `fetchImpl` capturing requests: token attached to same-origin, not attached to `https://cdn.example.com/x.tgz`; 404 body `{"error":{"code":"not_found","message":"no such package"}}` becomes `registry error not_found: no such package`; HTML body on 500 becomes `registry error http_500: Internal Server Error`; shape validation rejects a manifest missing `files`; happy paths return typed objects; publish sends PUT with both form fields.
- [ ] **Step 2: Implement. Step 3: Green, typecheck, commit** `feat: registry client`.

### Task 5: Install engine

**Files:**
- Create: `src/install.ts`
- Test: `test/install.test.ts`

**Interfaces:**
- Consumes: `parseRegistryRef`, `formatRegistryRef`, `RegistryClient` types, `extractTarball`, `computeSync`, `scanRepo`, `readProvenance`, `parseManifest`/`parseLock` via the same load pattern `cli.ts` uses.
- Produces: `runInstall(cwd: string, refValue: string, client: RegistryClient): Promise<{ lines: string[]; }>` where `lines` are the output lines for the CLI to write (changes plus the reminder line last).

Behavior, in order:
1. `parseRegistryRef(refValue)`; undefined throws `AgpmError` `install takes @org/name or @org/name@version`.
2. No version: `getPackageInfo` and use `latest`. Fetch the version manifest.
3. Pack: for each member (sorted by name) fetch its version manifest; every member must be `kind: "skill"` (a pack member that is a pack throws `registry error invalid_package: pack members must be skills`). Build the flat list of (skillManifest, provenance) where pack members get `registry:<packref>/<memberref>`; a direct skill install gets `registry:<ref>`.
4. For each skill: `getTarball`, verify `sha256(gz)` equals `tarball.sha256` (`AgpmError` `tarball hash mismatch for <ref>`), `extractTarball`, verify the extracted path set equals the manifest `files` paths exactly and each file's sha256 matches (`AgpmError` `file hash mismatch for <ref>: <path>`). `SKILL.md` must be present in `files` (`AgpmError` `<ref> has no SKILL.md; not a skill package`).
5. Target roots: of `.claude/skills` and `.agents/skills`, use every one whose directory exists in `cwd`; if none exists use `.claude/skills` (create it). The installed folder name is the ref's `name`.
6. Collision rule: load harness files (missing harness.json throws the existing `no harness.json found in <cwd>; run agpm init`). If `manifest.skills[name]` exists with a provenance different from the one being written, or the folder exists on disk in any target root while `manifest.skills[name]` is absent, throw `AgpmError` `skills/<name> exists with provenance "<existing>"; remove it first (agpm remove <name>)` (for the unlisted-folder case the provenance shown is `unapproved`). Reinstalling the same ref at the same version is allowed and rewrites bytes.
7. Write files (mkdir recursive, then each file), set `manifest.skills[name]` to the provenance, then `computeSync(manifest, lock, await scanRepo(cwd), sources)` with sources from `readProvenance`, and write both files exactly like `cli.ts` `writeResult` does.
8. `lines`: each `installed skills/<name> (<provenance>)` in install order, then the reminder line.

- [ ] **Step 1: Failing tests** with a fake `RegistryClient` built from fixtures (use `createTarball` from Task 2 to build fixture tarballs): fresh install into a repo with `.claude/skills` only; repo with both roots gets both copies; repo with neither root creates `.claude/skills`; pack install expands two members with pack-member provenance; version omitted resolves latest; tarball hash mismatch; file hash mismatch; extra file on disk vs manifest paths; missing SKILL.md; collision with existing different provenance; collision with unlisted on-disk folder; reinstall same version succeeds; after install, `runCheck` on the resulting files is green except the standard flow (no fails), and `harness.json` carries the `registry:` provenance.
- [ ] **Step 2: Implement. Step 3: Green, typecheck, commit** `feat: agpm install`.

### Task 6: Remove and update

**Files:**
- Create: `src/remove.ts`, `src/update.ts`
- Test: `test/remove.test.ts`, `test/update.test.ts`

**Interfaces:**
- Produces: `runRemove(cwd: string, name: string): Promise<{ lines: string[] }>`; `runUpdate(cwd: string, name: string | undefined, client: RegistryClient): Promise<{ lines: string[] }>`.

`runRemove`: name must satisfy `isValidName` else usage-style `AgpmError` `remove takes a skill name`. If `manifest.skills[name]` absent AND the folder exists in no root: `AgpmError` `skills/<name> is not installed`. Delete the folder from every root it exists in (`rm recursive`), then recompute via `computeSync` and write. Lines: `removed skills/<name>` once.

`runUpdate`: with a name, the entry must exist and its provenance must start with `registry:` else `AgpmError` `skills/<name> has provenance "<p>"; update handles only registry: entries`. With no name, collect all `registry:` entries (skip pack-member provenance with a line `skipped skills/<name>: member of <packref>; update the pack instead` when a bare pack member is encountered; a pack itself has no entry, so v1 updates direct skill installs only). For each: parse the ref from the provenance, `getPackageInfo`, compare `latest` to the pinned version with `compareVersions`; when newer, run the same fetch-verify-place path as install (reuse by importing from `install.ts`; export the needed helper `installOneSkill` from Task 5 if not already exported) and line `updated skills/<name> <old> -> <new>`; when current, line `skills/<name> is current (<version>)`. If anything was updated, append the reminder line.

- [ ] **Step 1: Failing tests** covering every branch above, including no-argument update over a mix of registry, local, and pack-member entries.
- [ ] **Step 2: Implement. Step 3: Green, typecheck, commit** `feat: agpm remove and update`.

### Task 7: Login and logout

**Files:**
- Create: `src/login.ts`
- Test: `test/login.test.ts`

**Interfaces:**
- Produces: `runLogin(registryUrl: string, promptSecret: (msg: string) => Promise<string>, client: (token: string) => RegistryClient, homeDir: string): Promise<{ lines: string[] }>`; `runLogout(registryUrl: string, homeDir: string): Promise<{ lines: string[] }>`.
- `runLogin`: prompt text `paste a token from <registryUrl-origin>/settings/tokens: `; empty input throws `AgpmError` `no token entered`; verify with `whoami()` on a client built with the token (a 401 surfaces as the client's `registry error unauthorized: ...`); on success `writeToken` and lines `logged in to <url> as <user> (orgs: <comma list or "none">)`. The token value never appears in any line.
- `runLogout`: `deleteToken`; lines `logged out of <url>` or `no stored token for <url>`.
- The interactive `promptSecret` implementation lives in `cli.ts` (Task 8) using `node:readline/promises`; this module stays testable without a TTY.

- [ ] **Step 1: Failing tests. Step 2: Implement. Step 3: Green, typecheck, commit** `feat: agpm login and logout`.

### Task 8: Publish

**Files:**
- Create: `src/publishCmd.ts`
- Test: `test/publish.test.ts`

**Interfaces:**
- Produces: `runPublish(cwd: string, args: { folder?: string; packFile?: string; ref: string; description?: string }, client: RegistryClient): Promise<{ lines: string[] }>`.
- Skill publish: ref must include a version (`publish takes @org/name@version`). Read the folder recursively (regular files only; a symlink anywhere throws `AgpmError` `refusing symlink in <path>`); require `SKILL.md` at the folder root; description from `args.description`, else the first non-empty line of SKILL.md that does not start with `#`, trimmed; if none, `AgpmError` `no description found; pass --description`. Over 200 chars is truncated to 197 plus `...`. Build sorted `files` entries with sha256 and size, `createTarball`, manifest without `publishedAt`/`tarball.url` per the protocol publish rules (tarball sha256 and size included), `client.publish`. Line: `published <ref>`.
- Pack publish: read the JSON pack file `{ "description": string, "skills": { "@org/name": "1.2.0" } }` (strict validation, unknown keys rejected, member refs validated with `parseRegistryRef` and must carry no `@version` in the key but exact version strings as values matching `VERSION_RE`); manifest `{ name, kind: "pack", version, description, skills }`; `client.publish` without tarball. Same output line.

- [ ] **Step 1: Failing tests** including: symlink refusal, missing SKILL.md, description fallback and truncation, deterministic tarball for the same folder, pack file validation errors, correct manifest shape captured by a fake client.
- [ ] **Step 2: Implement. Step 3: Green, typecheck, commit** `feat: agpm publish`.

### Task 9: CLI wiring, docs, end-to-end stub registry

**Files:**
- Modify: `src/cli.ts`, `src/bin.ts` (only if needed), `README.md`
- Test: `test/cli-registry.test.ts`, `test/e2e-registry.test.ts`

**Interfaces:**
- `CliDeps` gains `registryFetch?: typeof fetch`, `homeDir?: string`, `promptSecret?: (msg: string) => Promise<string>`. Defaults: `fetch`, `os.homedir()`, a `node:readline/promises` prompt.
- Registry base URL: `process.env["AGPM_REGISTRY"] ?? "https://registry.baselane.sh"`, trailing slash stripped. Token resolved per command via `resolveToken`.
- New USAGE string exactly: `usage: agpm <init|sync|check|audit|list|install|remove|update|login|logout|publish>; check accepts --strict and --json; publish accepts --pack and --description`
- Argument shapes: `install <ref>`; `remove <name>`; `update [<name>]`; `login`; `logout`; `publish <folder> <ref> [--description <text>]` or `publish --pack <file> <ref>`. Anything else prints USAGE, exit 2.
- README: Quick start unchanged; new section "Install from the registry" documenting install/login/publish, the reminder line, the copy-never-symlink rule, and the replacement promise sentence from the C design spec section 1; "Not in this tool" section updated to drop "No installing. No registry server." and keep the rest.

- [ ] **Step 1: CLI unit tests** (fake deps): each new command routes and formats output; usage errors exit 2; unknown flags exit 2.
- [ ] **Step 2: End-to-end test.** `test/e2e-registry.test.ts` starts an in-memory registry on `node:http` (localhost, port 0) implementing the five protocol endpoints over a Map, then in a temp repo: `init` → `login` (promptSecret returns a token the stub accepts) → `publish` a fixture skill folder → `install` it → `check` green after committing the harness diff simulation (run `sync`, then `check`) → tamper a file, `check` fails drifted → `update` after publishing 1.0.1 → `remove` → `check` green. Assert the reminder line appears in install and update output and that no output line ever contains the token.
- [ ] **Step 3: README edits. Step 4: Full suite green, typecheck, build. Commit** `feat: registry commands in the CLI; docs`.

---

## Self-review notes

- Type names and signatures are consistent across tasks (RegistryClient produced in Task 4 and consumed in 5, 6, 7, 8, 9; `installOneSkill` export noted in Task 6).
- Every step contains the exact values, messages, and rules; no placeholders remain.
- Spec coverage: C design sections 1 through 8 all map to tasks (1: grammar Task 1; 2: refs Task 1; 3: placement Task 5; 4: commands Tasks 5 through 8; 5: provenance Task 1; 6: tar Task 2; 7: testing Tasks 4 through 9; 8: exclusions respected). Protocol spec sections 3, 5, 6, 7, 8, 9, 10 are exercised by Tasks 1 through 4 and 9.
