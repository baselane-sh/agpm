import { gzipSync, gunzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { AgpmError } from "./errors.js";

const BLOCK_SIZE = 512;
const NAME_WIDTH = 100;
const PREFIX_OFFSET = 345;
const PREFIX_WIDTH = 155;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_WIDTH = 8;
const TYPEFLAG_OFFSET = 156;

export const TAR_LIMITS = {
  maxCompressed: 10 * 1024 * 1024,
  maxExtracted: 25 * 1024 * 1024,
  maxFiles: 1000,
};

// Headroom above maxExtracted for gunzip's own output cap: covers ustar headers, block
// padding, and the two-block trailer. 2 MiB is ample for 1000 files.
const TAR_OVERHEAD = 2 * 1024 * 1024;

export function createTarball(files: Record<string, Uint8Array>): Buffer {
  const paths = Object.keys(files).sort();
  for (const path of paths) {
    if (Buffer.byteLength(path, "utf8") > NAME_WIDTH) {
      throw new AgpmError(`invalid package: path too long for ustar: ${path}`);
    }
  }

  const chunks: Buffer[] = [];
  for (const path of paths) {
    const content = Buffer.from(files[path]!);
    chunks.push(buildHeader(path, content.length));
    chunks.push(content);
    const remainder = content.length % BLOCK_SIZE;
    if (remainder > 0) chunks.push(Buffer.alloc(BLOCK_SIZE - remainder));
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));

  return gzipSync(Buffer.concat(chunks));
}

export function extractTarball(gz: Uint8Array): Record<string, Buffer> {
  if (gz.length > TAR_LIMITS.maxCompressed) {
    throw new AgpmError(`invalid package: tarball exceeds 10 MiB`);
  }

  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: TAR_LIMITS.maxExtracted + TAR_OVERHEAD });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new AgpmError(`invalid package: contents exceed 25 MiB`);
    }
    throw new AgpmError(`invalid package: not a gzip tarball`);
  }

  const result: Record<string, Buffer> = Object.create(null);
  let offset = 0;
  let fileCount = 0;
  let extractedTotal = 0;

  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(header)) break;

    verifyChecksum(header);

    const prefix = readField(header, PREFIX_OFFSET, PREFIX_WIDTH);
    if (prefix.length > 0) {
      throw new AgpmError(`invalid package: non-empty prefix field in tar header`);
    }

    const typeflag = String.fromCharCode(header[TYPEFLAG_OFFSET]!);
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5") {
      throw new AgpmError(`invalid package: unsupported tar entry type "${typeflag}"`);
    }

    const name = readField(header, 0, NAME_WIDTH);
    const size = parseOctal(header.subarray(124, 136));
    offset += BLOCK_SIZE;
    const contentSpan = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    if (typeflag === "5") {
      offset += contentSpan;
      continue;
    }

    validatePath(name);
    if (Object.hasOwn(result, name)) {
      throw new AgpmError(`invalid package: duplicate path in tarball: ${name}`);
    }

    fileCount += 1;
    if (fileCount > TAR_LIMITS.maxFiles) {
      throw new AgpmError(`invalid package: more than 1000 files`);
    }

    extractedTotal += size;
    if (extractedTotal > TAR_LIMITS.maxExtracted) {
      throw new AgpmError(`invalid package: contents exceed 25 MiB`);
    }

    result[name] = Buffer.from(tar.subarray(offset, offset + size));
    offset += contentSpan;
  }

  return result;
}

function validatePath(name: string): void {
  if (name.length === 0) {
    throw new AgpmError(`invalid package: empty path in tar entry`);
  }
  if (name.startsWith("/")) {
    throw new AgpmError(`invalid package: absolute path in tar entry: ${name}`);
  }
  if (name.includes("\\")) {
    throw new AgpmError(`invalid package: backslash in tar entry path: ${name}`);
  }
  if (name.split("/").includes("..")) {
    throw new AgpmError(`invalid package: path traversal in tar entry: ${name}`);
  }
}

function buildHeader(path: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  header.write(path, 0, NAME_WIDTH, "utf8");
  Buffer.from("0000644 ", "ascii").copy(header, 100);
  octalField(0, 8).copy(header, 108); // uid
  octalField(0, 8).copy(header, 116); // gid
  octalField(size, 12).copy(header, 124); // size
  octalField(0, 12).copy(header, 136); // mtime
  header.fill(0x20, CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_WIDTH);
  header[TYPEFLAG_OFFSET] = 0x30; // "0"
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  // uname, gname, devmajor, devminor, prefix stay empty (zero-filled).

  formatChecksum(computeChecksum(header)).copy(header, CHECKSUM_OFFSET);
  return header;
}

function octalField(value: number, width: number): Buffer {
  const buf = Buffer.alloc(width, 0);
  buf.write(value.toString(8).padStart(width - 1, "0"), 0, width - 1, "ascii");
  return buf;
}

function formatChecksum(sum: number): Buffer {
  const buf = Buffer.alloc(CHECKSUM_WIDTH, 0x20);
  buf.write(sum.toString(8).padStart(6, "0"), 0, 6, "ascii");
  buf[6] = 0;
  return buf;
}

function computeChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    sum += i >= CHECKSUM_OFFSET && i < CHECKSUM_OFFSET + CHECKSUM_WIDTH ? 0x20 : header[i]!;
  }
  return sum;
}

function verifyChecksum(header: Buffer): void {
  const stored = parseOctal(header.subarray(CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_WIDTH));
  const computed = computeChecksum(header);
  if (stored !== computed) {
    throw new AgpmError(`invalid package: corrupted tar header checksum`);
  }
}

function readField(header: Buffer, start: number, width: number): string {
  const field = header.subarray(start, start + width);
  const nul = field.indexOf(0);
  const end = nul === -1 ? width : nul;
  return field.subarray(0, end).toString("utf8");
}

function parseOctal(field: Buffer): number {
  let raw = "";
  for (const byte of field) {
    if (byte === 0) break;
    raw += String.fromCharCode(byte);
  }
  raw = raw.trim();
  if (raw === "") return 0;
  const value = parseInt(raw, 8);
  if (Number.isNaN(value)) {
    throw new AgpmError(`invalid package: corrupted tar header checksum`);
  }
  return value;
}

function isZeroBlock(header: Buffer): boolean {
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (header[i] !== 0) return false;
  }
  return true;
}
