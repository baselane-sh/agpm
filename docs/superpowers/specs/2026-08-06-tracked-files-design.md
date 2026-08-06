# Tracked Files Design

Date: 2026-08-06
Status: approved
Ships as: 0.5.0

## Problem

agpm approves skills, agents, and commands, but the highest-risk contents of an
agent harness are elsewhere: hooks in `.claude/settings.json` execute arbitrary
shell commands, and instruction files (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`)
steer every agent session. Today a repo with a malicious hook passes
`agpm check` green. This feature extends the approval and audit model to
explicit file paths so those surfaces are covered.

## Decisions (approved in brainstorm)

1. Default posture: agpm warns about known sensitive files that exist but are
   untracked. `check --strict` promotes the warning to a failure. Tracking is
   an explicit user action; agpm never auto-tracks.
2. Declaration UX: `init` prompts interactively per detected candidate on a
   TTY. `agpm track <path>` and `agpm untrack <path>` are the standalone,
   CI-safe commands. Hand-editing `harness.json` then `agpm sync` also works.
3. Granularity: a tracked path is a single file or a directory (every file
   under it hashed, like a skill folder). No globs.
4. Drift semantics: drift or deletion of a tracked path is a FAIL, exactly
   like skills. Re-approval is `agpm sync` in a reviewed PR.
5. Architecture: a separate `files` section with its own module
   (`src/trackedFiles.ts`), not a fourth entry in the `Kind` union. The unit
   machinery (two-root locations, split detection, name collision rules) does
   not apply to paths and must not be bent around them.

## Out of scope for v1

- Registry distribution of tracked files (no install or publish of files).
- `extends` inheritance of the `files` section.
- Globs or pattern matching.
- Custom per-repo candidate lists.
- Any provenance other than `local`.

## Data format

### harness.json

One new optional top-level section. `version` stays 1. Keys sorted, same
deterministic serialization as the rest (sorted keys, 2-space indent,
trailing newline).

```json
{
  "version": 1,
  "skills": { "demo-skill": "local" },
  "agents": {},
  "commands": {},
  "files": {
    ".claude/settings.json": "local",
    "CLAUDE.md": "local"
  }
}
```

Provenance is always the string `local` in v1. A manifest without `files` is
valid and equivalent to an empty section. Old CLIs (0.4.x and earlier) refuse
a manifest containing `files` as an unknown key; this is accepted and the
release is a minor version bump to 0.5.0.

### harness.lock

One new optional top-level section, `files`, mapping each tracked path to an
entry. Two shapes, discriminated by which field is present:

Single file:

```json
{ "source": "local", "sha256": "sha256:<64 lowercase hex>" }
```

Directory:

```json
{ "source": "local", "files": { "<relpath>": "sha256:<64 lowercase hex>" } }
```

Directory `files` maps paths relative to the tracked directory, forward
slashes, sorted keys. An entry has exactly one of `sha256` or `files`; a lock
entry with both or neither is invalid and refused at parse time.

### Path rules

A tracked path must be:

- repo-relative with forward slashes (no leading `/`, no drive letters)
- free of `.` and `..` segments
- not empty and not `.`
- not inside a managed root: `.claude/skills`, `.agents/skills`,
  `.claude/agents`, `.claude/commands` (and not one of those roots itself)
- not a symlink, and (for directories) containing no symlinks

Paths are compared as exact strings. `track` normalizes a trailing slash off
directory arguments before storing.

## Module layout

- `src/trackedFiles.ts` (new): scanning and comparison.
  - `scanTrackedFiles(root, declared: Record<string, string>)`: for each
    declared path, lstat; refuse symlinks; hash a file with `sha256`, a
    directory with `hashDir`; missing paths are reported, not thrown.
  - `checkTrackedFiles(declared, lockFiles, scan)`: pure function returning
    `Finding[]`.
  - `candidateWarnings(root)`: scans the built-in candidate list and returns
    warn findings for untracked matches.
- `src/types.ts`: `Manifest.files?: Record<string, string>`;
  `Lock.files?: Record<string, LockFileEntry>`;
  `LockFileEntry = { source: string; sha256?: string; files?: Record<string, string> }`;
  `Finding.kind` widens to `Kind | "extends" | "files"`.
- `src/manifest.ts`, `src/lock.ts`: parse and serialize the new sections with
  the existing null-prototype and validation conventions.
- `src/check.ts`: `runCheck` stays pure. It gains a parameter carrying the
  tracked-file scan and the candidate warnings; `src/cli.ts` produces both
  (they need fs access) and passes them in. `runCheck` merges the findings
  into the report. Strict promotion applies unchanged.
- `src/sync.ts`: re-hashes drifted tracked paths and hashes newly declared
  ones; reports `updated files/<path>` and `added files/<path>` change lines.
- `src/track.ts` (new): `runTrack(cwd, path)` and `runUntrack(cwd, path)`.
- `src/cli.ts`: wires `track` and `untrack`, adds the init prompt, extends
  USAGE.
- `src/list.ts`, `src/audit.ts`: render `files` rows with the existing
  columns; provenance is `local`; audit shows the path itself in the location
  column.

## Findings and messages

`kind` is `files`, `name` is the tracked path. Existing codes are reused:

| code | level | condition | message |
| --- | --- | --- | --- |
| `drifted` | fail | bytes differ from lock | `files/<path> bytes differ from the approved hashes` |
| `missing` | fail | declared in harness.json, absent on disk | `files/<path> is approved in harness.json but missing on disk` |
| `unsynced` | fail | in harness.json, no lock entry | `files/<path> is approved but not hashed; run agpm sync` |
| `unlisted` | warn | candidate exists, not tracked | see candidate list below |

`check --json` carries these findings with the same shape as today.

## Candidate warn list (built in, v1)

- `CLAUDE.md`
- `AGENTS.md`
- `.mcp.json`
- `.claude/settings.json`, only when the file parses as JSON with a top-level
  `hooks` key, or when it does not parse as JSON at all

Warning messages:

- `.claude/settings.json contains hooks but nobody tracks it in harness.json; run agpm track .claude/settings.json`
- for the others: `<path> exists on disk but nobody tracks it in harness.json; run agpm track <path>`

Candidates already present in `manifest.files` produce no warning.

## Commands

### agpm track \<path\>

1. Validate the path (rules above). Refusals, all `AgpmError` exit 2:
   - `no such file: <path>`
   - `refusing symlink at <path>`
   - `<path> is inside a managed root; skills, agents, and commands are tracked automatically`
   - `<path> is already tracked`
   - `tracked paths must be repo-relative`
2. Hash the file or directory, add to `harness.json` and `harness.lock`,
   write both deterministically.
3. Print `tracked <path>`. Exit 0.

### agpm untrack \<path\>

Remove the path from both files and print `untracked <path>`. Unknown path:
`<path> is not tracked`, exit 2.

### agpm init (extended)

After the normal scan, when stdin is a TTY: for each candidate found, ask
`track <path>? [y/N] ` with a plain line read (not masked). Answer `y` or
`yes` (case-insensitive) tracks the path; anything else skips it. When stdin
is not a TTY, no prompt: the candidates surface as the standard warn notes.
The prompt function enters `CliDeps` (like `promptSecret`) so tests inject it.

### agpm sync (extended)

Never prompts. Re-approves drifted tracked paths, hashes newly declared ones,
drops lock entries whose manifest entry was removed. Change lines use the
existing verbs: `added files/<path>`, `updated files/<path>`,
`removed files/<path>`.

### USAGE

`usage: agpm <init|sync|check|audit|list|install|remove|update|track|untrack|login|logout|publish>; check accepts --strict and --json; publish accepts --pack and --description`

## Testing

TDD throughout, vitest, existing helpers.

- `trackedFiles.test.ts`: path validation table (absolute, `..`, managed
  roots, symlink, missing); file vs directory hashing; all four finding
  codes; candidate detection including the hooks-key condition and the
  invalid-JSON condition.
- `manifest.test.ts`, `lock.test.ts` additions: round-trip with `files`
  sections; refusal of a lock entry with both or neither of
  `sha256`/`files`.
- `track.test.ts`: track and untrack happy paths and every refusal message.
- `cli.test.ts` additions: init prompt via injected confirm (yes, no,
  non-TTY); usage line; exit codes.
- `check.test.ts` additions: strict promotion of the candidate warning.
- End-to-end: track `.claude/settings.json`, edit a hook, `check` exits 1
  with `drifted`, `sync`, `check` exits 0. Delete the file, `check` exits 1
  with `missing`.

## Global constraints (carry into the plan)

- Zero runtime dependencies; strict TypeScript; NodeNext; ESM `.js` imports.
- Null-prototype records with `Object.create(null)` and `Object.hasOwn`.
- Deterministic JSON output: sorted keys, 2-space indent, trailing newline.
- `AgpmError` for user-facing errors; exit codes 0/1/2; no `console.log` in
  `src/`.
- No em-dashes in any user-facing text.
- Exactly two files written in the repo root: `harness.json`, `harness.lock`.
