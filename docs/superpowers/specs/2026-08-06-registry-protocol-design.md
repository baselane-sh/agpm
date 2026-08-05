# baselane registry protocol v1

Sub-project A of the agpm platform pivot. This document is the contract between three
implementations that ship separately: the agpm CLI (client), the Supabase backend (server),
and the baselane dashboard (publisher UI). Each side builds against this document, not
against each other's code.

Status: draft for review. Owner: baselane. Date: 2026-08-06.

## 1. Purpose

One org publishes agent skills once; every repo and every teammate installs them by name,
publicly or behind a login. The registry stores immutable, versioned packages and serves
them over five HTTP endpoints. agpm remains the approval and audit layer: installing from
the registry never approves anything. The PR that changes `harness.json` is the approval,
and `agpm check` in CI stays the proof.

## 2. Design rules

1. **Backend-agnostic.** Nothing in this protocol names Supabase. Any server that speaks
   these endpoints is a valid registry. The client uses raw `fetch`, zero dependencies.
2. **Exact pins only.** Every reference to a version is an exact semver string. No ranges,
   no tags in manifests. `latest` exists only as an API convenience for resolution.
3. **Immutable versions.** A published version never changes and never disappears in v1.
   Republishing an existing version is an error.
4. **Private means invisible.** A request without a valid token for a private package gets
   404, never 403, so private names do not leak.
5. **Per-file hashes are the integrity root.** The same sha256 values flow from the publish
   manifest through install verification into `harness.lock`.
6. **Merge-friendly, deterministic output** (inspired by the `npx skills` lockfile): JSON
   the client writes is sorted by key, timestamp-free, 2-space indented, trailing newline.
   Timestamps live only on the server.
7. **Boring by default.** Anything not needed by the first real client stays out (section 12).

## 3. Names and versions

- A package name is `@org/name`, for example `@baselane/tdd-cycle`.
- `org`: 1 to 39 characters, lowercase letters, digits, and dash, must start and end with a
  letter or digit. Orgs are created in the baselane dashboard.
- `name`: must match agpm's existing name rule: starts with a letter or digit, then letters,
  digits, dot, dash, underscore. Maximum 100 characters.
- `version`: exact semver `MAJOR.MINOR.PATCH`, matching `^\d+\.\d+\.\d+$`. No prerelease or
  build suffixes in v1.
- A full reference is `@org/name@version`, for example `@baselane/tdd-cycle@1.2.0`.

## 4. Artifact kinds

- **`skill`**: one skill folder. `SKILL.md` at the package root plus support files.
- **`pack`**: a manifest-only artifact that lists member skills as exact references,
  like `dependencies` in package.json. Installing a pack installs its members. A pack
  cannot contain packs; the server rejects a pack whose member is a pack (same one-level
  rule agpm applies to `extends`).

## 5. Package format

### 5.1 The tarball (kind: skill)

A gzipped tar of the skill folder contents. `SKILL.md` sits at the tarball root, not inside
a wrapper directory. Rules, enforced at publish time by the server and again at install
time by the client:

- All paths are relative. Entries containing `..`, absolute paths, or a leading `/` are rejected.
- No symlinks, no hardlinks, no special files. Regular files and directories only.
- Limits (same defaults as the `npx skills` CLI, which field use has validated):
  tarball at most 10 MiB, extracted content at most 25 MiB, at most 1000 files.

### 5.2 The version manifest

The server serves one JSON document per published version:

```json
{
  "name": "@baselane/tdd-cycle",
  "kind": "skill",
  "version": "1.2.0",
  "description": "Red, green, refactor loop for agents",
  "files": [
    { "path": "SKILL.md", "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "size": 1834 }
  ],
  "tarball": {
    "url": "https://registry.baselane.sh/v1/tarballs/1f5c...e2a9.tgz",
    "sha256": "1f5c0a4e0b8d9c7f6a5e4d3c2b1a09f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2",
    "size": 4096
  },
  "publishedAt": "2026-08-06T00:00:00Z"
}
```

For `kind: "pack"` the `files` and `tarball` fields are absent and one field is added:

```json
{
  "name": "@acme/frontend-baseline",
  "kind": "pack",
  "version": "3.0.0",
  "description": "Everything a frontend repo at acme uses",
  "skills": {
    "@acme/design-review": "1.4.0",
    "@baselane/tdd-cycle": "1.2.0"
  },
  "publishedAt": "2026-08-06T00:00:00Z"
}
```

- `files[].path` uses forward slashes, sorted lexicographically.
- `description` is required, plain text, at most 200 characters, no newlines.
- The `tarball.url` is opaque to the client. It may be a signed URL. The client follows it
  as given and never constructs tarball paths itself.
- The client sends the `Authorization` header only to URLs whose origin equals the registry
  base URL's origin. A tarball URL on any other origin (a storage CDN) is fetched without
  the token; access control there is the signed URL's job. This rule prevents token leaks
  to third-party hosts.

## 6. Endpoints

All endpoints are relative to a registry base URL. The default registry is
`https://registry.baselane.sh`. All responses are JSON except the tarball bytes.

