import { nameUnion, runCheck, unitsByName } from "./check.js";
import { parentApproval } from "./extends.js";
import { KINDS, type Lock, type Manifest, type ScanResult } from "./types.js";

const OUT_OF_APPROVAL = new Set(["missing", "drifted", "split", "unsynced"]);

export function formatAudit(manifest: Manifest, lock: Lock, scan: ScanResult, notes: string[]): string[] {
  const { findings } = runCheck(manifest, lock, scan);
  const lines: string[] = [];
  let total = 0;
  let outOfApproval = 0;
  let unapproved = 0;
  for (const kind of KINDS) {
    const units = unitsByName(scan, kind);
    for (const name of nameUnion(manifest, lock, units, kind)) {
      total++;
      const finding = findings.find((f) => f.kind === kind && f.name === name);
      const state = finding === undefined ? "ok" : finding.code;
      if (OUT_OF_APPROVAL.has(state)) outOfApproval++;
      if (state === "unlisted") unapproved++;
      const parent = parentApproval(lock, kind, name);
      const source =
        parent !== undefined
          ? `${parent} (extends)`
          : Object.hasOwn(manifest[kind], name)
            ? manifest[kind][name]!
            : "(unapproved)";
      const unit = units.get(name);
      const where = unit === undefined
        ? "(not on disk)"
        : unit.locations.map((l) => l.dir).sort().join(" + ");
      lines.push(`${kind.padEnd(9)} ${name.padEnd(30)} ${state.padEnd(9)} ${source.padEnd(45)} ${where}`);
    }
  }
  for (const note of notes) lines.push(`note: ${note}`);
  lines.push(`audit: ${total} entries, ${outOfApproval} out of approval, ${unapproved} unapproved`);
  return lines;
}
