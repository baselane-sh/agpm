import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { formatAudit } from "./audit.js";
import { runCheck } from "./check.js";
import { resolveToken } from "./credentials.js";
import { AgpmError } from "./errors.js";
import { resolveExtends, type ExtendsFetcher } from "./extends.js";
import { githubExtendsFetcher } from "./github.js";
import { runInstall } from "./install.js";
import { formatList } from "./list.js";
import { emptyLock, parseLock, serializeLock } from "./lock.js";
import { runLogin, runLogout } from "./login.js";
import { emptyManifest, parseManifest, serializeManifest } from "./manifest.js";
import { readSecretRaw } from "./promptSecret.js";
import { readProvenance } from "./provenance.js";
import { runPublish, type PublishArgs } from "./publishCmd.js";
import { makeRegistryClient, type RegistryClient } from "./registry.js";
import { runRemove } from "./remove.js";
import { scanRepo } from "./scan.js";
import { computeSync, type SyncResult } from "./sync.js";
import { runTrack, runUntrack } from "./track.js";
import { candidateWarnings, scanTrackedFiles } from "./trackedFiles.js";
import type { Lock, Manifest, ResolvedExtends, TrackedInput } from "./types.js";
import { runUpdate } from "./update.js";

type Writer = (line: string) => void;
type PromptSecret = (msg: string) => Promise<string>;
type Confirm = (message: string) => Promise<boolean>;

const USAGE =
  "usage: agpm <init|sync|check|audit|list|install|remove|update|track|untrack|login|logout|publish>; check accepts --strict and --json; publish accepts --pack, --description, and --public";
const DEFAULT_REGISTRY_URL = "https://registry.baselane.sh";

export interface CliDeps {
  extendsFetcher?: ExtendsFetcher;
  registryFetch?: typeof fetch;
  homeDir?: string;
  promptSecret?: PromptSecret;
  confirm?: Confirm;
}

