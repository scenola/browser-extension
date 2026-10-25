/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The i18n tools: a message `{count, plural, one {# viewing} other {# viewings}}` compiles to a
// function giving "1 viewing"/"2 viewings"; a missing key in `de.json` falls back to English; an
// unused key fails `pnpm i18n:check`; the locales map turns `nb` into `no` and `zh-Hans` into
// `zh_CN`; every key is present or falls back to English. Plural categories are CLDR's; Chrome's `_locales` folder names are
// the ones the Chrome Web Store supports.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { afterAll, describe, expect, it } from 'vitest';

import { createFormatter } from '../../apps/extension/src/i18n/runtime.ts';
import type { Formatter, Params } from '../../apps/extension/src/i18n/runtime.ts';
import { localeFiles } from './compile';
import { compileMessage, messageFunction } from './icu';
import { WEB_LOCALES, folderLocales } from './locales-map';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

type Message = (p: Params, f: Formatter) => string;

/** A compiled message's source, evaluated with nothing in scope. */
function compiled(locale: string, message: string): Message {
  return runInNewContext(`(${compileMessage(locale, 'test.key', message)})`) as Message;
}

describe('ICU messages compile to plain functions', () => {
  it('a plural gives "1 viewing" and "2 viewings"', () => {
    const message = compiled('en', '{count, plural, one {# viewing} other {# viewings}}');
    const f = createFormatter('en');
    expect(message({ count: 1 }, f)).toBe('1 viewing');
    expect(message({ count: 2 }, f)).toBe('2 viewings');
    // CLDR English: 0 is "other".
    expect(message({ count: 0 }, f)).toBe('0 viewings');
  });

  it("a language's own plural categories are its own (CLDR Polish: one, few, many)", () => {
    const message = compiled(
      'pl',
      '{count, plural, one {# film} few {# filmy} many {# filmów} other {# filmu}}',
    );
    const f = createFormatter('pl');
    expect([1, 3, 5, 22, 25].map((count) => message({ count }, f))).toEqual([
      '1 film',
      '3 filmy',
      '5 filmów',
      '22 filmy',
      '25 filmów',
    ]);
  });

  it('a category the language does not have is refused at compile time', () => {
    // CLDR English has no "few".
    expect(() => compileMessage('en', 'k', '{n, plural, few {#} other {#}}')).toThrow();
  });

  it('a hostile translation compiles to its own text, and its source closes nothing', () => {
    const text = 'a "quote", a \\ backslash, a `tick`, ${p}, </script> and a\u{2028}line';
    // ICU quotes braces and tags with apostrophes, so the text reaches the compiler as written.
    const icu = text.replace('${p}', () => "$'{p}'").replace('</script>', "'</script>'");
    expect(compileMessage('en', 'test.key', icu)).not.toMatch(/<\/script|\u{2028}/u);
    expect(compiled('en', icu)({}, createFormatter('en'))).toBe(text);
  });

  it('a hostile selector stays a selector', () => {
    const selector = '"]: 0, x: (() => { throw 1; })(), [" </script>\u{2028}';
    const source = messageFunction([['x', 'k', { [selector]: ['chosen'], other: ['other'] }]]);
    expect(source).not.toMatch(/<\/script|\u{2028}/u);
    const message = runInNewContext(`(${source})`) as Message;
    expect(message({ k: selector }, createFormatter('en'))).toBe('chosen');
    expect(message({ k: 'else' }, createFormatter('en'))).toBe('other');
  });
});

describe('a key a translation lacks falls back to English', () => {
  it("the manifest's German strings take English text for a key de.json lacks", () => {
    const en = {
      'manifest.extName': '{extension}',
      'manifest.extDescription': 'Adds what you finish watching to {product}.',
    };
    const de = { 'manifest.extName': '{extension}' };
    const files = localeFiles(
      new Map([
        ['en', en],
        ['de', de],
      ]),
    );
    const german = JSON.parse(files.get('_locales/de/messages.json') ?? '{}') as Record<
      string,
      { message: string }
    >;
    const english = JSON.parse(files.get('_locales/en/messages.json') ?? '{}') as Record<
      string,
      { message: string }
    >;
    expect(german.extDescription?.message).toBe(english.extDescription?.message);
    expect(german.extDescription?.message).toContain('Adds what you finish watching to');
  });
});

