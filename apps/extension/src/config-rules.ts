/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The build's configuration: what `MT_API_BASE_URL`, `MT_WEB_APP_BASE_URL`, `MT_AUTH_STRATEGIES`
// and the build mode may be, decided once. `wxt.config.ts` runs this at build time and refuses to
// build on a `ConfigError`; the bundle then carries the resolved values only (config.ts), never
// the environment it was built in.

import { dpopHtu } from '@mt/api';

const BUILD_MODES = ['development', 'store', 'e2e'] as const;
export type BuildMode = (typeof BUILD_MODES)[number];

const AUTH_STRATEGY_IDS = ['pkce_dpop', 'personal_token', 'test'] as const;
export type AuthStrategyId = (typeof AUTH_STRATEGY_IDS)[number];

export interface ExtensionConfig {
  readonly mode: BuildMode;
  /** The public API origin, canonical (`https://api.example.com`, no trailing slash). */
  readonly apiBaseUrl: string;
  /** The web app's origin, canonical. */
  readonly webAppBaseUrl: string;
  readonly authStrategies: readonly AuthStrategyId[];
  /** Where `TestAuth` approves (e2e builds with the `test` strategy); `null` otherwise. */
  readonly testApproveUrl: string | null;
}

/** The committed values: local development only. */
const DEVELOPMENT_DEFAULTS = {
  MT_API_BASE_URL: 'http://localhost:8000',
  MT_WEB_APP_BASE_URL: 'http://localhost:3000',
  MT_AUTH_STRATEGIES: 'pkce_dpop',
} as const;

/** A configuration this build refuses; the message says which variable and why. */
class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** A path the API's proofs name, to check that the configured base survives `dpopHtu`. */
const PROBE_PATH = '/v1/integrations/plays';

/**
 * Names that never reach a public server: `localhost` and the special-use and private-use
 * top-level names (RFC 6761, RFC 6762's `.local`, `home.arpa`, ICANN's `.internal`, RFC 7686's
 * `.onion`, RFC 9476's `.alt`), and the ones private networks use that ICANN will not delegate
 * (`.lan`, `.home`, `.corp`, `.localdomain`).
 */
const NON_PUBLIC_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'home.arpa',
  'test',
  'invalid',
  'example',
  'onion',
  'alt',
  'lan',
  'home',
  'corp',
  'localdomain',
] as const;

/** A dotted IPv4 address, as `URL` writes every IPv4 host (`127.1` included). */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The configuration of a build in `mode` from its environment. Total over the environment: an
 * unset or empty variable takes the development default, except a store build's two URLs, which
 * it names itself; anything this build cannot use throws `ConfigError`.
 *
 * - The two base URLs are absolute `http(s)` origins — no path, query, fragment, userinfo or
 *   trailing-dot host — whose `htu` (`dpopHtu`) is the origin as configured, so a proof never
 *   names a URL the server does not.
 * - A store build: both URLs `https:` on a public name — not a local or special-use name, and
 *   not an address, private or not, since a store build talks to a named service — and
 *   `MT_AUTH_STRATEGIES` exactly
 *   `pkce_dpop`. The `test` strategy exists in e2e builds only, with `MT_TEST_APPROVE_URL`.
 */
export function resolveConfig(mode: string, env: Env): ExtensionConfig {
  if (!(BUILD_MODES as readonly string[]).includes(mode)) {
    throw new ConfigError(
      `unknown build mode "${mode}": build with --mode development, store or e2e`,
    );
  }
  const buildMode = mode as BuildMode;
  const store = buildMode === 'store';
  const apiBaseUrl = baseUrl('MT_API_BASE_URL', value(env, 'MT_API_BASE_URL', store), store);
  const webAppBaseUrl = baseUrl(
    'MT_WEB_APP_BASE_URL',
    value(env, 'MT_WEB_APP_BASE_URL', store),
    store,
  );
  // The default strategy is the only one a store build may have, so it may take the default.
  const authStrategies = strategies(value(env, 'MT_AUTH_STRATEGIES', false), buildMode);
  const testApproveUrl = authStrategies.includes('test')
    ? approveUrl(nonEmpty(env.MT_TEST_APPROVE_URL))
    : null;
  return Object.freeze({
    mode: buildMode,
    apiBaseUrl,
    webAppBaseUrl,
    authStrategies: Object.freeze([...authStrategies]),
    testApproveUrl,
  });
}

