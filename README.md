# agpm

The approval and audit layer for agent skills. By baselane.

People install skills with any tool they like: `npx skills`, marketplaces, git, agpm itself, or by hand. agpm installs, but never approves: the PR that changes harness.json is still the only approval, and check in CI is still the proof.

1. `agpm sync` reflects what exists on disk into two files: `harness.json` (what is approved to exist) and `harness.lock` (a sha256 per file).
2. A pull request that changes `harness.json` is the approval.
3. `agpm check` in CI proves the repo still matches what was approved.

## Quick start

Published on npm as [`@baselane/agpm`](https://www.npmjs.com/package/@baselane/agpm); the command is `agpm`:

    npx @baselane/agpm init     # scan the repo, draft both files
    git add harness.json harness.lock && git commit
    npx @baselane/agpm check    # exit 0: clean, 1: violations, 2: internal error

Or install it once with `npm install -g @baselane/agpm` and use `agpm` directly. Node 18 or newer.

## Commands

| Command | Job |
|---|---|
| `agpm init`  | Scan the repo, draft harness.json and harness.lock from what already exists |
| `agpm sync`  | Re-scan and update both files; the PR carrying the diff is the approval |
| `agpm check` | CI gate: FAIL on drifted or missing, WARN on unapproved; --strict fails unapproved too, --json prints one JSON document |
| `agpm audit` | Facts view: everything that exists, where it came from, what changed |
| `agpm list`  | One line per entry: ok, drifted, missing, or unlisted |
| `agpm install <ref>` | Install `@org/name` or `@org/name@version` from the registry into every existing skill root |
| `agpm remove <name>` | Delete an installed skill and drop its harness.json/harness.lock entries |
| `agpm update [<name>]` | Refresh registry-provenance skills to their latest published version; no name updates all |
| `agpm login` | Paste a registry token, verify it, and store it in `~/.agpm/credentials` |
| `agpm logout` | Delete the stored token for the current registry |
| `agpm publish <folder> <ref>` | Pack a skill folder (or `--pack <file>` for a pack manifest) and publish it to the registry |

agpm observes `.claude/skills/`, `.agents/skills/`, `.claude/agents/*.md`, and `.claude/commands/*.md`. Provenance is read, best effort, from `skills-lock.json` when another tool wrote one; anything unexplained is recorded as `local`, never guessed. A folder whose name agpm cannot record (it must start with a letter or digit and use only letters, digits, dot, dash, underscore) is skipped by `init` and `sync` with a note and stays unapproved; `check`, `audit`, and `list` still report it.

## Install from the registry

agpm installs, but never approves: the PR that changes harness.json is still the only approval, and check in CI is still the proof.

    agpm login                              # paste a token, stored in ~/.agpm/credentials
    agpm install @baselane/tdd-cycle        # latest version, into every existing skill root
    agpm install @baselane/tdd-cycle@1.2.0  # exact version

Every `install` and `update` prints this reminder:

    install is not approval; commit the harness diff and approve it by PR

Installed files are copied, never symlinked: the bytes agpm writes are the exact bytes the registry manifest hashed, and `agpm check` verifies those hashes stay put. `agpm remove <name>` deletes an installed skill and its harness entries; `agpm update [<name>]` re-resolves and replaces a registry-provenance skill with its latest published version.

Publishing needs a token: `agpm publish <folder> @org/name@1.2.0` packs a skill folder (description comes from the first line of `SKILL.md` or `--description "..."`); `agpm publish --pack <file> @org/name@1.2.0` publishes a pack manifest (`{ "description": "...", "skills": { "@org/a": "1.0.0" } }`). Add `--public` on the first publish to make the package public; without it the package starts private.

The registry base URL defaults to `https://registry.baselane.sh`; override it with the `AGPM_REGISTRY` environment variable. Tokens resolve from the `AGPM_TOKEN` environment variable first, then `~/.agpm/credentials` (written by `agpm login`, mode 600). A token is never printed or written anywhere else.

## Org policy with extends

One org policy repo can approve skills for every repo that points at it:

    { "version": 1, "extends": "github:acme/policy@main", "skills": {} }

`agpm sync` resolves the ref to a commit, reads the policy repo's harness.json at that commit, and pins the extends value itself alongside the resolved commit and parent manifest into harness.lock (`extends`, `extendsCommit`, `extendsManifest`). `check`, `audit`, and `list` work offline from the pin. A folder the policy manifest lists is approved; the policy wins over the local entry when both name the same unit. Only `sync` touches the network. Private policy repos work when `GITHUB_TOKEN` (or `GH_TOKEN`) is set. A policy repo that itself extends another repo is refused.

If harness.json and harness.lock disagree about extends (removed, added, or changed without running sync), `check` fails offline with a FAIL extends finding and stops treating the stale pin as approval. Run `agpm sync` and approve the diff by PR to clear it.

## What check proves, honestly

`check` proves nothing changed since a human approved it. It does not prove the approved content is safe. `audit` reports facts; it does not score or judge content. Provenance agpm cannot explain from a lockfile is recorded as `local`, not guessed. `audit` shows `(unapproved)` for anything on disk that `harness.json` does not list. Parent approvals from extends suppress only the unapproved warning; the sha256 hashes in the local harness.lock stay the only integrity guarantee.

## Not in this tool

No dashboard. No accounts. No AI. No telemetry. No editing of AGENTS.md, CLAUDE.md, settings files, or any skill folder. agpm writes exactly two files: `harness.json` and `harness.lock`.