| Method and path | Job | Auth |
|---|---|---|
| `GET /v1/packages/@{org}/{name}` | Package info: `{ "name", "kind", "latest", "versions": ["1.0.0", "1.2.0"] }` | Only for private packages |
| `GET /v1/packages/@{org}/{name}/{version}` | The version manifest (section 5.2) | Only for private packages |
| `GET {tarball.url}` | The tarball bytes | Only for private packages |
| `PUT /v1/packages/@{org}/{name}/{version}` | Publish (section 8) | Always |
| `GET /v1/whoami` | `{ "user": "mohammad", "orgs": [{ "org": "baselane", "role": "owner" }] }` | Always |

`versions` is sorted ascending by semver order. `latest` is the highest version.

## 7. Auth

- One mechanism: the `Authorization: Bearer <token>` header.
- Public packages are readable with no token.
- Token sources for the client, in order of precedence:
  1. `AGPM_TOKEN` environment variable (CI and scripts).
  2. `~/.agpm/credentials`, a JSON file mapping registry base URL to token, written by
     `agpm login` with mode 600. Example:
     `{ "registries": { "https://registry.baselane.sh": { "token": "..." } } }`
- How tokens are minted (Supabase session exchange, a personal access token page in the
  dashboard) is a backend and dashboard concern. The protocol only defines how a token is
  presented. Tokens are opaque strings to the client.
- The client never prints a token, never writes it into any file other than
  `~/.agpm/credentials`, and redacts it from error output.

## 8. Publishing

`PUT /v1/packages/@{org}/{name}/{version}` with `Content-Type: multipart/form-data`:

- field `manifest`: the version manifest JSON, without `publishedAt` and without
  `tarball.url` (the server assigns both).
- field `tarball` (kind skill only): the gzipped tar bytes.

Server obligations before accepting:

1. Token is valid and the user has the publisher role or higher in `org`.
2. Name, version, and description satisfy section 3 and 5.2 rules.
3. The version does not already exist (else 409 `version_exists`).
4. The tarball satisfies section 5.1 limits and path rules.
5. Every `files[].sha256` matches the actual extracted bytes, and `tarball.sha256`
   matches the uploaded bytes.
6. For packs: every member reference exists in the registry and is a skill, and the
   publishing user can read it (a private member in someone else's org is rejected as
   `not_found`, rule 4 of section 2).

On success: 201 with the final version manifest as stored.

Whether a package is public or private is a property of the package, chosen at first
publish and managed in the dashboard, not per version.

## 9. Errors

Every non-2xx response carries:

```json
{ "error": { "code": "version_exists", "message": "1.2.0 was already published" } }
```

| HTTP | code |
|---|---|
| 400 | `invalid_package`, `invalid_request` |
| 401 | `unauthorized` (missing or bad token where one is required) |
| 404 | `not_found` (also the answer for private things without access) |
| 409 | `version_exists` |
| 413 | `too_large` |
| 429 | `rate_limited` |

The client maps any registry error to agpm's existing exit 2 and shows `code: message`.
`message` never echoes the token or any file contents.

## 10. How installs land in agpm's files

Defined fully in the sub-project C spec; the protocol fixes only the provenance vocabulary:

- A skill installed from the registry is recorded in `harness.json` with provenance
  `registry:@org/name@1.2.0`.
- A skill installed as a member of a pack records the pack too:
  `registry:@acme/frontend-baseline@3.0.0/@acme/design-review@1.4.0`.
- Git installs keep the existing `github:owner/repo` vocabulary.
- `harness.lock` keeps per-file sha256 exactly as today; the values must equal the
  registry manifest's `files[].sha256` at install time. `agpm check` needs no network
  and no knowledge of this protocol.

Installing never edits approval state. `check` fails or warns on the new folders until the
PR carrying the harness diff merges. Registry installs always copy files; agpm never
creates symlinks (the `npx skills` symlink default is incompatible with hash-based
approval, because a symlink can retarget after the PR merges).

## 11. Inspirations taken from the npx skills CLI

Adopted: the size and file-count limits (section 5.1), the merge-friendly timestamp-free
client-side JSON (section 2 rule 6), copy-not-symlink placement for team repos, and its
per-agent placement table (Claude Code `.claude/skills/`, Codex and Antigravity
`.agents/skills/`) as the starting adapter list for sub-project C. Rejected: symlink
installs, hash-per-folder (we keep hash-per-file), and installing without any approval
gate.

## 12. Not in v1, deliberately

No search endpoint (the dashboard browses; the CLI installs by name). No version ranges or
prerelease versions. No delete or yank endpoint (dashboard-only yank can come in v2 with a
`yanked` flag in package info). No signatures beyond sha256 (sigstore is a v2 candidate).
No scoped read tokens (a token reads everything its user can read). No mirror or proxy
protocol. No policy artifact kind (org policy stays agpm `extends`). No machine targets,
no managed regions, no capabilities (retired with the old baselane stack).

## 13. Compatibility promise

`/v1` responses only gain optional fields within v1; required fields never change meaning.
Clients must ignore unknown fields in responses. Breaking changes require `/v2` endpoints,
and `/v1` keeps serving existing published versions.
