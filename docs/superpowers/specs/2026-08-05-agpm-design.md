# agpm v1 design

Date: 2026-08-05. Status: revised after owner review (reshape: manage and audit, never install). Next step: owner review, then implementation plan in `docs/superpowers/plans/`.

## One line

agpm (agent package manager) is the approval and audit layer for agent skills. People install skills with any tool they like. agpm records what exists, the team approves it by PR, and CI proves nothing drifts.

## The reshape (owner decision, 2026-08-05)

The first draft made agpm an installer with a lockfile, like `npm ci`. The owner cut that: vercel's `npx skills` and the vendor marketplaces already own install, and people will keep using them. agpm does not copy files. It manages and audits:

- Any installer puts skill folders in the repo.
- `agpm sync` reflects reality into harness.json and harness.lock.
- A PR that changes harness.json is the approval.
- `agpm check` in CI proves the repo matches what was approved.

harness.json therefore means "what is approved to exist", not "what to install".

## Why this product and not another

A 7-agent evidence sweep (2026-08-05) validated the idea before this spec. Verdicts:

| Assumption | Verdict | Key evidence |
|---|---|---|
| Claude Code needs an org control layer from us | BROKEN | Anthropic ships managed-settings.json, marketplace allowlist and blocklist, forced plugin enable, SHA pins (code.claude.com/docs/en/settings) |
| Nobody owns cross-tool skill install | BROKEN | vercel-labs/skills: 40.1M npm downloads in 30 days, 75+ agents, and a sha256 lockfile (verified in src/local-lock.ts). agpm therefore does NOT install |
| Nobody combines manifest + approval + audit + org policy | HOLDS | 9 tools surveyed, each has at most one piece. Timing risk: vercel issues #381 and #1176 ask for the org layer |
| Stable repo folders exist to observe | HOLDS | Codex, Cursor, Gemini CLI, and Copilot all read `.agents/skills/`; Claude Code reads `.claude/skills/`. No tool pins versions or checks integrity |
| Orgs want approval control over skills | PARTIAL | Snyk: 36.8% of 3,984 ClawHub skills had a flaw, 76 malicious. OWASP named the category (AST01). Public pull is quiet |
| Directory-scanning covers the content | HOLDS | 94% of 96 sampled packs are pure skill folders; agents and commands are also plain folders and files |
| A paid private skills registry is open space | BROKEN | JFrog Agent Skills Registry (with NVIDIA, GTC 2026), MintMCP at $1,250/mo, and free bundled answers from the platform vendors |

Conclusion: do not compete on install (vercel), do not build Claude-Code-only governance (Anthropic), do not build a registry server (JFrog). Build the one unclaimed layer: reflect what exists, approve by PR, verify in CI, across tools.

## Name

`agpm` = agent package manager. Chosen 2026-08-05 after 55 npm registry checks: every 3-letter combo and every common short word is squatted. `agpm` is free on npm, agpm.sh is free, and there is no dev-tool collision on GitHub. Rejected: baselane and reins (owner: hard to memorize), tackroom (name collision), kitbag, sklz.

## Scope

- One CLI on npm: `npm i -g agpm` or `npx agpm`. Node 20 or newer.
- Repo-level. The only cross-repo feature is the `extends` org policy field.
- agpm never installs, copies, updates, or removes a skill folder. Other tools do that.
- agpm writes exactly two files: harness.json and harness.lock. Never AGENTS.md, CLAUDE.md, GEMINI.md, settings.json, or any skill folder.
- No server, no dashboard, no accounts, no AI, no telemetry.

## What agpm observes

| Directory | Content type | Written by |
|---|---|---|
| `.claude/skills/<name>/` | skills | Claude Code installers, npx skills, hand |
| `.agents/skills/<name>/` | skills | npx skills and others (read by Codex, Cursor, Gemini CLI, Copilot) |
| `.claude/agents/*.md` | agents | hand, installers |
| `.claude/commands/*.md` | commands | hand, installers |

The same name in both skills directories with identical bytes counts as one skill. Different bytes under the same name is drift and `check` fails it.

Provenance detection, best effort: if vercel's `skills-lock.json` (or `.claude/skills-lock.json`) names the skill, `sync` records that source. A folder no lockfile explains is recorded as `"local"` if it never matched a known source, else `"unknown"`. Provenance is metadata; the hashes in harness.lock are the guarantee.

## The two files agpm owns

### harness.json (the policy; sync drafts it, humans approve it by PR)

```json
{
  "version": 1,
  "extends": "github:acme/policy@main",
  "skills": {
    "brainstorming": "github:obra/superpowers/skills/brainstorming",
    "release-checklist": "local"
  },
  "agents": {},
  "commands": {}
}
```

- Sections per content type: `skills`, `agents`, `commands`. v1 implements skills first; agents and commands use the same mechanics and follow inside v1.
- The value is the provenance string (`github:owner/repo[/path]`, `local`, or `unknown`). It is a record, not an install instruction.
- `extends` points at one org policy repo whose harness.json merges in as approved. The parent wins on a name conflict, because policy beats preference. This is the org control layer with no server.
- The file name `harness.json` is the owner's chosen term and stays.