/** The origins `connect-src` must allow: the API's, and in e2e the test approval's. */
export function connectOrigins(config: ExtensionConfig): readonly string[] {
  const origins = [config.apiBaseUrl];
  if (config.testApproveUrl !== null) {
    const approve = new URL(config.testApproveUrl).origin;
    if (!origins.includes(approve)) origins.push(approve);
  }
  return origins;
}

function nonEmpty(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function value(
  env: Env,
  name: keyof typeof DEVELOPMENT_DEFAULTS,
  store: boolean,
): string | undefined {
  return nonEmpty(env[name]) ?? (store ? undefined : DEVELOPMENT_DEFAULTS[name]);
}

function baseUrl(name: string, raw: string | undefined, store: boolean): string {
  const storeRule = `store builds need ${name}: a public https:// origin by name, not localhost or an address`;
  if (raw === undefined) throw new ConfigError(storeRule);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`${name} must be an http:// or https:// URL`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError(`${name} must not carry a user name or password`);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new ConfigError(`${name} must be an origin, with no path, query or fragment`);
  }
  if (raw.includes('?') || raw.includes('#')) {
    throw new ConfigError(`${name} must be an origin, with no path, query or fragment`);
  }
  if (url.hostname.endsWith('.')) {
    throw new ConfigError(`${name} must not end its host with a dot`);
  }
  const origin = `${url.protocol}//${url.host}`;
  const asWritten = raw.replace(/\/+$/u, '');
  if (dpopHtu(`${asWritten}${PROBE_PATH}`) !== `${origin}${PROBE_PATH}`) {
    throw new ConfigError(`${name} must be written as the server names it (${origin})`);
  }
  if (store && (url.protocol !== 'https:' || !isPublicName(url.hostname))) {
    throw new ConfigError(storeRule);
  }
  return origin;
}

/**
 * A host a store build may name: a name of at least two labels outside the local and
 * special-use names. An address is never one — IPv4 or IPv6 (`[…]`), loopback, private, mapped
 * or public — and neither is a single label, which only a local resolver answers.
 */
function isPublicName(hostname: string): boolean {
  if (IPV4.test(hostname) || hostname.startsWith('[')) return false;
  if (!hostname.includes('.')) return false;
  return !NON_PUBLIC_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function strategies(raw: string | undefined, mode: BuildMode): readonly AuthStrategyId[] {
  const storeRule =
    'store builds need MT_AUTH_STRATEGIES=pkce_dpop: personal tokens are for self-builds and the test sign-in for e2e builds';
  if (raw === undefined) throw new ConfigError(storeRule);
  const names = raw.split(',').map((name) => name.trim());
  const out: AuthStrategyId[] = [];
  for (const name of names) {
    if (!(AUTH_STRATEGY_IDS as readonly string[]).includes(name)) {
      throw new ConfigError(
        `MT_AUTH_STRATEGIES lists "${name}": use pkce_dpop, personal_token or test`,
      );
    }
    const id = name as AuthStrategyId;
    if (out.includes(id)) throw new ConfigError(`MT_AUTH_STRATEGIES lists ${id} twice`);
    out.push(id);
  }
  if (mode === 'store' && (out.length !== 1 || out[0] !== 'pkce_dpop')) {
    throw new ConfigError(storeRule);
  }
  if (mode !== 'e2e' && out.includes('test')) {
    throw new ConfigError('MT_AUTH_STRATEGIES: the test sign-in is for e2e builds only');
  }
  return out;
}

function approveUrl(raw: string | undefined): string {
  if (raw === undefined) {
    throw new ConfigError('the test sign-in needs MT_TEST_APPROVE_URL');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('MT_TEST_APPROVE_URL is not a URL');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new ConfigError(
      'MT_TEST_APPROVE_URL must be an http(s) URL without userinfo or fragment',
    );
  }
  return url.href;
}
