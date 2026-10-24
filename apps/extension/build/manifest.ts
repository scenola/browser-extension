/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The manifest: what wxt.config.ts hands WXT, and the rules the manifest WXT generates must
// keep — checked on the generated one, so an entrypoint option or a WXT default cannot widen it
// unnoticed. A store build that breaks one is refused, not shipped.

import type { UserManifest } from 'wxt';

import { connectOrigins } from '../src/config-rules.ts';
import type { ExtensionConfig } from '../src/config-rules.ts';
import { ALL_SITES_PATTERNS, domainPatterns } from '../src/host-patterns.ts';
import { BOOTSTRAP_FILE } from '../src/script-files.ts';

const MINIMUM_CHROME_VERSION = '120';

/** Exactly these; a build whose manifest asks for another is refused. */
const PERMISSIONS: readonly string[] = Object.freeze([
  'storage',
  'identity',
  'alarms',
  'scripting',
  'offscreen',
  'activeTab',
]);

/** What the all-sites switch asks for; a site *Track this site* asks for falls under it. */
const OPTIONAL_HOST_PERMISSIONS = ALL_SITES_PATTERNS;

/**
 * The sandboxed interpretation page's own policy: no network, no inline script, and a worker
 * only from a `blob:` address — the modules' worker, which the page makes from code it carries
 * (src/entrypoints/sandbox/main.ts) and which inherits this policy.
 */
const SANDBOX_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self'; worker-src blob:";

/**
 * The extension pages' policy, the worker's included: it is what `fetch` obeys. `'self'` in
 * `connect-src` lets the About screen read the extension's own `fingerprint.json`, which cannot
 * be bundled because the fingerprint hashes the bundles. `frame-src 'self'` keeps the offscreen
 * document's frame on the sandbox page: the sandbox's own policy stops what it loads, not where
 * it navigates, and a module that sent its frame to a web address would carry the snapshot
 * there — and receive every later one, which the offscreen page posts to whatever the frame holds.
 */
