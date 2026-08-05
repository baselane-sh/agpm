import { KINDS, type CheckResult, type Finding, type Kind, type Lock, type Manifest, type ScanResult, type ScannedUnit } from "./types.js";

export function unitsByName(scan: ScanResult, kind: Kind): Map<string, ScannedUnit> {
  return new Map(scan.units.filter((u) => u.kind === kind).map((u) => [u.name, u]));
}

export function nameUnion(manifest: Manifest, lock: Lock, units: Map<string, ScannedUnit>, kind: Kind): string[] {
  return [...new Set([...Object.keys(manifest[kind]), ...Object.keys(lock[kind]), ...units.keys()])].sort();
}

export function runCheck(manifest: Manifest, lock: Lock, scan: ScanResult): CheckResult {
  const findings: Finding[] = [];
  for (const kind of KINDS) {
    const units = unitsByName(scan, kind);
    for (const name of nameUnion(manifest, lock, units, kind)) {
      const inManifest = Object.hasOwn(manifest[kind], name);
      const entry = Object.hasOwn(lock[kind], name) ? lock[kind][name] : undefined;
      const unit = units.get(name);
      if (inManifest !== (entry !== undefined)) {
        findings.push(fail(kind, name, "unsynced",
          `harness.json and harness.lock disagree about ${kind}/${name}; run agpm sync and approve the diff by PR`));
        continue;
      }
      if (entry !== undefined) {
        if (unit === undefined) {
          findings.push(fail(kind, name, "missing", `${kind}/${name} is approved but not on disk`));
          continue;
        }
        const splitFinding = checkSplit(kind, name, unit);
        if (splitFinding !== undefined) {
          findings.push(splitFinding);
          continue;
        }
        const dirs = unit.locations.map((l) => l.dir).sort();
        if (!sameArray(dirs, entry.dirs)) {
          findings.push(fail(kind, name, "drifted",
            `${kind}/${name} moved: lock says [${entry.dirs.join(", ")}], disk has [${dirs.join(", ")}]`));
          continue;
        }
        if (!sameRecord(unit.locations[0]!.files, entry.files)) {
          findings.push(fail(kind, name, "drifted", `${kind}/${name} bytes differ from the approved hashes`));
        }
        continue;
      }
      if (unit !== undefined) {
        findings.push({ level: "warn", kind, name, code: "unlisted",
          message: `${kind}/${name} exists on disk but nobody approved it in harness.json` });
      }
    }
  }
  return { findings, exitCode: findings.some((f) => f.level === "fail") ? 1 : 0 };
}

function checkSplit(kind: Kind, name: string, unit: ScannedUnit): Finding | undefined {
  const first = unit.locations[0]!;
  for (const location of unit.locations.slice(1)) {
    if (!sameRecord(first.files, location.files)) {
      return fail(kind, name, "split",
        `${kind}/${name} has different bytes in ${first.dir} and ${location.dir}`);
    }
  }
  return undefined;
}

function fail(kind: Kind, name: string, code: Finding["code"], message: string): Finding {
  return { level: "fail", kind, name, code, message };
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}
