/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The build. Everything here runs in Node, at build time: the configuration is resolved and
// refused here (src/config-rules.ts), the manifest is generated from the service registry and
// checked after WXT writes it (build/manifest.ts), the registry's data is generated for the
// worker and the content scripts (build/sites-data.ts), the icons and the `_locales/` strings
// are made, the output is checked (build/output-check.ts), and the fingerprint is written last.
//
//   wxt build --mode development | store | e2e      (no other mode builds)
//
// **Every build is a production build**. The mode chooses the configuration — the origins, the
// sign-in strategies, the pseudo-locale — never the compiler. WXT sets `NODE_ENV` to the mode
// (`??=`), so Vite would build `--mode store` as development: Preact's JSX development
// transform, which writes every element's absolute source path into the bundle.

import { readFileSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { allBuiltInHosts } from '@mt/services';
import { loadEnv } from 'vite';
import { defineConfig } from 'wxt';

import { localeFiles, readCatalogs, readCoreKeys, workerFiles } from '../../tools/i18n/compile.ts';
import { PSEUDO_LOCALE } from '../../tools/i18n/locales-map.ts';
import { renderIcons } from '../../tools/icons/render.ts';
import { fingerprint } from '../../tools/release/fingerprint.ts';
import { extensionDefines } from './build/defines.ts';
import { ICON_SIZES, MARKS, buildManifest, checkManifest } from './build/manifest.ts';
import { noticesCollector, noticesText } from './build/notices.ts';
import { checkBuildOutput } from './build/output-check.ts';
import { buildDay, buildSitesData } from './build/sites-data.ts';
import { EXTENSION_NAME } from './src/brand.ts';
import { resolveConfig } from './src/config-rules.ts';
import type { ExtensionConfig } from './src/config-rules.ts';
import type { SitesData } from './src/sites.ts';
import { NOTICES_FILE } from './src/ui/source.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
/** The repository: no built file may name it, nor the builder's home (build/output-check.ts). */
const WORKSPACE = fileURLToPath(new URL('../../', import.meta.url));
const FORBIDDEN_PATHS = [WORKSPACE, realpathSync(WORKSPACE), homedir()];
/** What only a development build may carry. */
const FORBIDDEN_OUTSIDE_DEVELOPMENT = [
  { text: PSEUDO_LOCALE, what: 'the development-only pseudo-locale' },
];
/** What a store build may not carry: the strategies it does not offer. */
const FORBIDDEN_IN_STORE = [
  ...FORBIDDEN_OUTSIDE_DEVELOPMENT,
  { text: 'personal_token', what: 'the personal-token strategy' },
];
const ICON_SOURCES = join(ROOT, 'assets/icons');
/** Where the rendered icons wait to be copied into the build (`.wxt/` is never committed). */
const ICON_CACHE = join(ROOT, '.wxt/mt-icons');

interface Build {
  readonly config: ExtensionConfig;
  readonly sites: SitesData;
}

const builds = new Map<string, Build>();

/** The resolved configuration and registry data of a mode, made once per process. */
function buildFor(mode: string): Build {
  const known = builds.get(mode);
  if (known !== undefined) return known;
  // `.env`, `.env.<mode>` and the process environment, `MT_` variables only; the process wins.
  const config = resolveConfig(mode, loadEnv(mode, ROOT, 'MT_'));
  const sites = buildSitesData(config.mode, buildDay(process.env, new Date()));
  const build = { config, sites };
  builds.set(mode, build);
  return build;
}

const devKey = (): string => readFileSync(join(ROOT, 'dev-key.pub'), 'utf8').trim();

/** The packages each build ships, for its notices (build/notices.ts). */
const notices = noticesCollector();

export default defineConfig({
  srcDir: 'src',
  // One output for every mode: what `pnpm build` loads is `.output/chrome-mv3/`, and the
  // manifest and fingerprint.json say which mode made it.
  outDirTemplate: '{{browser}}-mv{{manifestVersion}}',
  imports: false,
  manifest: ({ mode }) => buildManifest(buildFor(mode).config, allBuiltInHosts(), devKey()),
  vite: ({ mode }) => {
    const { config, sites } = buildFor(mode);
    return {
      define: extensionDefines(config, sites),
      plugins: [notices.plugin],
      // The sandbox's worker is bundled on its own (src/entrypoints/sandbox/main.ts): what it
      // ships is in the notices too.
      worker: { plugins: () => [notices.plugin] },
      // Chrome 120 preloads modules itself; Vite's polyfill would only add code to every page.
      build: { target: 'chrome120', sourcemap: false, modulePreload: { polyfill: false } },
    };
  },
  hooks: {
    // Before Vite resolves any configuration: `isProduction`, and with it the JSX transform,
    // `import.meta.env.PROD` and the `production` export condition, is read from here.
    'config:resolved': (wxt) => {
      if (wxt.config.command === 'build') process.env.NODE_ENV = 'production';
    },
    // WXT defines `process.env.NODE_ENV` as the mode in the worker and the content scripts;
    // every bundle sees the one value Vite builds with instead.
    'vite:build:extendConfig': (_entrypoints, config) => {
      const nodeEnv = process.env.NODE_ENV ?? 'production';
      config.define = { ...config.define, 'process.env.NODE_ENV': JSON.stringify(nodeEnv) };
    },
    // The bootstrap runs on every built-in host from install: it is an unlisted script
    // (src/entrypoints/bootstrap.ts) that the manifest declares with the registry's matches
    // (build/manifest.ts), and `checkManifest` refuses any other content script.
    'entrypoints:resolved': (_wxt, entrypoints) => {
      for (const name of ['bootstrap', 'collector']) {
        if (!entrypoints.some((entry) => entry.type === 'unlisted-script' && entry.name === name)) {
          throw new Error(`the ${name} script is missing`);
        }
      }
    },
    'build:before': async () => {
      notices.reset();
      await renderIcons(ICON_SOURCES, ICON_CACHE, MARKS, ICON_SIZES);
    },
    'build:publicAssets': async (wxt, files) => {
      for (const mark of MARKS) {
        for (const size of ICON_SIZES) {
          const name = `${mark}-${String(size)}.png`;
          files.push({ absoluteSrc: join(ICON_CACHE, name), relativeDest: `icons/${name}` });
        }
      }
      const catalogs = await readCatalogs();
      for (const [relativeDest, contents] of localeFiles(catalogs)) {
        files.push({ relativeDest, contents });
      }
      // The worker's words in each translation, read on demand (src/i18n/worker-words.ts); the
      // pseudo-locale's in a development build alone.
      const pseudo = wxt.config.mode === 'development';
      for (const [relativeDest, contents] of workerFiles(catalogs, await readCoreKeys(), {
        pseudo,
      })) {
        files.push({ relativeDest, contents });
      }
    },
    'build:manifestGenerated': (wxt, manifest) => {
      checkManifest(manifest, buildFor(wxt.config.mode).config, wxt.config.command);
    },
    'build:done': async (wxt) => {
      await writeFile(
        join(wxt.config.outDir, NOTICES_FILE),
        await noticesText(notices.roots(), EXTENSION_NAME),
      );
      // The dev server's output is never loaded from anywhere but this checkout.
      if (wxt.config.command === 'build') {
        await checkBuildOutput(wxt.config.outDir, {
          forbiddenPaths: FORBIDDEN_PATHS,
          forbiddenText:
            wxt.config.mode === 'development'
              ? []
              : wxt.config.mode === 'store'
                ? FORBIDDEN_IN_STORE
                : FORBIDDEN_OUTSIDE_DEVELOPMENT,
        });
      }
      const sha256 = await fingerprint(wxt.config.outDir);
      await writeFile(
        join(wxt.config.outDir, 'fingerprint.json'),
        `${JSON.stringify({ fingerprint: sha256, algorithm: 'sha256' }, null, 2)}\n`,
      );
    },
  },
});
