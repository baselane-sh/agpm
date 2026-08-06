import { nameUnion, runCheck, unitsByName } from "./check.js";
import { parentApproval } from "./extends.js";
import { KINDS, type FindingCode, type Lock, type Manifest, type ScanResult, type TrackedInput } from "./types.js";

const DISPLAY: Record<FindingCode, string> = {
  missing: "missing",
  drifted: "drifted",
  split: "drifted",
  unsynced: "drifted",
  unlisted: "unlisted",
};

export function formatList(manifest: Manifest, lock: Lock, scan: ScanResult, tracked?: TrackedInput): string[] {
  const { findings } = runCheck(manifest, lock, scan, {}, tracked);
  const lines: string[] = [];
  for (const kind of KINDS) {
    const units = unitsByName(scan, kind);
    for (const name of nameUnion(manifest, lock, units, kind)) {
      const finding = findings.find((f) => f.kind === kind && f.name === name);
      const status = finding === undefined ? "ok" : DISPLAY[finding.code];
      const source =
        parentApproval(manifest, lock, kind, name) ??
        (Object.hasOwn(manifest[kind], name) ? manifest[kind][name] : undefined) ??
        (Object.hasOwn(lock[kind], name) ? lock[kind][name]!.source : undefined) ??
        "unknown";
      lines.push(`${kind.padEnd(9)} ${name.padEnd(30)} ${status.padEnd(9)} ${source}`);
    }
  }
  const filePaths = [
    ...new Set([
      ...Object.keys(manifest.files ?? {}),
      ...Object.keys(lock.files ?? {}),
      ...findings.filter((f) => f.kind === "files").map((f) => f.name),
    ]),
  ].sort();
  for (const path of filePaths) {
    const finding = findings.find((f) => f.kind === "files" && f.name === path);
    const status = finding === undefined ? "ok" : DISPLAY[finding.code];
    const source = Object.hasOwn(manifest.files ?? {}, path)
      ? manifest.files![path]!
      : Object.hasOwn(lock.files ?? {}, path)
        ? lock.files![path]!.source
        : "unknown";
    lines.push(`${"files".padEnd(9)} ${path.padEnd(30)} ${status.padEnd(9)} ${source}`);
  }
  return lines;
}
