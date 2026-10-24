/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The release zip, written by hand on Node's own deflate so that the same build
// output gives the same bytes whoever zips it, wherever and whenever: entries in code-unit order
// of their paths, every time stamp the build's `SOURCE_DATE_EPOCH`, every file `0644`, no
// directory entries, and no extra fields — the usual ones carry access times, a user id and a
// group id. The bytes still depend on the deflate implementation, so the release notes name the
// Node and zlib versions that made them.
//
// `pnpm release:zip [--dir <build>] [--out <zip>]` zips a build (by default the extension's
// `.output/chrome-mv3`), reads the zip back to check that it holds exactly that build, and prints
// its SHA-256 and the build fingerprint. `SOURCE_DATE_EPOCH` is the environment's or, when unset,
// the time of the commit checked out.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { constants, crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

import { EXTENSION_NAME } from '../../apps/extension/src/brand.ts';
import { fingerprint } from './fingerprint.ts';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_SIZE = 22;
/** ZIP 2.0: deflate. */
const VERSION_NEEDED = 20;
/** Made by: Unix (3) — so the external attributes carry a Unix mode — ZIP 2.0. */
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED;
/** General purpose flag bit 11: the name is UTF-8. */
const FLAG_UTF8 = 0x0800;
const FLAG_ENCRYPTED = 0x0001;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** A regular file, `rw-r--r--`, in the high half of the external attributes. */
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;
/** MS-DOS time stamps start at 1980-01-01T00:00:00Z and end in 2107. */
const DOS_EPOCH = Date.UTC(1980, 0, 1) / 1000;
const DOS_LAST_YEAR = 2107;
/** A fixed deflate: the bytes may differ between zlib versions, never between two runs. */
const DEFLATE = {
  level: 9,
  memLevel: 8,
  windowBits: 15,
  strategy: constants.Z_DEFAULT_STRATEGY,
} as const;

/** What `readZip` reads at most: an extension is a few megabytes, never this. */
const READ_LIMITS = { entries: 10_000, bytes: 512 * 1024 * 1024 } as const;

/** A build output that cannot be zipped faithfully, or a zip that cannot be read safely. */
export class ZipError extends Error {
  override readonly name = 'ZipError';
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every regular file under `dir`, as `/`-separated relative paths, in code-unit order. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out.push(relative(dir, path).split(sep).join('/'));
      else throw new ZipError(`${relative(dir, path)} is not a regular file or a directory`);
    }
  };
  await walk(dir);
  return out.sort(byPath);
}

/** MS-DOS time and date of a moment, read in UTC: never the zipping machine's zone. */
function dosTime(epochSeconds: number): { readonly time: number; readonly date: number } {
  const at = new Date(Math.max(epochSeconds, DOS_EPOCH) * 1000);
  const year = at.getUTCFullYear();
  if (year > DOS_LAST_YEAR) throw new ZipError(`a ZIP time stamp ends in ${String(DOS_LAST_YEAR)}`);
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

const BACKSLASH = 0x5c;
const DELETE = 0x7f;

/**
 * A name the ZIP format and every unzipper read the same way: no control character, no
 * backslash (a separator to Windows), no empty, `.` or `..` segment. A build never makes another.
 */
function checkName(name: string): Uint8Array {
  const unsafe = (): ZipError => new ZipError(`unsafe file name ${JSON.stringify(name)}`);
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === DELETE || code === BACKSLASH) throw unsafe();
  }
  if (name.split('/').some((part) => part === '' || part === '.' || part === '..')) throw unsafe();
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length > MAX_U16) throw new ZipError(`file name too long: ${name}`);
  return bytes;
}

interface Entry {
  readonly name: Uint8Array;
  readonly crc: number;
  readonly size: number;
  readonly compressed: Uint8Array;
  readonly offset: number;
}

/**
 * Zips every file under `dir` into `out` and answers the zip's SHA-256 (hex). `epoch` is
 * `SOURCE_DATE_EPOCH`, in seconds: every entry's time stamp, clamped to 1980-01-01 (the format's
 * first day). The same files and the same epoch give the same bytes; a file's own time stamp,
 * user and mode never reach the zip.
 */
