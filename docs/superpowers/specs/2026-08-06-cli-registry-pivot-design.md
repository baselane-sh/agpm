# agpm CLI registry pivot design (sub-project C)

The agpm CLI becomes a package manager client of the baselane registry protocol v1
(see 2026-08-06-registry-protocol-design.md, "the protocol spec"). This spec fixes the
command surface, the placement rules, and the boundaries. Date: 2026-08-06.

## 1. What is added, what is untouched

New commands: `install`, `remove`, `update`, `login`, `logout`, `publish`.
Untouched: `init`, `sync`, `check`, `audit`, `list` keep their exact behavior, output, and
offline guarantees. Exit codes stay 0 (clean), 1 (violations), 2 (internal or usage error).
Zero runtime dependencies stays a hard rule: raw `fetch`, `node:zlib` for gzip, a small
hand-rolled ustar reader and writer for tarballs.

The promise rewrite: "agpm never installs" leaves the README. The replacement sentence is:
"agpm installs, but never approves: the PR that changes harness.json is still the only
approval, and check in CI is still the proof."

## 2. References the CLI accepts

- `@org/name` (resolves to the latest version at install time, then pins exactly)
- `@org/name@1.2.0` (exact)

Git sources stay the job of other installers (`npx skills`); agpm keeps reading
`skills-lock.json` for their provenance. agpm does not fetch skills from git in v1.
The registry base URL defaults to `https://registry.baselane.sh` and can be overridden
with the `AGPM_REGISTRY` environment variable (useful for tests and self-hosted registries).

## 3. Placement rules

- Only `kind: skill` packages (and packs, which expand to skills) are installable. Agents
  and commands are not registry artifacts in v1.
- The installed folder name is the `name` part of `@org/name`.
- Copy, never symlink. Files are written with the bytes the registry manifest hashed.
- Target roots: agpm installs into every skill root that already exists in the repo
  (`.claude/skills/`, `.agents/skills/`). If none exists, it creates and uses
  `.claude/skills/`. This matches the existing cross-root consistency check: identical
  bytes in every root, and `check` flags divergence.
- Collision rule: if the target folder exists and the manifest records a different
  provenance (or none), install refuses with exit 2 and names the folder. `--force` is not
  offered in v1; the user removes first.

## 4. What each command does

### install `agpm install <ref>`
1. Resolve `<ref>` via the registry (package info for latest, then the version manifest).
2. If the package is a pack: fetch each member's version manifest; members install like
   individual skills below; the pack itself writes no files.
3. Download the tarball (token only to the registry origin, per the protocol spec),
   verify `tarball.sha256`, extract with the strict profile (section 6), verify every
   `files[].sha256`.
4. Copy into every target root.
5. Record in `harness.json`: entry `skills/<name>` with provenance
   `registry:@org/name@1.2.0` (member of a pack:
   `registry:@org/pack@3.0.0/@org/name@1.2.0`), and per-file sha256 in `harness.lock`,
   using the same write path sync uses (deterministic, sorted, trailing newline).
6. Print the entries written and this exact reminder line:
   `install is not approval; commit the harness diff and approve it by PR`.

### remove `agpm remove <name>`
Deletes `skills/<name>` from every root it exists in, then rewrites both harness files the
way sync would. Works for any provenance. Missing name is exit 2.

### update `agpm update [<name>]`
Only entries whose provenance starts with `registry:` are updatable. With no argument,
updates all such entries. Re-resolves latest, and if newer: replaces files and re-records.
Same reminder line as install. A name with non-registry provenance is exit 2.

### login `agpm login`
Prints the dashboard token URL, prompts for a pasted token on stdin, calls `whoami`, and on
success writes `~/.agpm/credentials` (mode 600) keyed by registry URL. Prints the user and
orgs. Never echoes the token. `agpm logout` deletes that registry's entry.

### publish
- Skill: `agpm publish <folder> @org/name@1.2.0` packs the folder (strict tar profile),
  computes hashes, builds the version manifest (description comes from the first
  markdown H1 paragraph line of SKILL.md or `--description`), and PUTs it.
- Pack: `agpm publish --pack <file> @org/name@1.2.0` where the file is JSON
  `{ "description": "...", "skills": { "@org/a": "1.0.0" } }`.
Requires a token; 201 prints the published reference.

## 5. Provenance grammar change

`harness.json` provenance values today: `local` or `github:owner/repo`. Added:
`registry:<ref>` and `registry:<packref>/<ref>` where `<ref>` is `@org/name@version`
validated by the protocol spec's name and version rules. `check`, `audit`, and `list`
display it but never fetch anything: offline behavior is unchanged.

## 6. Strict tarball profile

agpm writes and accepts only: plain ustar, regular files and directories, UTF-8 relative
paths with forward slashes, no pax or GNU extensions, no symlinks or special entries, no
`..` or absolute paths, at most 1000 files, 10 MiB compressed, 25 MiB extracted. Anything
else is `invalid_package`, exit 2. The registry server enforces the same profile, so the
reader only ever meets what the writer produces; hostile tarballs are rejected, not
tolerated.

## 7. Testing boundaries

Every network call goes through an injectable fetcher on the existing `CliDeps` pattern
(like `extendsFetcher`). Unit tests stub it. One end-to-end test runs a stub registry on
`node:http` on a random localhost port, with `AGPM_REGISTRY` pointing at it, and exercises
login, publish, install, update, remove, and the check loop after each.

## 8. Not in sub-project C

No search. No git-source installs. No global or machine installs. No `--force`. No
interactive prompts except the login token paste. No backend code (sub-project B). No
dashboard (D). No landing page (E). No changes to extends.
