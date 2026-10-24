/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `pnpm docs:services` regenerates docs/services.md from the registry (id, name, hosts, module or
// generic, verified when), and CI checks it is current. Its output lists seven sites with
// `module`/`generic` correctly: the seven, their ids and hosts, and which read through a module.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BUILT_IN_SITES } from '../../packages/services/src/registry.ts';
import type { BuiltInSite } from '../../packages/services/src/registry.ts';
import { servicesMarkdown } from './services-md';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The built-in sites: id → its hosts and whether v1 reads it through a module. */
const SPEC_SITES: readonly (readonly [string, string, 'module' | 'generic'])[] = [
  ['netflix', 'netflix.com', 'module'],
  ['apple_tv', 'tv.apple.com', 'module'],
  ['prime_video', 'primevideo.com', 'generic'],
  ['disney_plus', 'disneyplus.com', 'generic'],
  ['hbo_max', 'hbomax.com', 'generic'],
  ['crunchyroll', 'crunchyroll.com', 'generic'],
  ['paramount_plus', 'paramountplus.com', 'generic'],
];

const cellsOf = (row: string): string[] =>
  row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());

/** The table's rows, by the id in their first cell (a Markdown table, however it is padded). */
function rows(markdown: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = cellsOf(line);
    const id = /^`([a-z_]+)`$/u.exec(cells[0] ?? '')?.[1];
    if (id === undefined) continue;
    expect(out.has(id)).toBe(false);
    out.set(id, cells);
  }
  return out;
}

describe('docs:services', () => {
  it('lists the seven built-in sites, each once, with its hosts', async () => {
    const table = rows(await servicesMarkdown(BUILT_IN_SITES));
    expect([...table.keys()].sort()).toEqual(SPEC_SITES.map(([id]) => id).sort());
    for (const [id, host] of SPEC_SITES) {
      expect(table.get(id)?.join(' ')).toContain(`\`${host}\``);
    }
  });

  it('says module for Netflix and Apple TV and generic readers for the other five', async () => {
    const table = rows(await servicesMarkdown(BUILT_IN_SITES));
    for (const [id, , readBy] of SPEC_SITES) {
      const joined = (table.get(id) ?? []).join(' ').toLowerCase();
      if (readBy === 'module') {
        expect(joined).toContain('module');
        expect(joined).not.toContain('generic');
      } else {
        expect(joined).toContain('generic');
        expect(joined).not.toMatch(/\bmodule\b/u);
      }
    }
  });

  it('says when a module was verified, and that an unverified one is not yet', async () => {
    const [netflix, ...others] = BUILT_IN_SITES;
    if (netflix?.module === null || netflix?.module === undefined) {
      throw new TypeError('the registry should attach the Netflix module');
    }
    const verified: BuiltInSite = {
      ...netflix,
      module: { ...netflix.module, verified: { on: '2026-10-01', by: 'maintainer' } },
    };
    const table = rows(await servicesMarkdown([verified, ...others]));
    expect(table.get('netflix')?.join(' ')).toContain('2026-10-01');
    expect(table.get('apple_tv')?.join(' ')).not.toContain('2026-10-01');
  });

  it('the committed docs/services.md is current (`pnpm docs:services --check` passes)', () => {
    // CI checks it is current.
    expect(() =>
      execFileSync(process.execPath, ['tools/docs/services-md.ts', '--check'], {
        cwd: ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});
