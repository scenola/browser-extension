/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The manifest a real build writes, built with WXT's own API into a temporary directory, in each
// of the three modes. Every expected value is written here from the requirements, never read
// from the build: the permissions, the content security policies, the sandbox page, the built-in
// hosts, and the bootstrap as the one content script.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, test } from 'vitest';
import { build } from 'wxt';

const APP = fileURLToPath(new URL('..', import.meta.url));

/** Builds take tens of seconds; WXT's own work, not a timing assertion. */
const BUILD_TIMEOUT_MS = 240_000;

type Manifest = Record<string, unknown> & {
  readonly permissions?: readonly string[];
  readonly host_permissions?: readonly string[];
  readonly optional_host_permissions?: readonly string[];
  readonly content_scripts?: readonly Record<string, unknown>[];
  readonly content_security_policy?: {
    readonly extension_pages?: string;
    readonly sandbox?: string;
  };
  readonly sandbox?: { readonly pages?: readonly string[] };
};

const MT_VARIABLES = [
  'MT_API_BASE_URL',
  'MT_WEB_APP_BASE_URL',
  'MT_AUTH_STRATEGIES',
  'MT_TEST_APPROVE_URL',
] as const;

const quiet = {
  debug: () => undefined,
  log: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  success: () => undefined,
  level: 0,
};

