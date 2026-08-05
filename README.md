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

agpm observes `.claude/skills/`, `.agents/skills/`, `.claude/agents/*.md`, and `.claude/commands/*.md`. Provenance is read, best effort, from `skills-lock.json` when another tool wrote one; anything unexplained is recorded as `local`, never guessed. A folder whose name agpm cannot record (it must start with a letter or digit and use only letters, digits, dot, dash, underscore) makes `init` and `sync` stop with an error until it is renamed; `check`, `audit`, and `list` still report it.

## What check proves, honestly

`check` proves nothing changed since a human approved it. It does not prove the approved content is safe. `audit` reports facts; it does not score or judge content. Provenance agpm cannot explain from a lockfile is recorded as `local`, not guessed. `audit` shows `(unapproved)` for anything on disk that `harness.json` does not list.

## Not in this tool

No installing. No registry server. No dashboard. No accounts. No AI. No telemetry. No editing of AGENTS.md, CLAUDE.md, settings files, or any skill folder. agpm writes exactly two files: `harness.json` and `harness.lock`.