export async function deterministicZip(dir: string, out: string, epoch: number): Promise<string> {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new RangeError(
      `SOURCE_DATE_EPOCH must be whole seconds since 1970, not ${String(epoch)}`,
    );
  }
  const root = resolve(dir);
  const target = resolve(out);
  if (target === root || target.startsWith(`${root}${sep}`)) {
    // A second run would zip the first run's zip.
    throw new ZipError(`the zip must be written outside the directory it zips: ${out}`);
  }
  const { time, date } = dosTime(epoch);
  const names = await filesUnder(root);
  if (names.length > MAX_U16) throw new ZipError(`too many files for a ZIP without ZIP64`);

  const parts: Uint8Array[] = [];
  const entries: Entry[] = [];
  let offset = 0;
  for (const path of names) {
    const name = checkName(path);
    const data = await readFile(join(root, ...path.split('/')));
    if (data.length > MAX_U32) throw new ZipError(`${path} is too large for a ZIP without ZIP64`);
    const compressed = deflateRawSync(data, DEFLATE);
    const entry: Entry = { name, crc: crc32(data), size: data.length, compressed, offset };
    const header = Buffer.alloc(LOCAL_HEADER_SIZE);
    header.writeUInt32LE(LOCAL_HEADER, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(FLAG_UTF8, 6);
    header.writeUInt16LE(METHOD_DEFLATE, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    parts.push(header, name, compressed);
    offset += header.length + name.length + compressed.length;
    if (offset > MAX_U32) throw new ZipError('the zip is too large for a ZIP without ZIP64');
    entries.push(entry);
  }

  const directoryOffset = offset;
  for (const entry of entries) {
    const header = Buffer.alloc(CENTRAL_HEADER_SIZE);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE(VERSION_MADE_BY, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(FLAG_UTF8, 8);
    header.writeUInt16LE(METHOD_DEFLATE, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressed.length, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.name.length, 28);
    // Extra field, comment, disk number and internal attributes: all zero.
    header.writeUInt32LE(EXTERNAL_ATTRIBUTES, 38);
    header.writeUInt32LE(entry.offset, 42);
    parts.push(header, entry.name);
    offset += header.length + entry.name.length;
  }
  if (offset > MAX_U32) throw new ZipError('the zip is too large for a ZIP without ZIP64');

  const end = Buffer.alloc(END_SIZE);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - directoryOffset, 12);
  end.writeUInt32LE(directoryOffset, 16);
  parts.push(end);

  const zip = Buffer.concat(parts);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, zip);
  return createHash('sha256').update(zip).digest('hex');
}

/**
 * The files of a zip, by name — any zip without ZIP64, encryption or a split, read defensively:
 * every name is a safe relative path met once, every entry inflates to exactly its stated size
 * and checksum, and the whole stays within 10,000 entries and 512 MiB. Directory entries are
 * skipped. Anything else is a `ZipError`, never a partial answer.
 */
export function readZip(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = endRecordOf(zip);
  const files = new Map<string, Uint8Array>();
  let total = 0;
  let at = directory.offset;
  for (let index = 0; index < directory.count; index += 1) {
    const entry = centralEntryAt(zip, at, directory.end);
    at = entry.next;
    if (entry.name.endsWith('/') && entry.size === 0) continue;
    try {
      checkName(entry.name);
    } catch {
      notReadable(`unsafe name ${JSON.stringify(entry.name)}`);
    }
    if (files.has(entry.name)) notReadable(`${entry.name} appears twice`);
    total += entry.size;
    if (total > READ_LIMITS.bytes) notReadable(`more than ${String(READ_LIMITS.bytes)} bytes`);
    files.set(entry.name, entryData(zip, entry, directory.offset));
  }
  return files;
}

/** A refusal of the zip being read. */
function notReadable(why: string): never {
  throw new ZipError(`not a zip this tool reads: ${why}`);
}

/** Where the central directory is, and how many entries it holds, from the end record. */
function endRecordOf(zip: Buffer): {
  readonly end: number;
  readonly count: number;
  readonly offset: number;
} {
  // The end record is the last 22 bytes before a comment of at most 65,535.
  let end = -1;
  for (let at = zip.length - END_SIZE; at >= 0 && at >= zip.length - END_SIZE - MAX_U16; at -= 1) {
    if (zip.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) notReadable('no end of central directory');
  const count = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  const offset = zip.readUInt32LE(end + 16);
  if (zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0)
    notReadable('a split zip');
  if (count === MAX_U16 || offset === MAX_U32) notReadable('ZIP64');
  if (count > READ_LIMITS.entries) notReadable(`more than ${String(READ_LIMITS.entries)} entries`);
  if (offset + size > end) notReadable('the central directory overruns the file');
  return { end, count, offset };
}

interface CentralEntry {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
  /** Where the next central header starts. */
  readonly next: number;
}

/** The central directory's entry at `at`, refused when broken, encrypted or ZIP64. */
function centralEntryAt(zip: Buffer, at: number, end: number): CentralEntry {
  if (at + CENTRAL_HEADER_SIZE > end || zip.readUInt32LE(at) !== CENTRAL_HEADER) {
    notReadable('a broken central directory');
  }
  const nameEnd = at + CENTRAL_HEADER_SIZE + zip.readUInt16LE(at + 28);
  if (nameEnd > end) notReadable('a name overruns the central directory');
  let name = '';
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(
      zip.subarray(at + CENTRAL_HEADER_SIZE, nameEnd),
    );
  } catch {
    notReadable('a name that is not UTF-8');
  }
  const entry: CentralEntry = {
    name,
    method: zip.readUInt16LE(at + 10),
    crc: zip.readUInt32LE(at + 16),
    compressedSize: zip.readUInt32LE(at + 20),
    size: zip.readUInt32LE(at + 24),
    localOffset: zip.readUInt32LE(at + 42),
    next: nameEnd + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32),
  };
  if ((zip.readUInt16LE(at + 8) & FLAG_ENCRYPTED) !== 0) notReadable(`${name} is encrypted`);
  if ([entry.compressedSize, entry.size, entry.localOffset].includes(MAX_U32)) {
    notReadable('ZIP64');
  }
  return entry;
}

