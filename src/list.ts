import { runCheck } from "./check.js";
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
    const units = scan.units.filter((u) => u.kind === kind).map((u) => u.name);
    const names = new Set([...Object.keys(manifest[kind]), ...Object.keys(lock[kind]), ...units]);
    for (const name of [...names].sort()) {
      const finding = findings.find((f) => f.kind === kind && f.name === name);
      const status = finding === undefined ? "ok" : DISPLAY[finding.code];
      const source = manifest[kind][name] ?? lock[kind][name]?.source ?? "unknown";
      lines.push(`${kind.padEnd(9)} ${name.padEnd(30)} ${status.padEnd(9)} ${source}`);
    }
  }
  return lines;
}