/** Builds the extension in `mode` with exactly `env` as its `MT_*` environment. */
async function manifestOf(
  mode: string,
  env: Partial<Record<(typeof MT_VARIABLES)[number], string>>,
): Promise<Manifest> {
  const outDir = await mkdtemp(join(tmpdir(), 'mt-manifest-'));
  const saved = Object.fromEntries(MT_VARIABLES.map((name) => [name, process.env[name]]));
  // A build sets NODE_ENV to `production` (wxt.config.ts); this process's tests keep theirs.
  const nodeEnv = process.env.NODE_ENV;
  for (const name of MT_VARIABLES) Reflect.deleteProperty(process.env, name);
  Object.assign(process.env, env);
  try {
    await build({ root: APP, mode, outDir, logger: quiet });
    const text = await readFile(join(outDir, 'chrome-mv3', 'manifest.json'), 'utf8');
    return JSON.parse(text) as Manifest;
  } finally {
    if (nodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
    else process.env.NODE_ENV = nodeEnv;
    for (const name of MT_VARIABLES) {
      const value = saved[name];
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    await rm(outDir, { recursive: true, force: true });
  }
}

/** The seven built-ins' hosts. */
const BUILT_IN_HOSTS = [
  'netflix.com',
  'tv.apple.com',
  'primevideo.com',
  'disneyplus.com',
  'hbomax.com',
  'crunchyroll.com',
  'paramountplus.com',
];

/** Each built-in host as `https://*.<host>/*` and `https://<host>/*`. */
const BUILT_IN_PATTERNS = BUILT_IN_HOSTS.flatMap((host) => [
  `https://*.${host}/*`,
  `https://${host}/*`,
]);

/** The committed development API origin. */
const DEV_API = 'http://localhost:8000';

/**
 * The extension pages' policy (`connect-src` allows `'self'` and the API origin; `frame-src`
 * only the extension's own pages, so the sandbox's frame cannot be navigated to the web).
 */
const csp = (apiOrigin: string): string =>
  `script-src 'self'; object-src 'none'; base-uri 'none'; require-trusted-types-for 'script'; ` +
  `connect-src 'self' ${apiOrigin}; img-src 'self' data:; font-src 'self'; style-src 'self'; ` +
  `frame-src 'self'`;

/**
 * The sandboxed interpretation page's own policy: nothing loaded, and a worker only from a `blob:`
 * address — the modules' worker, which has no document to add a resource hint to.
 */
const SANDBOX_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self'; worker-src blob:";

const sorted = (xs: readonly string[] | undefined): string[] => [...(xs ?? [])].sort();

describe('the manifest of a development build', () => {
  let manifest: Manifest;

  beforeAll(async () => {
    manifest = await manifestOf('development', {});
  }, BUILD_TIMEOUT_MS);

  // No `tabs` and no `webRequest`.
  test('permissions are exactly storage, identity, alarms, scripting, offscreen, activeTab', () => {
    expect(sorted(manifest.permissions)).toEqual(
      sorted(['storage', 'identity', 'alarms', 'scripting', 'offscreen', 'activeTab']),
    );
  });

  test('host_permissions are every built-in host and the API origin, nothing else', () => {
    expect(sorted(manifest.host_permissions)).toEqual(
      sorted([...BUILT_IN_PATTERNS, `${DEV_API}/*`]),
    );
  });

  // Prime Video is primevideo.com only; HBO Max is hbomax.com, not max.com
  test('no Amazon store domain and no max.com is asked for', () => {
    const hosts = [
      ...(manifest.host_permissions ?? []),
      ...(manifest.content_scripts ?? []).flatMap((s) => (s.matches as string[] | undefined) ?? []),
    ];
    expect(hosts.filter((p) => p.includes('amazon.'))).toEqual([]);
    expect(hosts.filter((p) => /(^|[/.])max\.com\//u.test(p))).toEqual([]);
  });

  test('optional host permissions are https://*/* and http://*/*', () => {
    expect(sorted(manifest.optional_host_permissions)).toEqual(
      sorted(['https://*/*', 'http://*/*']),
    );
  });

  test('there are no web_accessible_resources and no externally_connectable', () => {
    expect(manifest).not.toHaveProperty('web_accessible_resources');
    expect(manifest).not.toHaveProperty('externally_connectable');
  });

  test('the sandbox page is declared', () => {
    expect(manifest.sandbox?.pages).toEqual(['sandbox.html']);
  });

  test('the content security policies are exactly the declared ones', () => {
    expect(manifest.content_security_policy?.extension_pages).toBe(csp(DEV_API));
    expect(manifest.content_security_policy?.sandbox).toBe(SANDBOX_CSP);
  });

  // The bootstrap is the one content script: built-in hosts, all frames, match_origin_as_fallback,
  // document_start.
  test('the bootstrap is the only content script, on the built-in hosts', () => {
    const scripts = manifest.content_scripts ?? [];
    expect(scripts).toHaveLength(1);
    const [bootstrap] = scripts;
    expect(bootstrap?.js).toEqual(['bootstrap.js']);
    expect(sorted(bootstrap?.matches as string[] | undefined)).toEqual(sorted(BUILT_IN_PATTERNS));
    expect(bootstrap?.all_frames).toBe(true);
    expect(bootstrap?.match_origin_as_fallback).toBe(true);
    expect(bootstrap?.run_at).toBe('document_start');
  });

  test('incognito is spanning and Chrome 120 is the minimum', () => {
    expect(manifest.incognito).toBe('spanning');
    expect(manifest.minimum_chrome_version).toBe('120');
    expect(manifest.manifest_version).toBe(3);
  });

  // The development key is in development and e2e builds only.
  test('a development build carries the committed development key', async () => {
    const committed = (await readFile(join(APP, 'dev-key.pub'), 'utf8')).trim();
    expect(manifest.key).toBe(committed);
  });

  // An e2e build adds <all_urls>; a development build is not one.
  test('a development build does not ask for <all_urls>', () => {
    expect(manifest.host_permissions).not.toContain('<all_urls>');
  });
});

describe('an e2e build', () => {
  let manifest: Manifest;

  beforeAll(async () => {
    manifest = await manifestOf('e2e', {});
  }, BUILD_TIMEOUT_MS);

  // An e2e build adds <all_urls> to host_permissions.
  test('asks for <all_urls> on top of the built-ins and the API', () => {
    expect(manifest.host_permissions).toContain('<all_urls>');
    for (const pattern of [...BUILT_IN_PATTERNS, `${DEV_API}/*`]) {
      expect(manifest.host_permissions).toContain(pattern);
    }
  });

  test('carries the development key', () => {
    expect(manifest.key).toEqual(expect.any(String));
  });
});

describe('a store build', () => {
  const STORE_ENV = {
    MT_API_BASE_URL: 'https://api.example.com',
    MT_WEB_APP_BASE_URL: 'https://app.example.com',
  };
  let manifest: Manifest;

  beforeAll(async () => {
    manifest = await manifestOf('store', STORE_ENV);
  }, BUILD_TIMEOUT_MS);

  // <all_urls> is never in store builds.
  test('never asks for <all_urls> or any host beyond the built-ins and the API', () => {
    expect(sorted(manifest.host_permissions)).toEqual(
      sorted([...BUILT_IN_PATTERNS, 'https://api.example.com/*']),
    );
  });

  test('carries no development key', () => {
    expect(manifest).not.toHaveProperty('key');
  });

  test('its connect-src is the extension and the configured API origin', () => {
    expect(manifest.content_security_policy?.extension_pages).toBe(csp('https://api.example.com'));
  });

  // The sandbox's own policy governs what it loads, not where its frame goes: the page that
  // frames it must allow nothing but the extension's own pages there.
  test('its pages frame only the extension’s own pages', () => {
    const directives = (manifest.content_security_policy?.extension_pages ?? '').split('; ');
    expect(directives).toContain("frame-src 'self'");
  });

  // The same permissions in every mode.
  test('its permissions are the same six', () => {
    expect(sorted(manifest.permissions)).toEqual(
      sorted(['storage', 'identity', 'alarms', 'scripting', 'offscreen', 'activeTab']),
    );
    expect(manifest).not.toHaveProperty('web_accessible_resources');
  });
});

describe('a store build is refused', () => {
  // The store-mode build with a localhost URL throws `store builds need MT_API_BASE_URL`.
  test(
    'with the committed localhost API URL',
    async () => {
      await expect(
        manifestOf('store', { MT_WEB_APP_BASE_URL: 'https://app.example.com' }),
      ).rejects.toThrow('store builds need MT_API_BASE_URL');
      await expect(
        manifestOf('store', {
          MT_API_BASE_URL: 'http://localhost:8000',
          MT_WEB_APP_BASE_URL: 'https://app.example.com',
        }),
      ).rejects.toThrow('store builds need MT_API_BASE_URL');
    },
    BUILD_TIMEOUT_MS,
  );

  // A build fails when MODE=store and either URL is localhost.
  test(
    'with a localhost web app URL',
    async () => {
      await expect(
        manifestOf('store', {
          MT_API_BASE_URL: 'https://api.example.com',
          MT_WEB_APP_BASE_URL: 'http://localhost:3000',
        }),
      ).rejects.toThrow();
    },
    BUILD_TIMEOUT_MS,
  );

  // A build also fails when AUTH_STRATEGIES holds anything but pkce_dpop.
  test.each(['pkce_dpop,personal_token', 'personal_token', 'test'])(
    'with MT_AUTH_STRATEGIES=%s',
    async (strategies) => {
      await expect(
        manifestOf('store', {
          MT_API_BASE_URL: 'https://api.example.com',
          MT_WEB_APP_BASE_URL: 'https://app.example.com',
          MT_AUTH_STRATEGIES: strategies,
        }),
      ).rejects.toThrow();
    },
    BUILD_TIMEOUT_MS,
  );
});