function extensionPagesCsp(config: ExtensionConfig): string {
  return [
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "require-trusted-types-for 'script'",
    `connect-src 'self' ${connectOrigins(config).join(' ')}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "style-src 'self'",
    "frame-src 'self'",
  ].join('; ');
}

/**
 * The bootstrap on every built-in host, in every frame, from document start.
 * `match_origin_as_fallback` reaches a player frame of `about:blank` or `blob:` whose origin is a
 * built-in host's. An unlisted script declared here rather than a WXT content script
 * (src/entrypoints/bootstrap.ts says why).
 */
function bootstrapContentScript(hosts: readonly string[]): BootstrapScript {
  return {
    matches: [...builtInHostPatterns(hosts)],
    js: [BOOTSTRAP_FILE],
    all_frames: true,
    match_origin_as_fallback: true,
    run_at: 'document_start',
  };
}

interface BootstrapScript {
  readonly matches: string[];
  readonly js: string[];
  readonly all_frames: true;
  readonly match_origin_as_fallback: true;
  readonly run_at: 'document_start';
}

/** The five toolbar marks, rendered at `ICON_SIZES` (tools/icons/render.ts). */
export const MARKS = [
  'mark-outline',
  'mark-filled',
  'mark-recording',
  'mark-check',
  'mark-dimmed',
] as const;
type Mark = (typeof MARKS)[number];
export const ICON_SIZES = [16, 24, 32, 48, 128] as const;

function iconPath(mark: Mark, size: number): string {
  return `icons/${mark}-${String(size)}.png`;
}

function iconSet(mark: Mark, sizes: readonly number[]): Record<string, string> {
  return Object.fromEntries(sizes.map((size) => [String(size), iconPath(mark, size)]));
}

/** Every built-in host, its subdomains included, over `https:`. */
function builtInHostPatterns(hosts: readonly string[]): readonly string[] {
  return hosts.flatMap((host) => domainPatterns(host));
}

/**
 * The manifest wxt.config.ts asks WXT for. Entrypoints add the rest (the worker, the bootstrap
 * content script, the popup, the options page, the sandbox page).
 *
 * - `host_permissions`: every built-in host and the API origin; an e2e build adds `<all_urls>`,
 *   because a permission prompt cannot be clicked in automation — never a store build.
 * - The development `key` pins the unpacked id in development and e2e builds only.
 */
export function buildManifest(
  config: ExtensionConfig,
  hosts: readonly string[],
  devKey: string,
): UserManifest {
  return {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    minimum_chrome_version: MINIMUM_CHROME_VERSION,
    permissions: [...PERMISSIONS],
    host_permissions: [
      ...builtInHostPatterns(hosts),
      `${config.apiBaseUrl}/*`,
      ...(config.mode === 'e2e' ? ['<all_urls>'] : []),
    ],
    optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS],
    content_scripts: [bootstrapContentScript(hosts)],
    content_security_policy: {
      extension_pages: extensionPagesCsp(config),
      sandbox: SANDBOX_CSP,
    },
    incognito: 'spanning',
    icons: iconSet('mark-filled', [16, 32, 48, 128]),
    action: {
      default_title: '__MSG_extName__',
      // Dimmed until the worker says otherwise: the default is "not tracking this page".
      default_icon: iconSet('mark-dimmed', [16, 24, 32]),
    },
    ...(config.mode === 'store' ? {} : { key: devKey }),
  };
}

/** A generated manifest that breaks one of this file's rules. */
class ManifestError extends Error {
  override readonly name = 'ManifestError';
}

interface GeneratedManifest {
  readonly permissions?: readonly string[] | undefined;
  readonly host_permissions?: readonly string[] | undefined;
  readonly optional_host_permissions?: readonly string[] | undefined;
  readonly web_accessible_resources?: unknown;
  readonly content_security_policy?: unknown;
  readonly content_scripts?: unknown;
  readonly key?: unknown;
  readonly externally_connectable?: unknown;
}

/**
 * The rules on the manifest WXT generated. `serve` (`wxt dev`) is checked for what a dev server
 * cannot need to break; WXT adds `tabs`, its own CSP source and the dev server's origin there.
 */
export function checkManifest(
  manifest: GeneratedManifest,
  config: ExtensionConfig,
  command: 'build' | 'serve',
): void {
  if (manifest.web_accessible_resources !== undefined) {
    throw new ManifestError('the manifest must not declare web_accessible_resources');
  }
  if (manifest.externally_connectable !== undefined) {
    throw new ManifestError('the manifest must not declare externally_connectable');
  }
  checkHosts(manifest, config);
  if (command === 'serve') return;
  checkBuilt(manifest, config);
}

/** The hosts a mode may ask for: a store build no more than the built-ins and the API. */
function checkHosts(manifest: GeneratedManifest, config: ExtensionConfig): void {
  const hosts = manifest.host_permissions ?? [];
  if (config.mode === 'store') {
    if (manifest.key !== undefined) {
      throw new ManifestError('a store build carries no development key');
    }
    if (hosts.includes('<all_urls>') || hosts.some((host) => host.startsWith('*://'))) {
      throw new ManifestError('a store build asks for no host beyond the built-ins and the API');
    }
  }
  if (config.mode === 'e2e' && !hosts.includes('<all_urls>')) {
    throw new ManifestError('an e2e build needs <all_urls>: its prompts cannot be clicked');
  }
  if (!sameMembers(manifest.optional_host_permissions ?? [], OPTIONAL_HOST_PERMISSIONS)) {
    throw new ManifestError('optional_host_permissions must be https://*/* and http://*/*');
  }
}

/** What a built manifest holds exactly: its one content script, permissions and policy. */
function checkBuilt(manifest: GeneratedManifest, config: ExtensionConfig): void {
  // The bootstrap is the only script declared for pages; anything else (a WXT content script
  // entrypoint, say) would run on every built-in host from install.
  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const onlyBootstrap = scripts.every((script: unknown) => {
    const js = (script as { readonly js?: unknown }).js;
    return Array.isArray(js) && js.length === 1 && js[0] === BOOTSTRAP_FILE;
  });
  if (scripts.length !== 1 || !onlyBootstrap) {
    throw new ManifestError(`the manifest's one content script is ${BOOTSTRAP_FILE}`);
  }
  if (!sameMembers(manifest.permissions ?? [], PERMISSIONS)) {
    throw new ManifestError(`permissions must be exactly ${PERMISSIONS.join(', ')}`);
  }
  const csp = manifest.content_security_policy as
    { readonly extension_pages?: unknown; readonly sandbox?: unknown } | undefined;
  if (csp?.extension_pages !== extensionPagesCsp(config) || csp.sandbox !== SANDBOX_CSP) {
    throw new ManifestError('the content security policy is not the declared one');
  }
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));
}
