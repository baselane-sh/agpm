import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createTarball, extractTarball, TAR_LIMITS } from "../src/tar.js";

const BLOCK_SIZE = 512;

// --- Hand-crafted ustar helpers (deliberately independent of src/tar.ts's writer) ---

function octalField(value: number, width: number): Buffer {
  const buf = Buffer.alloc(width, 0);
  buf.write(value.toString(8).padStart(width - 1, "0"), 0, width - 1, "ascii");
  return buf;
}

function computeChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  }
  return sum;
}

function buildHeader(opts: {
  name: string;
  size?: number;
  typeflag?: string;
  prefix?: string;
  badChecksum?: boolean;
}): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  header.write(opts.name, 0, 100, "utf8");
  Buffer.from("0000644 ", "ascii").copy(header, 100);
  octalField(0, 8).copy(header, 108);
  octalField(0, 8).copy(header, 116);
  octalField(opts.size ?? 0, 12).copy(header, 124);
  octalField(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = (opts.typeflag ?? "0").charCodeAt(0);
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  if (opts.prefix) header.write(opts.prefix, 345, 155, "utf8");

  const sum = opts.badChecksum ? computeChecksum(header) + 1 : computeChecksum(header);
  const digits = sum.toString(8).padStart(6, "0");
  header.write(digits, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function pad(content: Buffer): Buffer {
  const rem = content.length % BLOCK_SIZE;
  if (rem === 0) return content;
  return Buffer.concat([content, Buffer.alloc(BLOCK_SIZE - rem)]);
}

function buildTar(entries: Array<{ header: Buffer; content?: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(entry.header);
    if (entry.content && entry.content.length > 0) parts.push(pad(entry.content));
  }
  parts.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(parts);
}

function gz(tar: Buffer): Buffer {
  return gzipSync(tar);
}

// --- Round trip and determinism ---

describe("createTarball / extractTarball round trip", () => {
  it("returns identical bytes and paths after round trip", () => {
    const files: Record<string, Uint8Array> = {
      "SKILL.md": Buffer.from("hello world", "utf8"),
      "ref/notes.md": Buffer.from("some reference notes", "utf8"),
      "a.txt": Buffer.from("", "utf8"),
    };
    const tarball = createTarball(files);
    const extracted = extractTarball(tarball);

    expect(Object.keys(extracted).sort()).toEqual(Object.keys(files).sort());
    for (const path of Object.keys(files)) {
      expect(extracted[path]).toEqual(Buffer.from(files[path]!));
    }
  });
});

describe("createTarball determinism", () => {
  it("produces byte-identical output for identical input", () => {
    const files: Record<string, Uint8Array> = {
      "b.txt": Buffer.from("bbb", "utf8"),
      "a.txt": Buffer.from("aaa", "utf8"),
    };
    const first = createTarball(files);
    const second = createTarball(files);
    expect(first.equals(second)).toBe(true);
  });
});

describe("createTarball path length", () => {
  it("rejects a path over 100 chars", () => {
    const longPath = "a/".repeat(60) + "file.md"; // well over 100 bytes
    const files: Record<string, Uint8Array> = { [longPath]: Buffer.from("x") };
    expect(() => createTarball(files)).toThrow(
      `invalid package: path too long for ustar: ${longPath}`,
    );
  });
});

// --- Hostile inputs ---

describe("extractTarball hostile inputs", () => {
  it("rejects a traversal name", () => {
    const content = Buffer.from("evil", "utf8");
    const header = buildHeader({ name: "../x", size: content.length });
    const tarball = gz(buildTar([{ header, content }]));
    expect(() => extractTarball(tarball)).toThrow(/^invalid package: /);
    expect(() => extractTarball(tarball)).toThrow(/\.\.\/x/);
  });

  it("rejects an absolute path", () => {
    const content = Buffer.from("evil", "utf8");
    const header = buildHeader({ name: "/etc/x", size: content.length });
    const tarball = gz(buildTar([{ header, content }]));
    expect(() => extractTarball(tarball)).toThrow(/^invalid package: /);
    expect(() => extractTarball(tarball)).toThrow(/\/etc\/x/);
  });

  it("rejects a symlink typeflag", () => {
    const header = buildHeader({ name: "link", typeflag: "2" });
    const tarball = gz(buildTar([{ header }]));
    expect(() => extractTarball(tarball)).toThrow(
      'invalid package: unsupported tar entry type "2"',
    );
  });

  it("rejects a non-empty prefix field", () => {
    const content = Buffer.from("x", "utf8");
    const header = buildHeader({ name: "file.md", size: content.length, prefix: "some/prefix" });
    const tarball = gz(buildTar([{ header, content }]));
    expect(() => extractTarball(tarball)).toThrow(/^invalid package: /);
    expect(() => extractTarball(tarball)).toThrow(/prefix/);
  });

  it("rejects a duplicate path", () => {
    const content = Buffer.from("x", "utf8");
    const header1 = buildHeader({ name: "dup.md", size: content.length });
    const header2 = buildHeader({ name: "dup.md", size: content.length });
    const tarball = gz(
      buildTar([
        { header: header1, content },
        { header: header2, content },
      ]),
    );
    expect(() => extractTarball(tarball)).toThrow(/^invalid package: /);
    expect(() => extractTarball(tarball)).toThrow(/dup\.md/);
  });

  it("rejects a corrupted checksum", () => {
    const content = Buffer.from("x", "utf8");
    const header = buildHeader({ name: "file.md", size: content.length, badChecksum: true });
    const tarball = gz(buildTar([{ header, content }]));
    expect(() => extractTarball(tarball)).toThrow(/^invalid package: /);
    expect(() => extractTarball(tarball)).toThrow(/checksum/);
  });

  it("rejects plain-text non-gzip input", () => {
    const notGzip = Buffer.from("this is not a gzip file at all", "utf8");
    expect(() => extractTarball(notGzip)).toThrow("invalid package: not a gzip tarball");
  });

  it("rejects a tarball whose declared sizes total over 25 MiB", () => {
    const oversized = TAR_LIMITS.maxExtracted + 1;
    const header = buildHeader({ name: "huge.bin", size: oversized });
    // No real content bytes follow; the size check must fire before content is read.
    const tarball = gz(buildTar([{ header }]));
    expect(() => extractTarball(tarball)).toThrow("invalid package: contents exceed 25 MiB");
  });

  it("rejects a gzip whose compressed length exceeds 10 MiB", () => {
    const big = gzipSync(Buffer.alloc(TAR_LIMITS.maxCompressed + 1024 * 1024), { level: 0 });
    expect(big.length).toBeGreaterThan(TAR_LIMITS.maxCompressed);
    expect(() => extractTarball(big)).toThrow("invalid package: tarball exceeds 10 MiB");
  });
});