describe('the locales map', () => {
  const map = folderLocales([...WEB_LOCALES]);
  const folderOf = (locale: string): string | undefined =>
    [...map].find(([, l]) => l === locale)?.[0];

  it('maps nb to no, zh-Hans to zh_CN and the rest as the table lists', () => {
    expect(folderOf('nb')).toBe('no');
    expect(folderOf('zh-Hans')).toBe('zh_CN');
    expect(folderOf('zh-Hant')).toBe('zh_TW');
    expect(folderOf('pt-BR')).toBe('pt_BR');
    expect(folderOf('pt-PT')).toBe('pt_PT');
    expect(map.has('sr')).toBe(true);
    expect(['sr-Cyrl', 'sr-Latn']).toContain(map.get('sr'));
    for (const plain of ['en', 'de', 'uk', 'ja']) expect(folderOf(plain)).toBe(plain);
  });

  it("covers the web app's 32 locales, two of them in one sr folder", () => {
    expect(WEB_LOCALES).toHaveLength(32);
    expect(map.size).toBe(31);
  });

  it('names only folders Chrome supports', () => {
    // developer.chrome.com, "Locales supported by the Chrome Web Store".
    const CHROME = new Set(
      (
        'ar am bg bn ca cs da de el en en_AU en_GB en_US es es_419 et fa fi fil fr gu he hi hr ' +
        'hu id it ja kn ko lt lv ml mr ms nl no pl pt_BR pt_PT ro ru sk sl sr sv sw ta te th tr ' +
        'uk vi zh_CN zh_TW'
      ).split(' '),
    );
    for (const folder of map.keys()) expect(CHROME.has(folder)).toBe(true);
  });

  const FRONTEND = join(ROOT, '..', 'frontend', 'src', 'i18n', 'locales.ts');
  it.skipIf(!existsSync(FRONTEND))("is the web app's own list (a sibling checkout)", async () => {
    const text = await readFile(FRONTEND, 'utf8');
    const list = /UI_LOCALES = \[([^\]]*)\]/u.exec(text)?.[1] ?? '';
    const tags = [...list.matchAll(/"([^"]+)"/gu)].map((m) => m[1]);
    expect([...WEB_LOCALES].sort()).toEqual(tags.sort());
  });
});

// `pnpm i18n:check` reads the repository's own catalogs and sources, so it is run here on a
// small copy of that layout in the OS temp dir: the real tool, its own files, a synthetic tree.
describe('pnpm i18n:check', () => {
  const scratch: string[] = [];
  afterAll(async () => {
    await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tree(messages: Readonly<Record<string, string>>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mt-i18n-test-'));
    scratch.push(dir);
    const place = async (from: string, to: string): Promise<void> => {
      await mkdir(join(dir, to, '..'), { recursive: true });
      await copyFile(join(ROOT, from), join(dir, to));
    };
    await place('tools/i18n/compile.ts', 'tools/i18n/compile.ts');
    await place('tools/i18n/icu.ts', 'tools/i18n/icu.ts');
    await place('tools/i18n/locales-map.ts', 'tools/i18n/locales-map.ts');
    await place('apps/extension/src/brand.ts', 'apps/extension/src/brand.ts');
    await symlink(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    const write = async (path: string, text: string): Promise<void> => {
      await mkdir(join(dir, path, '..'), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await write('packages/core/src/domain/messages.ts', "export type MessageKey = 'core.used';\n");
    await write('apps/extension/src/page.ts', "export const words = t('app.used');\n");
    await write('apps/extension/src/i18n/messages/en.json', JSON.stringify(messages, null, 2));
    return dir;
  }

  const BASE = {
    'manifest.extName': '{extension}',
    'manifest.extDescription': 'Adds what you finish watching to {product}.',
    'core.used': 'Core',
    'app.used': 'App',
  };

  /** Compiles the tree's catalogs, then checks it: the exit status of `--check`. */
  function check(dir: string): number {
    const tool = join(dir, 'tools', 'i18n', 'compile.ts');
    execFileSync(process.execPath, [tool, '--write'], { cwd: dir, stdio: 'pipe' });
    try {
      execFileSync(process.execPath, [tool, '--check'], { cwd: dir, stdio: 'pipe' });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? -1;
    }
  }

  it('passes when every key is used', async () => {
    expect(check(await tree(BASE))).toBe(0);
  });

  it('fails on a key nothing uses', async () => {
    expect(check(await tree({ ...BASE, 'app.unused': 'Nobody says this' }))).not.toBe(0);
  });
});
