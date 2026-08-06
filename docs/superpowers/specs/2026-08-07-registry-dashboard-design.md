# baselane registry backend and dashboard (sub-projects B and D)

One Next.js app that implements the registry protocol v1
(`docs/superpowers/specs/2026-08-06-registry-protocol-design.md`) and the dashboard UI on
top of Supabase. The user chose to build B and D together as one app, in one new repo.

Status: approved design. Owner: baselane. Date: 2026-08-07.

## 1. Purpose and success criterion

Give the registry protocol a real server and give humans a UI for accounts, orgs, tokens,
package browsing, package settings, and activity. Publishing stays in the agpm CLI.

Success criterion: a script runs the published agpm CLI against a local dev instance and
completes `agpm login`, `agpm publish`, `agpm install`, and `agpm check` green, for both a
public and a private package.

## 2. Decisions (fixed)

1. Repo: new repo `baselane-sh/registry`. The agpm repo stays a zero-dependency CLI repo.
   The protocol spec doc is the contract between the two repos.
2. Stack: Next.js App Router on Vercel at `registry.baselane.sh`. Supabase provides
   Postgres, Auth, and Storage. TypeScript strict, vitest, Playwright.
3. Sign in: GitHub OAuth and email magic link, both via Supabase Auth.
4. Access control: hybrid. `/v1` API routes use the service-role client with explicit
   checks in code. Dashboard pages use the user session with RLS as a second layer.
   Browser writes go through server actions, never direct table writes.
5. V1 scope: core account flow, package browse and detail, package settings
   (visibility, yank), and a thin usage and activity view (plain tables, no charts).

## 3. Deployment constraint: publish body cap

Vercel caps request bodies at about 4.5 MB. The protocol allows tarballs up to 10 MiB.
Real skill folders are far below 1 MB. Decision: v1 enforces a 4 MiB tarball cap at
publish and returns the protocol error `413 too_large` above it. The protocol permits a
server to reject with `too_large`, so the CLI needs no change. If a real package ever
needs more, only the publish route moves behind a Supabase Edge Function later.

## 4. Data model (Postgres)

- `profiles`: mirrors `auth.users`. Columns: id (auth.users id), handle, email.
- `orgs`: id, `slug` (protocol org name rules: 1 to 39 chars, lowercase letters, digits,
  dash, starts and ends with letter or digit), created_at.
- `org_members`: org_id, user_id, `role` in (`owner`, `publisher`, `reader`).
  Unique (org_id, user_id). The org creator becomes owner.
- `packages`: id, org_id, `name` (protocol name rule), `kind` (`skill` or `pack`),
  `visibility` (`public` or `private`), created_at. Unique (org_id, name).
- `versions`: id, package_id, `version` (exact semver), description, `manifest` jsonb
  (the stored version manifest: files list for skills, skills map for packs),
  tarball_sha256, tarball_size, storage_path, published_by, published_at,
  `yanked` boolean default false. Unique (package_id, version). Rows never change except
  the yank flag, and are never deleted.
- `tokens`: id, user_id, `name`, `token_hash` (sha256 of the secret), `prefix`
  (8 chars for display), created_at, last_used_at, revoked_at.
- `downloads`: version_id, `day` (date), `count`. Upserted when a tarball URL is minted.
- `audit_log`: org_id, actor_user_id, `action` in (`publish`, `member_added`,
  `member_removed`, `role_changed`, `visibility_changed`, `token_created`,
  `token_revoked`, `yank`, `unyank`), `subject` text, created_at.

RLS: public packages and their versions are readable by everyone. Private rows are
readable only by members of the owning org. `tokens` rows are readable only by their
user. `audit_log` and `downloads` are readable only by org members.

## 5. Registry API (five routes under app/v1/)

All behavior follows the protocol spec; this section fixes the implementation choices.

- `GET /v1/packages/@{org}/{name}`: `{ name, kind, latest, versions }` ascending by
  semver, plus an optional `yanked` array of yanked versions (v1 responses may gain
  optional fields). Private without access returns 404, never 403.
- `GET /v1/packages/@{org}/{name}/{version}`: the stored manifest plus a fresh signed
  Storage URL (about 15 minutes) as `tarball.url`, and `publishedAt`.
- Tarball bytes: served by the signed URL directly from Supabase Storage. The manifest
  route upserts the `downloads` row when it mints the URL.
- `PUT /v1/packages/@{org}/{name}/{version}`: multipart publish. Validation order:
  1. Token valid and not revoked.
  2. User has `publisher` or `owner` role in the org.
  3. Name, version, and description satisfy protocol rules.
  4. Version does not already exist (409 `version_exists`).
  5. Tarball rules: 4 MiB body cap (section 3), 25 MiB extracted, 1000 files, relative
     paths only, no `..`, no absolute paths, no links or special files.
  6. Every `files[].sha256` matches the extracted bytes; `tarball.sha256` matches the
     uploaded bytes.
  7. For packs: every member exists, is a skill, and is readable by the publisher.
     A private member the publisher cannot read is `not_found`.
  On success: 201 with the stored manifest, one `audit_log` publish row. First publish
  creates the package row. Visibility defaults to `private`; the server accepts an
  optional `visibility` manifest field on first publish only and rejects it afterwards
  as `invalid_request`.
- `GET /v1/whoami`: resolves the bearer token to `{ user, orgs: [{ org, role }] }`.

Validation logic (name rules, semver, description rule, tar entry checks) lives in
`lib/` as pure functions with unit tests. The rules are transcribed from the protocol
spec. The agpm CLI keeps its own copy; the protocol doc stays the single contract.

## 6. Tokens

Format: `agpm_` plus 32 random base62 characters from a CSPRNG. Stored as sha256 hash
plus an 8-character display prefix. The plain token is shown exactly once at mint time.
Revocation sets `revoked_at`. Every `/v1` request updates `last_used_at` best effort.
No expiry in v1. Tokens read everything their user can read (protocol section 12).

## 7. Dashboard pages

- `/login`: GitHub OAuth and magic link.
- `/dashboard`: your orgs and your packages.
- `/orgs/new`: create an org (becomes owner).
- `/orgs/[org]/settings`: members and roles. Only owners add, remove, or change members.
- `/orgs/[org]/activity`: audit log and per-package download counts as plain tables.
- `/packages/@[org]/[name]`: detail page. Renders SKILL.md, version list with yank
  badges, the exact `agpm install @org/name@version` command, and the file list with
  sha256 values. Public packages work logged out. Private packages 404 for non-members.
  Owners see package settings here: visibility toggle, yank and unyank per version.
- `/settings/tokens`: mint and revoke personal access tokens.

## 8. Errors

API: every non-2xx response carries the protocol envelope
`{ "error": { "code", "message" } }` with the protocol's code table. `message` never
echoes tokens or file contents. Dashboard: inline form errors, route-level error
boundaries, 404 pages for private or missing things.

## 9. Testing

- Unit: vitest on all `lib/` validation and tar logic.
- Integration: route handlers against a local Supabase (`supabase start`) in CI.
  Must cover: all five endpoints, 404 not 403 for private, 409 on republish, pack
  member checks, token revocation, and the visibility-on-first-publish-only rule.
- End to end: the section 1 success script against the local dev server.
- Dashboard: Playwright smoke tests for login-gated navigation, token mint, and the
  public package detail page.

## 10. Not in v1

Search, version ranges, delete, package transfer between orgs, org rename, email
notifications, charts, rate limiting beyond Vercel and Supabase defaults (the protocol
reserves 429 `rate_limited`; v1 may never send it), and the landing page redesign
(sub-project E).