/** An entry's bytes, from its local header: inflated to exactly its stated size and checksum. */
function entryData(zip: Buffer, entry: CentralEntry, directoryOffset: number): Uint8Array {
  const { name, localOffset } = entry;
  if (
    localOffset + LOCAL_HEADER_SIZE > directoryOffset ||
    zip.readUInt32LE(localOffset) !== LOCAL_HEADER
  ) {
    notReadable(`${name} has no local header`);
  }
  const dataStart =
    localOffset +
    LOCAL_HEADER_SIZE +
    zip.readUInt16LE(localOffset + 26) +
    zip.readUInt16LE(localOffset + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > directoryOffset) notReadable(`${name} overruns the central directory`);
  const raw = zip.subarray(dataStart, dataEnd);
  let data: Uint8Array = raw;
  if (entry.method === METHOD_DEFLATE) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      notReadable(`${name} does not inflate to its stated size`);
    }
  } else if (entry.method !== METHOD_STORED) {
    notReadable(`${name} uses compression method ${String(entry.method)}`);
  }
  if (data.length !== entry.size) notReadable(`${name} is not its stated size`);
  if (crc32(data) !== entry.crc) notReadable(`${name} fails its checksum`);
  return Uint8Array.from(data);
}

/** The zip holds exactly the files under `dir`, byte for byte; otherwise the first difference. */
async function sameFiles(
  dir: string,
  zip: ReadonlyMap<string, Uint8Array>,
): Promise<string | null> {
  const names = await filesUnder(dir);
  if (names.length !== zip.size) {
    return `${String(zip.size)} entries for ${String(names.length)} files`;
  }
  for (const name of names) {
    const inZip = zip.get(name);
    if (inZip === undefined) return `${name} is missing`;
    if (!Buffer.from(inZip).equals(await readFile(join(dir, ...name.split('/'))))) {
      return `${name} differs`;
    }
  }
  return null;
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_BUILD = join(ROOT, 'apps', 'extension', '.output', 'chrome-mv3');
const DEFAULT_OUT_DIR = join(ROOT, 'dist', 'release');
/** `MediaTracker for Chrome` → `mediatracker-for-chrome`: the brand's name, file-safe. */
const FILE_STEM = EXTENSION_NAME.toLowerCase().replace(/[^a-z0-9]+/gu, '-');

/** `SOURCE_DATE_EPOCH` as stated, or else the time of the commit checked out. */
function sourceDateEpoch(): number {
  const text =
    process.env.SOURCE_DATE_EPOCH ??
    execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!/^\d{1,12}$/u.test(text)) {
    throw new RangeError(
      `SOURCE_DATE_EPOCH must be whole seconds since 1970, not ${JSON.stringify(text)}`,
    );
  }
  return Number(text);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ZipError(`${path} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { dir: { type: 'string' }, out: { type: 'string' } },
    strict: true,
  });
  const dir = resolve(values.dir ?? DEFAULT_BUILD);
  const { version } = await readJson(join(dir, 'manifest.json'));
  if (typeof version !== 'string' || !/^\d{1,5}(?:\.\d{1,5}){0,3}$/u.test(version)) {
    throw new ZipError(`${dir}/manifest.json states no extension version`);
  }
  // The About screen shows fingerprint.json; a build whose code it does not describe is broken.
  const embedded = (await readJson(join(dir, 'fingerprint.json'))).fingerprint;
  const code = await fingerprint(dir);
  if (embedded !== code) {
    throw new ZipError(`fingerprint.json says ${String(embedded)}, but the code is ${code}`);
  }
  const epoch = sourceDateEpoch();
  const out = resolve(values.out ?? join(DEFAULT_OUT_DIR, `${FILE_STEM}-${version}.zip`));
  const sha256 = await deterministicZip(dir, out, epoch);
  const difference = await sameFiles(dir, readZip(await readFile(out)));
  if (difference !== null) throw new ZipError(`the zip does not hold the build: ${difference}`);

  const say = (key: string, value: string): void => {
    process.stdout.write(`${key.padEnd(17)} ${value}\n`);
  };
  say('zip', out);
  say('sha256', sha256);
  say('fingerprint', code);
  say('version', version);
  say('source_date_epoch', String(epoch));
  say('node', process.version);
  say('zlib', process.versions.zlib);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // A refusal of ours, or a file system answer (no build at that path): said, not thrown.
    const said = error instanceof ZipError || error instanceof RangeError;
    if (!(said || (error instanceof Error && 'code' in error))) throw error;
    process.stderr.write(`release:zip: ${error.message}\n`);
    process.exitCode = 1;
  }
}
