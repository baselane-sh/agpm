import { nameUnion, runCheck, unitsByName } from "./check.js";
import { KINDS, type FindingCode, type Lock, type Manifest, type ScanResult } from "./types.js";

const DISPLAY: Record<FindingCode, string> = {
  missing: "missing",
  drifted: "drifted",
  split: "drifted",
  unsynced: "drifted",
  unlisted: "unlisted",
};

export function formatList(manifest: Manifest, lock: Lock, scan: ScanResult): string[] {
  const { findings } = runCheck(manifest, lock, scan);
  const lines: string[] = [];
  for (const kind of KINDS) {
    const units = unitsByName(scan, kind);
    for (const name of nameUnion(manifest, lock, units, kind)) {
      const finding = findings.find((f) => f.kind === kind && f.name === name);
      const status = finding === undefined ? "ok" : DISPLAY[finding.code];
      const source =
        (Object.hasOwn(manifest[kind], name) ? manifest[kind][name] : undefined) ??
        (Object.hasOwn(lock[kind], name) ? lock[kind][name]!.source : undefined) ??
        "unknown";
      lines.push(`${kind.padEnd(9)} ${name.padEnd(30)} ${status.padEnd(9)} ${source}`);
    }
  }
  return lines;
}
