/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `deterministicZip`: two runs over the same directory give the same hash, and touching a file's
// mtime does not change it; entries are sorted with fixed timestamps (reproducible from
// `SOURCE_DATE_EPOCH`) and fixed permissions, and it returns the SHA-256. The zip is read back by this file's own reader of the format (PKWARE APPNOTE 6.3:
// end of central directory, central and local headers, DOS date and time), never by the tool's.

import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import { deterministicZip } from './deterministic-zip';

const EPOCH = 1_792_687_194; // 2026-10-22T16:39:54Z: an even second, so DOS time holds it exactly
const FILES: Readonly<Record<string, string>> = {
  'z.txt': 'last',
  'b/d.html': '<!doctype html><title>d</title>',
  'a.js': 'console.log("a");\n',
  'b/c.css': 'body { color: black }\n',
  'manifest.json': '{"manifest_version":3}',
};
/** The same names in code-unit order, the order a sorted zip lists them in. */
const SORTED = ['a.js', 'b/c.css', 'b/d.html', 'manifest.json', 'z.txt'];

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mt-zip-test-'));
  scratch.push(dir);
  return dir;
}

/** A build folder holding FILES, written in a scrambled order. */
async function buildFolder(): Promise<string> {
  const dir = await tempDir();
  for (const name of Object.keys(FILES).reverse()) {
    const path = join(dir, ...name.split('/'));
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, FILES[name] ?? '');
  }
  return dir;
}

async function zipOf(dir: string, epoch = EPOCH): Promise<{ hash: string; bytes: Buffer }> {
  const out = join(await tempDir(), 'release.zip');
  const hash = await deterministicZip(dir, out, epoch);
  return { hash, bytes: await readFile(out) };
}

interface CentralEntry {
  readonly name: string;
  readonly method: number;
  readonly time: number;
  readonly date: number;
  readonly externalAttributes: number;
  readonly data: Buffer;
}

/** The central directory of a zip without ZIP64, by APPNOTE 6.3 §4.3.12 and §4.3.16. */
function centralDirectory(zip: Buffer): CentralEntry[] {
  let end = -1;
  for (let at = zip.length - 22; at >= 0; at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  expect(end).toBeGreaterThanOrEqual(0);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const time = zip.readUInt16LE(at + 12);
    const date = zip.readUInt16LE(at + 14);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const externalAttributes = zip.readUInt32LE(at + 38);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    entries.push({ name, method, time, date, externalAttributes, data });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** MS-DOS date and time of a moment in UTC (APPNOTE 6.3 §4.4.6). */
function dosUtc(epochSeconds: number): { time: number; date: number } {
  const d = new Date(epochSeconds * 1000);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

describe('deterministicZip', () => {
  it('two runs over the same directory give the same hash and the same bytes', async () => {
    const dir = await buildFolder();
    const first = await zipOf(dir);
    const second = await zipOf(dir);
    expect(second.hash).toBe(first.hash);
    expect(second.bytes.equals(first.bytes)).toBe(true);
  });

  it('answers the SHA-256 of the zip it wrote', async () => {
    const { hash, bytes } = await zipOf(await buildFolder());
    expect(hash).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it("touching a file's mtime does not change the hash", async () => {
    const dir = await buildFolder();
    const before = await zipOf(dir);
    const old = new Date('2001-02-03T04:05:06Z');
    await utimes(join(dir, 'a.js'), old, old);
    await utimes(join(dir, 'b', 'c.css'), new Date(), new Date());
    expect((await zipOf(dir)).hash).toBe(before.hash);
  });

  it("a file's mode does not change the hash (fixed permissions)", async () => {
    const dir = await buildFolder();
    const before = await zipOf(dir);
    await chmod(join(dir, 'a.js'), 0o600);
    await chmod(join(dir, 'z.txt'), 0o755);
    expect((await zipOf(dir)).hash).toBe(before.hash);
  });

  it('two copies of the same files in different folders give the same hash', async () => {
    expect((await zipOf(await buildFolder())).hash).toBe((await zipOf(await buildFolder())).hash);
  });

  it("the builder's time zone does not change the hash", async () => {
    const dir = await buildFolder();
    const zone = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const utc = await zipOf(dir);
      process.env.TZ = 'Pacific/Kiritimati';
      expect(new Date(0).getTimezoneOffset()).not.toBe(0); // the zone took effect
      expect((await zipOf(dir)).hash).toBe(utc.hash);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it('lists its entries sorted, every one stamped with SOURCE_DATE_EPOCH in UTC, all with one mode', async () => {
    const entries = centralDirectory((await zipOf(await buildFolder())).bytes);
    expect(entries.map((e) => e.name)).toEqual(SORTED);
    const stamp = dosUtc(EPOCH);
    for (const e of entries) expect({ time: e.time, date: e.date }).toEqual(stamp);
    expect(new Set(entries.map((e) => e.externalAttributes)).size).toBe(1);
  });

  it('another epoch is another zip', async () => {
    const dir = await buildFolder();
    expect((await zipOf(dir, EPOCH + 86_400)).hash).not.toBe((await zipOf(dir)).hash);
  });

  it('holds every file, byte for byte', async () => {
    const entries = centralDirectory((await zipOf(await buildFolder())).bytes);
    for (const e of entries) expect(e.data.toString('utf8')).toBe(FILES[e.name]);
  });

  it('one changed byte of a file changes the hash', async () => {
    const dir = await buildFolder();
    const before = await zipOf(dir);
    await writeFile(join(dir, 'a.js'), 'console.log("b");\n');
    expect((await zipOf(dir)).hash).not.toBe(before.hash);
  });
});