### harness.lock (generated by sync, committed)

```json
{
  "version": 1,
  "extendsCommit": "9f31a7c0e2d14b8a6c5f3e7d9b1a4c8e6f2d0b3a",
  "skills": {
    "brainstorming": {
      "source": "github:obra/superpowers/skills/brainstorming",
      "dirs": [".claude/skills", ".agents/skills"],
      "files": { "SKILL.md": "sha256:ab12..." }
    }
  }
}
```

- One sha256 per file: the approved bytes, captured at sync time.
- `extendsCommit` pins the org policy to an exact commit, so `check` runs offline and deterministic.
- No timestamps, sorted keys, so two branches merge cleanly.

## Commands, five

| Command | Job |
|---|---|
| `agpm init` | Scan the repo, draft harness.json and harness.lock from what already exists |
| `agpm sync` | Re-scan and update both files: new folders appear, hashes refresh for entries the human re-approves, provenance recorded |
| `agpm check` | The product. CI gate: fail on drifted or missing, warn on unapproved |
| `agpm audit` | The analysis view: everything that exists, where it came from, what changed, what nobody approved |
| `agpm list` | One line per entry: ok, drifted, missing, or unlisted |

Network use: none, except `sync` resolving `extends` to a commit (one fetch of the org policy repo, with the git auth already on the machine). `check`, `audit`, `list`, and `init` never touch the network.

### check rules

- Entry in harness.json or lock but folder missing: FAIL.
- Bytes differ from the lock: FAIL.
- Folder present but not in harness.json (own or extended): WARN by default, FAIL with `--strict`.
- Same skill name in both skills directories with different bytes: FAIL.
- The soft default keeps small teams moving. `--strict` is the org mode.
- Exit codes: 0 clean, 1 violations, 2 internal error.

### sync rules (how drift gets re-approved)

- A new folder: added to harness.json and lock; the PR that carries the addition is the approval.
- A changed folder whose entry exists: `sync` refreshes the hash and marks the change in its output; the PR diff shows exactly which files changed. `check` on main before the PR merges still fails, which is the point.
- A deleted folder: `sync` removes the entry; again the PR is the record.
- `sync` never resolves a conflict silently. If harness.json says a name is `github:...` and the bytes stopped matching any known state, the entry keeps its source and the diff shows the hash change.

## Honesty rules

- Docs state plainly: `check` proves nothing changed since approval. It does not prove the approved content is safe.
- `audit` reports facts (exists, source, changed, unapproved). It does not score or judge content.
- Anything agpm cannot attribute is shown as `unknown`, never guessed.

## Tech shape

- TypeScript compiled by tsc to plain JS for npm. Node 20 or newer.
- Zero runtime dependencies: `node:crypto` for hashes, `fetch` only for `extends` resolution.
- Dev dependencies: typescript and vitest only.
- One package, small files, no monorepo.
- TDD throughout. The scanner and the `extends` fetcher sit behind small interfaces so tests run on local fixtures with no network.

## Error handling

- Fail loud. Never swallow an error.
- Broken harness.json or harness.lock: clear parse error with the file path. Never guess.
- Unreadable other-tool lockfiles (skills-lock.json): skip with a note in `audit`, never crash on them.
- `extends` fetch failure: named error with the repo and an auth hint on a 404; `check` keeps working from the pinned `extendsCommit`.

## Build plan (milestones)

- M1 Core offline: harness.json and lock formats (all three sections, `extends` field, provenance strings), directory scanner, hashing, `check`, `list`. All logic testable with fixtures. This is the product's heart and ships first.
- M2 Reflect: `init`, `sync`, provenance detection from other tools' lockfiles, `audit`.
- M3 Org and polish: `extends` resolution and pinning, `--strict`, `--json` output for CI, agents and commands sections active.
- M4 Evidence: dogfood on wrkflw and the terra-kb fleet, `check` green in at least one real CI, then npm publish 0.1.0 (publish is owner-gated).

## Success test, evidence first

The previous product died with zero users. v1's bar is usage, not features:

- agpm running in the owner's own repos within days (M1 alone makes that possible).
- `agpm check` green in at least one real CI.
- The whole first-use is two commands: `agpm init`, commit, done. If `check` ever lies, that is the highest class of bug.

## Non-goals for v1

No installing, copying, updating, or removing of skill folders. No publish and no search (sharing a skill is a git push; discovery belongs to the install tools). No registry server. No dashboard. No accounts. No hooks or MCP management. No AI features. No telemetry. No machine scope. No editing of any human-owned config file.

## Decided questions

- Manage and audit, never install (owner, 2026-08-05): install belongs to `npx skills` and the vendors; agpm reflects, approves, verifies.
- Publish and search dropped (owner, 2026-08-05): both belong to the install ecosystem agpm stepped out of.
- harness.json records provenance, does not command installs; the hashes in the lock are the guarantee.
- `extends` merges with parent-wins, pinned to a commit in the lock.
- Warn (not fail) on unlisted folders by default: adoption first, `--strict` for orgs.