export async function runCli(argv: string[], cwd: string, write: Writer, deps: CliDeps = {}): Promise<number> {
  const fetcher = deps.extendsFetcher ?? githubExtendsFetcher(process.env);
  const registryFetch = deps.registryFetch ?? fetch;
  const homeDir = deps.homeDir ?? homedir();
  const promptSecret = deps.promptSecret ?? defaultPromptSecret;
  const confirm = deps.confirm ?? (process.stdin.isTTY === true ? defaultConfirm : undefined);
  const registryUrl = resolveRegistryUrl(process.env);
  const [command, ...rest] = argv;
  try {
    if (command === "check") {
      let strict = false;
      let json = false;
      for (const flag of rest) {
        if (flag === "--strict") strict = true;
        else if (flag === "--json") json = true;
        else {
          write(USAGE);
          return 2;
        }
      }
      return await check(cwd, write, { strict, json });
    }
    switch (command) {
      case "init":
        if (rest.length > 0) return usage(write);
        return await init(cwd, write, confirm);
      case "sync":
        if (rest.length > 0) return usage(write);
        return await sync(cwd, write, fetcher);
      case "audit":
        if (rest.length > 0) return usage(write);
        return await audit(cwd, write);
      case "list":
        if (rest.length > 0) return usage(write);
        return await list(cwd, write);
      case "install":
        return await install(cwd, write, rest, registryUrl, homeDir, registryFetch);
      case "remove":
        return await remove(cwd, write, rest);
      case "update":
        return await update(cwd, write, rest, registryUrl, homeDir, registryFetch);
      case "track":
        if (rest.length !== 1) return usage(write);
        return await track(cwd, write, rest[0]!);
      case "untrack":
        if (rest.length !== 1) return usage(write);
        return await untrack(cwd, write, rest[0]!);
      case "login":
        return await login(write, rest, registryUrl, homeDir, promptSecret, registryFetch);
      case "logout":
        if (rest.length > 0) return usage(write);
        return await logout(write, registryUrl, homeDir);
      case "publish":
        return await publish(cwd, write, rest, registryUrl, homeDir, registryFetch);
      default:
        return usage(write);
    }
  } catch (error) {
    if (error instanceof AgpmError) {
      write(error.message);
      return 2;
    }
    write(`internal error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

function usage(write: Writer): number {
  write(USAGE);
  return 2;
}

function resolveRegistryUrl(env: Record<string, string | undefined>): string {
  let url = env["AGPM_REGISTRY"] ?? DEFAULT_REGISTRY_URL;
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

async function defaultPromptSecret(message: string): Promise<string> {
  // On a TTY, read in raw mode with echo suppressed so the pasted token never
  // lands in the terminal scrollback. Piped stdin falls back to a plain line read.
  if (process.stdin.isTTY === true) {
    return readSecretRaw(message, process.stdin, process.stdout);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

async function defaultConfirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(message);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function makeClient(registryUrl: string, homeDir: string, fetchImpl: typeof fetch): Promise<RegistryClient> {
  const token = await resolveToken(registryUrl, process.env, homeDir);
  return makeRegistryClient(registryUrl, token, fetchImpl);
}

async function install(
  cwd: string,
  write: Writer,
  args: string[],
  registryUrl: string,
  homeDir: string,
  fetchImpl: typeof fetch,
): Promise<number> {
  if (args.length !== 1) return usage(write);
  const client = await makeClient(registryUrl, homeDir, fetchImpl);
  const { lines } = await runInstall(cwd, args[0]!, client);
  for (const line of lines) write(line);
  return 0;
}

async function remove(cwd: string, write: Writer, args: string[]): Promise<number> {
  if (args.length !== 1) return usage(write);
  const { lines } = await runRemove(cwd, args[0]!);
  for (const line of lines) write(line);
  return 0;
}

async function update(
  cwd: string,
  write: Writer,
  args: string[],
  registryUrl: string,
  homeDir: string,
  fetchImpl: typeof fetch,
): Promise<number> {
  if (args.length > 1) return usage(write);
  const client = await makeClient(registryUrl, homeDir, fetchImpl);
  const { lines } = await runUpdate(cwd, args[0], client);
  for (const line of lines) write(line);
  return 0;
}

async function login(
  write: Writer,
  args: string[],
  registryUrl: string,
  homeDir: string,
  promptSecret: PromptSecret,
  fetchImpl: typeof fetch,
): Promise<number> {
  if (args.length > 0) return usage(write);
  const clientFactory = (token: string) => makeRegistryClient(registryUrl, token, fetchImpl);
  const { lines } = await runLogin(registryUrl, promptSecret, clientFactory, homeDir);
  for (const line of lines) write(line);
  return 0;
}

async function logout(write: Writer, registryUrl: string, homeDir: string): Promise<number> {
  const { lines } = await runLogout(registryUrl, homeDir);
  for (const line of lines) write(line);
  return 0;
}

async function publish(
  cwd: string,
  write: Writer,
  args: string[],
  registryUrl: string,
  homeDir: string,
  fetchImpl: typeof fetch,
): Promise<number> {
  const parsed = parsePublishArgs(args);
  if (parsed === undefined) return usage(write);
  const client = await makeClient(registryUrl, homeDir, fetchImpl);
  const { lines } = await runPublish(cwd, parsed, client);
  for (const line of lines) write(line);
  return 0;
}

function parsePublishArgs(args: string[]): PublishArgs | undefined {
  const isPublic = args.includes("--public");
  const rest = args.filter((arg) => arg !== "--public");
  const base = parsePublishShape(rest);
  if (base === undefined) return undefined;
  return isPublic ? { ...base, visibility: "public" } : base;
}

function parsePublishShape(args: string[]): PublishArgs | undefined {
  if (args[0] === "--pack") {
    if (args.length !== 3) return undefined;
    return { packFile: args[1], ref: args[2]! };
  }
  if (args.length === 2) {
    return { folder: args[0], ref: args[1]! };
  }
  if (args.length === 4 && args[2] === "--description") {
    return { folder: args[0], ref: args[1]!, description: args[3] };
  }
  return undefined;
}

async function loadFiles(cwd: string): Promise<{ manifest: Manifest; lock: Lock }> {
  const manifestPath = join(cwd, "harness.json");
  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgpmError(`no harness.json found in ${cwd}; run agpm init`);
    }
    throw error;
  }
  const manifest = parseManifest(manifestText, manifestPath);
  const lockPath = join(cwd, "harness.lock");
  let lock: Lock;
  try {
    lock = parseLock(await readFile(lockPath, "utf8"), lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      lock = emptyLock();
    } else {
      throw error;
    }
  }
  return { manifest, lock };
}

async function loadTracked(cwd: string, manifest: Manifest): Promise<TrackedInput> {
  return {
    scan: await scanTrackedFiles(cwd, manifest.files ?? {}),
    candidates: await candidateWarnings(cwd),
  };
}

async function track(cwd: string, write: Writer, path: string): Promise<number> {
  const { lines } = await runTrack(cwd, path);
  for (const line of lines) write(line);
  return 0;
}

async function untrack(cwd: string, write: Writer, path: string): Promise<number> {
  const { lines } = await runUntrack(cwd, path);
  for (const line of lines) write(line);
  return 0;
}

async function check(cwd: string, write: Writer, opts: { strict: boolean; json: boolean }): Promise<number> {
  const { manifest, lock } = await loadFiles(cwd);
  const tracked = await loadTracked(cwd, manifest);
  const result = runCheck(manifest, lock, await scanRepo(cwd), { strict: opts.strict }, tracked);
  const fails = result.findings.filter((f) => f.level === "fail").length;
  const warns = result.findings.length - fails;
  if (opts.json) {
    write(JSON.stringify({ findings: result.findings, summary: { fail: fails, warn: warns }, exitCode: result.exitCode }, null, 2));
    return result.exitCode;
  }
  for (const finding of result.findings) {
    const label = finding.kind === "extends" ? "extends" : `${finding.kind}/${finding.name}`;
    write(`${finding.level === "fail" ? "FAIL" : "WARN"} ${label}: ${finding.message}`);
  }
  write(`check: ${fails} fail, ${warns} warn`);
  return result.exitCode;
}

async function audit(cwd: string, write: Writer): Promise<number> {
  const { manifest, lock } = await loadFiles(cwd);
  const { notes } = await readProvenance(cwd);
  const tracked = await loadTracked(cwd, manifest);
  for (const line of formatAudit(manifest, lock, await scanRepo(cwd), notes, tracked)) write(line);
  return 0;
}

async function list(cwd: string, write: Writer): Promise<number> {
  const { manifest, lock } = await loadFiles(cwd);
  const tracked = await loadTracked(cwd, manifest);
  for (const line of formatList(manifest, lock, await scanRepo(cwd), tracked)) write(line);
  return 0;
}

async function init(cwd: string, write: Writer, confirm?: Confirm): Promise<number> {
  const manifestPath = join(cwd, "harness.json");
  if (await fileExists(manifestPath)) {
    throw new AgpmError(`harness.json already exists in ${cwd}; run agpm sync`);
  }
  const { sources } = await readProvenance(cwd);
  const result = computeSync(emptyManifest(), emptyLock(), await scanRepo(cwd), sources);
  await writeResult(cwd, result);
  for (const note of result.notes) write(`note: ${note}`);
  reportChanges(result.changes, write);
  let tracked = 0;
  if (confirm !== undefined) {
    for (const note of await candidateWarnings(cwd)) {
      if (await confirm(`track ${note.path}? [y/N] `)) {
        const { lines } = await runTrack(cwd, note.path);
        for (const line of lines) write(line);
        tracked++;
      }
    }
  }
  const n = result.changes.length + tracked;
  write(`init: ${n} ${n === 1 ? "entry" : "entries"} recorded`);
  return 0;
}

async function sync(cwd: string, write: Writer, fetcher: ExtendsFetcher): Promise<number> {
  const { manifest, lock } = await loadFiles(cwd);
  let resolved: ResolvedExtends | undefined;
  if (manifest.extends !== undefined) {
    resolved = await resolveExtends(manifest.extends, fetcher);
    write(`extends: ${manifest.extends} pinned at ${resolved.commit.slice(0, 12)}`);
  }
  const { sources, notes } = await readProvenance(cwd);
  const trackedScan = await scanTrackedFiles(cwd, manifest.files ?? {});
  const result = computeSync(manifest, lock, await scanRepo(cwd), sources, resolved, trackedScan);
  await writeResult(cwd, result);
  for (const note of notes) write(`note: ${note}`);
  for (const note of result.notes) write(`note: ${note}`);
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
