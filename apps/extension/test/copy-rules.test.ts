/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The copy rules: no "scrobble", "credential" or "DPoP" in anything a person reads;
// "russia"/"russian" in lower case; and the product's names only from `src/brand.ts` — a message
// carries `{product}` / `{extension}`, and no string in the code spells "MediaTracker" itself.
// The rendered pages are checked in src/ui/rendered-copy.test.tsx; this file checks every
// catalog and every string literal.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const APP = fileURLToPath(new URL('..', import.meta.url));
const MESSAGES = join(APP, 'src/i18n/messages');

/** The words that never appear in copy, as whole words or parts of one ("Scrobbling"). */
const JARGON = /scrobbl|credential|dpop/iu;
const PRODUCT = 'MediaTracker';

/** Every occurrence of "russia…" in `text` that is not written in lower case. */
function capitalisedRussia(text: string): string[] {
  return [...text.matchAll(/russia\p{L}*/giu)]
    .map((m) => m[0])
    .filter((w) => w !== w.toLowerCase());
}

function catalogs(): readonly (readonly [string, Readonly<Record<string, string>>])[] {
  return readdirSync(MESSAGES)
    .filter((name) => name.endsWith('.json'))
    .map((name) => [
      name,
      JSON.parse(readFileSync(join(MESSAGES, name), 'utf8')) as Record<string, string>,
    ]);
}

describe('message catalogs', () => {
  test('there is at least the English source catalog', () => {
    expect(catalogs().map(([name]) => name)).toContain('en.json');
  });

  test.each(catalogs())('%s: no "scrobble", "credential" or "DPoP"', (_name, messages) => {
    const offenders = Object.entries(messages).filter(([, value]) => JARGON.test(value));
    expect(offenders).toEqual([]);
  });

  test.each(catalogs())('%s: "russia" and "russian" only in lower case', (_name, messages) => {
    const offenders = Object.entries(messages).filter(
      ([, value]) => capitalisedRussia(value).length > 0,
    );
    expect(offenders).toEqual([]);
  });

  test.each(catalogs())(
    '%s: the product is named only through {product} / {extension}',
    (_name, messages) => {
      const offenders = Object.entries(messages).filter(([, value]) => value.includes(PRODUCT));
      expect(offenders).toEqual([]);
    },
  );
});

/** Source files that ship: everything under src/ but tests, test helpers and generated catalogs. */
function shippedSources(dir = join(APP, 'src')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path === join(APP, 'src/i18n/generated')) continue;
      out.push(...shippedSources(path));
    } else if (
      /\.(?:ts|tsx)$/u.test(entry.name) &&
      !/\.test\.tsx?$/u.test(entry.name) &&
      entry.name !== 'test-harness.ts'
    ) {
      out.push(path);
    }
  }
  return out;
}

/** The text of every string literal, template piece and JSX text in a file. */
function literals(path: string): string[] {
  const text = readFileSync(path, 'utf8');
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('string literals in the shipped code', () => {
  const sources = shippedSources();

  test('the walk finds the brand file and the pages (a gate that sees nothing proves nothing)', () => {
    const names = sources.map((p) => relative(APP, p));
    expect(names).toContain('src/brand.ts');
    expect(names).toContain('src/ui/popup/Popup.tsx');
  });

  test('only src/brand.ts spells the product name', () => {
    const offenders = sources
      .filter((p) => relative(APP, p) !== 'src/brand.ts')
      .flatMap((p) =>
        literals(p)
          .filter((s) => s.includes(PRODUCT))
          .map((s) => `${relative(APP, p)}: ${s}`),
      );
    expect(offenders).toEqual([]);
    expect(
      literals(join(APP, 'src/brand.ts')).filter((s) => s.includes(PRODUCT)).length,
    ).toBeGreaterThan(0);
  });

  test('JSX text never carries copy of its own: every word a page shows comes from t()', () => {
    const offenders = sources
      .filter((p) => p.endsWith('.tsx'))
      .flatMap((p) => {
        const text = readFileSync(p, 'utf8');
        const file = ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const words: string[] = [];
        const visit = (node: ts.Node): void => {
          if (ts.isJsxText(node) && /\p{L}/u.test(node.text)) words.push(node.text.trim());
          ts.forEachChild(node, visit);
        };
        visit(file);
        return words.map((w) => `${relative(APP, p)}: ${w}`);
      });
    expect(offenders).toEqual([]);
  });
});
