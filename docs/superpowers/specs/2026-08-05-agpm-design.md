# agpm v1 design

Date: 2026-08-05. Status: approved by owner. Next step: implementation plan in `docs/superpowers/plans/`.

## One line

agpm (agent package manager) is `package.json` plus `npm ci` for agent skills. The team writes the approved list. CI proves every repo matches it.

## Why this product and not another

A 7-agent evidence sweep (2026-08-05) validated the idea before this spec. Verdicts:

| Assumption | Verdict | Key evidence |
|---|---|---|
| Claude Code needs an org control layer from us | BROKEN | Anthropic ships managed-settings.json, marketplace allowlist and blocklist, forced plugin enable, SHA pins (code.claude.com/docs/en/settings) |
| Nobody owns cross-tool skill install | BROKEN | vercel-labs/skills: 40.1M npm downloads in 30 days, 75+ agents, and a sha256 lockfile (verified in src/local-lock.ts) |
| Nobody combines manifest + lock + approval + private registry | HOLDS | 9 tools surveyed, each has at most one piece. Timing risk: vercel issues #381 and #1176 ask for the org layer |
| Stable repo folders exist to install into | HOLDS | Codex, Cursor, Gemini CLI, and Copilot all read `.agents/skills/`. No tool pins versions or checks integrity |
| Orgs want approval control over skills | PARTIAL | Snyk: 36.8% of 3,984 ClawHub skills had a flaw, 76 malicious. OWASP named the category (AST01). Public pull is quiet |
| Directory-only install is enough | HOLDS | 94% of 96 sampled packs are pure skill folders. The 6% are hook packs, which agpm refuses honestly |
| A paid private skills registry is open space | BROKEN | JFrog Agent Skills Registry (with NVIDIA, GTC 2026), MintMCP at $1,250/mo, and free bundled answers from the platform vendors |

Conclusion: do not compete on install (vercel), do not build Claude-Code-only governance (Anthropic), do not build a registry server (JFrog). Build the one unclaimed layer: hand-written policy + content-hash lock + CI verification, cross-tool.

## Name

`agpm` = agent package manager. Chosen 2026-08-05 after 55 npm registry checks: every 3-letter combo and every common short word is squatted. `agpm` is free on npm, agpm.sh is free, and there is no dev-tool collision on GitHub. Rejected: baselane and reins (owner: hard to memorize), tackroom (name collision), kitbag, sklz.

## Scope

- One CLI on npm: `npm i -g agpm` or `npx agpm`. Node 20 or newer.
- Repo-level only. No server, no dashboard, no accounts, no AI, no telemetry.
- v1 manages skills only (SKILL.md folders). Not hooks, not MCP, not agents/commands, not settings.
- agpm never writes AGENTS.md, CLAUDE.md, GEMINI.md, or settings.json.

## The three artifacts

### harness.json (the policy, written by hand, reviewed by PR)

```json
{
  "version": 1,
  "skills": {
    "brainstorming": "github:obra/superpowers/skills/brainstorming@v6.2.0",
    "api-conventions": "github:acme/eng-skills/api-conventions@main"
  }
}
```

- Name maps to source. Source = `github:owner/repo[/path]@ref` where ref is a tag, branch, or SHA.
- A private repo uses the same syntax with the git auth already on the machine. That is the private registry in v1.
- The file name `harness.json` is the owner's chosen term and stays.

### harness.lock (generated, committed)

```json
{
  "version": 1,
  "skills": {
    "brainstorming": {
      "source": "github:obra/superpowers/skills/brainstorming@v6.2.0",
      "commit": "9f31a7c0e2d14b8a6c5f3e7d9b1a4c8e6f2d0b3a",
      "files": { "SKILL.md": "sha256:ab12..." }
    }
  }
}
```

- Exact commit plus one sha256 per file.
- No timestamps, sorted keys, so two branches adding different skills merge cleanly.

### The skill folders (vendored, committed)

agpm writes real files into the repo and the team commits them. Teammates get skills through `git clone` alone. Install runs only when harness.json changes, never on clone.

