/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `pnpm new:service <id>` creates packages/services/src/services/<id>/ with a defineService
// skeleton, an empty fixture, a failing test that names what to capture, and a README template,
// and refuses an existing id: `new:service netflix` fails (exists), `new:service demo` creates
// the four files. Everything
// is written into a temporary services folder, never into the repository's.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { ScaffoldError, newService } from './new-service';

const SRC = fileURLToPath(new URL('../../packages/services/src/', import.meta.url));

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A stand-in for `packages/services/src/`: the real SDK and helpers (linked) and an empty
 * `services/`, so a scaffolded module resolves `../../sdk` as it would in the repository.
 */
async function servicesRoot(): Promise<{ root: string; services: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mt-scaffold-test-'));
  scratch.push(root);
  await symlink(join(SRC, 'sdk.ts'), join(root, 'sdk.ts'));
  await symlink(join(SRC, 'helpers.ts'), join(root, 'helpers.ts'));
  const services = join(root, 'services');
  await mkdir(services);
  return { root, services };
}

/** A service that is not built in must name its hosts: there is no placeholder. */
const demo = (servicesDir: string) => ({ servicesDir, hosts: ['demo.example'] });

async function listAll(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name).slice(dir.length + 1));
  }
  return out.sort();
}

describe('new:service', () => {
  it('refuses netflix, which already exists, and writes nothing', async () => {
    const { services } = await servicesRoot();
    await mkdir(join(services, 'netflix'));
    await expect(newService('netflix', { servicesDir: services })).rejects.toBeInstanceOf(
      ScaffoldError,
    );
    expect(await listAll(services)).toEqual([]);
  });

  it('refuses netflix even where its folder is absent: the id has a module', async () => {
    const { services } = await servicesRoot();
    await expect(newService('netflix', { servicesDir: services })).rejects.toBeInstanceOf(
      ScaffoldError,
    );
    expect(await listAll(services)).toEqual([]);
  });

  it('refuses a demo that already exists, and keeps what is there', async () => {
    const { services } = await servicesRoot();
    await newService('demo', demo(services));
    const before = await listAll(services);
    await expect(newService('demo', demo(services))).rejects.toBeInstanceOf(ScaffoldError);
    expect(await listAll(services)).toEqual(before);
  });

  it('creates the four files for demo', async () => {
    const { services } = await servicesRoot();
    const written = await newService('demo', demo(services));
    const files = await listAll(join(services, 'demo'));
    expect(files).toHaveLength(4);
    expect(files).toEqual(
      expect.arrayContaining(['README.md', 'definition.test.ts', 'definition.ts']),
    );
    expect(files.filter((f) => /^fixtures\/[^/]+\.snapshot\.json$/u.test(f))).toHaveLength(1);
    expect(written.map((p) => p.slice(join(services, 'demo').length + 1)).sort()).toEqual(files);
  });

  it('the fixture is an empty sample in the fixture shape ({ synthetic, snapshot })', async () => {
    const { services } = await servicesRoot();
    await newService('demo', demo(services));
    const dir = join(services, 'demo', 'fixtures');
    const [name] = await readdir(dir);
    const fixture = JSON.parse(await readFile(join(dir, name ?? ''), 'utf8')) as unknown;
    expect(fixture).toMatchObject({ synthetic: expect.any(Boolean) as unknown, snapshot: {} });
  });

  it('the skeleton is a definition defineService accepts, with the id asked for', async () => {
    const { services } = await servicesRoot();
    await newService('demo', demo(services));
    const url = pathToFileURL(join(services, 'demo', 'definition.ts')).href;
    const module = (await import(url)) as Record<string, unknown>;
    const definitions = Object.values(module).filter(
      (v): v is { id: string } => typeof v === 'object' && v !== null && 'id' in v,
    );
    expect(definitions.map((d) => d.id)).toEqual(['demo']);
  });

  it('refuses a service that is not built in and names no host, and writes nothing', async () => {
    const { services } = await servicesRoot();
    for (const hosts of [undefined, []]) {
      const refusal = newService('demo', {
        servicesDir: services,
        ...(hosts === undefined ? {} : { hosts }),
      });
      await expect(refusal).rejects.toBeInstanceOf(ScaffoldError);
      await expect(refusal).rejects.toThrow(/--host/u);
    }
    expect(await listAll(services)).toEqual([]);
  });

  it('writes the hosts it was given, and no placeholder', async () => {
    const { services } = await servicesRoot();
    await newService('demo', { servicesDir: services, hosts: ['demo.test', 'demo.invalid'] });
    const text = await readFile(join(services, 'demo', 'definition.ts'), 'utf8');
    expect(text).toContain('"demo.test"');
    expect(text).toContain('"demo.invalid"');
    expect(text).not.toMatch(/placeholder|\.example/iu);
  });

  it('a built-in site without a module takes its hosts from the registry: no flag needed', async () => {
    const { services } = await servicesRoot();
    await newService('prime_video', { servicesDir: services });
    const text = await readFile(join(services, 'prime_video', 'definition.ts'), 'utf8');
    expect(text).toContain('"primevideo.com"');
  });

  it('the test loads its empty fixture as a JSON import, and still fails on purpose', async () => {
    const { services } = await servicesRoot();
    await newService('demo', demo(services));
    const text = await readFile(join(services, 'demo', 'definition.test.ts'), 'utf8');
    expect(text).toMatch(/import emptyFixture from ['"]\.\/fixtures\/empty\.snapshot\.json['"]/u);
    expect(text).toContain('expect.fail(');
  });

  it('the test names what to capture', async () => {
    const { services } = await servicesRoot();
    await newService('demo', demo(services));
    const text = await readFile(join(services, 'demo', 'definition.test.ts'), 'utf8');
    expect(text).toMatch(/captur/iu);
    expect(text).toMatch(/fixtures\//u);
  });

  it('writes nothing in the repository’s own services folder', async () => {
    const { services } = await servicesRoot();
    await newService('demo', demo(services));
    expect(existsSync(join(SRC, 'services', 'demo'))).toBe(false);
  });
});