## Where files go

| Directory | Read by |
|---|---|
| `.agents/skills/<name>/` | Codex, Cursor, Gemini CLI, GitHub Copilot |
| `.claude/skills/<name>/` | Claude Code (its docs mention this path 70 times, `.agents/skills` zero) |

Default: identical copies in both directories, both verified by `check`.

Known leak, accepted: Cursor and Copilot also read `.claude/skills/`, so a tool may see a skill twice. Same name, same bytes, low harm. Approval is per-repo, not per-tool; per-tool isolation cannot be guaranteed in this ecosystem.

## Commands, six and no more

| Command | Job |
|---|---|
| `agpm add <source>` | Fetch, resolve ref to a commit, write folders, update harness.json and lock |
| `agpm install` | Make the folders match the lock exactly, like `npm ci` |
| `agpm check` | The product. CI gate: fail on changed or missing skills, warn on unapproved |
| `agpm update [name]` | Re-resolve moving refs, rewrite the lock. The PR that carries it is the approval step |
| `agpm remove <name>` | Delete folders and both entries |
| `agpm list` | Show each skill: ok, drifted, missing, or unlisted |

Only `add` and `update` touch the network. Everything else works offline from the lock.

### check rules

- Skill in lock but folder missing: FAIL.
- Bytes differ from the lock: FAIL.
- Folder present but not in harness.json: WARN by default, FAIL with `--strict`.
- The soft default keeps hand-written local skills usable on small teams. `--strict` is the org mode.
- Exit codes: 0 clean, 1 violations, 2 internal error.

## Refusals, stated honestly

- A source that contains hooks.json, settings fragments, or .mcp.json: refuse with a clear message ("this pack needs hook wiring; agpm installs skill folders only"). Never install a dead folder. This catches the 6%: superpowers' SessionStart hook, impeccable, protect-mcp.
- No SKILL.md at the source path: refuse and list the skill subfolders that were found.
- Docs state plainly: `check` proves nothing changed since approval. It does not prove the approved content is safe.

## Tech shape

- TypeScript compiled by tsc to plain JS for npm. Node 20 or newer.
- Zero runtime dependencies: GitHub REST over `fetch`, `node:crypto` for hashes.
- Dev dependencies: typescript and vitest only.
- One package, small files, no monorepo.
- TDD throughout. The fetcher sits behind a small interface so tests run on local fixtures with no network.

## Error handling

- Fail loud. Never swallow an error.
- Writes go to a temp dir first, then move per skill, so a failed fetch never leaves half a skill on disk.
- Broken harness.json or harness.lock: clear parse error with the file path. Never guess.
- Network errors name the source that failed and the auth hint if it was a 404 on a private repo.

## Build plan (milestones)

- M1 Core, offline: manifest parse and validate, lock format, tree hashing, `check`, `list`. All logic testable with fixtures. This is the product's heart and ships first.
- M2 Network: GitHub fetcher behind an interface, `add`, `install`, ref resolution, refusal rules.
- M3 Lifecycle: `update`, `remove`, `--strict`, clean error surfaces, `--json` output for CI.
- M4 Evidence: dogfood on wrkflw and the terra-kb fleet, `check` green in one real CI, then npm publish 0.1.0 (publish is owner-gated).

## Success test, evidence first

The previous product died with zero users. v1's bar is usage, not features:

- agpm running in the owner's own repos within days.
- `agpm check` green in at least one real CI.
- Adding a skill takes one command. If `check` ever lies, that is the highest class of bug.

## Non-goals for v1

No registry server. No dashboard. No accounts. No hooks, MCP, agents, or commands management. No AI features. No telemetry. No global or machine scope (repo scope only). No editing of any human-owned config file.

## Decided questions

- Own fetcher, not a wrapper around `npx skills`: their lockfile is an internal format that changes weekly; our GitHub REST fetcher is small and stable.
- Vendored, committed skills, not install-on-clone: clone-and-go for teammates, and CI can verify bytes on every PR.
- Warn (not fail) on unlisted local skills by default: adoption first, `--strict` for orgs.
