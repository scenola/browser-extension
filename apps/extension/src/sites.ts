/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The registry as the worker and the content scripts know it: data, generated at build time
// from `@mt/services` (build/sites-data.ts) and inlined as `__MT_SITES__`. Module code never
// reaches this bundle — no `interpret`, no definition file runs here; only the sandbox page
// bundles the modules themselves. The SDK is imported for its types alone.

import type { CollectSpec } from '@mt/services';

interface PlayerRouteData {
  readonly source: string;
  readonly flags: string;
}

/** What the worker and the collector need of a module that ships in this build. */
interface SiteModuleData {
  readonly version: string;
  readonly verified: { readonly on: string; readonly by: string } | null;
  readonly playerRoutes: readonly PlayerRouteData[];
  readonly collect: CollectSpec;
  /** The zero-argument calls its state paths may make (`ALLOWED_CALL_NAMES`). */
  readonly allowedCalls: readonly string[];
}

export interface SiteData {
  readonly id: string;
  readonly name: string;
  readonly hosts: readonly string[];
  /** `null` where the generic readers read the site: no module, or one this build leaves out. */
  readonly module: SiteModuleData | null;
}

export interface SitesData {
  /** The build the data was generated for (`modulesForBuild`'s mode and day). */
  readonly builtFor: { readonly mode: string; readonly today: string };
  /** The SDK's caps, carried as data so they are spelled once (`@mt/services`). */
  readonly limits: {
    readonly maxRouteInput: number;
    readonly maxSelectorLength: number;
    readonly maxSelectorValues: number;
  };
  readonly sites: readonly SiteData[];
}

declare const __MT_SITES__: SitesData;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}

export const SITES: SitesData = deepFreeze(__MT_SITES__);

/**
 * Each route compiled once. A flag that makes `test` stateful (`g`, `y`) is dropped — the SDK
 * refuses both, so this only guards data from elsewhere — and a source that does not compile
 * matches nothing.
 */
const ROUTES: ReadonlyMap<string, readonly RegExp[]> = new Map(
  SITES.sites.map((site) => [
    site.id,
    (site.module?.playerRoutes ?? []).flatMap((route) => {
      try {
        return [new RegExp(route.source, route.flags.replace(/[gy]/gu, ''))];
      } catch {
        return [];
      }
    }),
  ]),
);

const MAX_HOSTNAME = 253;
const HOSTNAME_LABEL = /^[a-z0-9-]{1,63}$/u;

/** `URL.hostname`'s form: lower-case ASCII labels, no port, no trailing dot. */
function isCanonicalHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > MAX_HOSTNAME) return false;
  return hostname
    .split('.')
    .every((label) => HOSTNAME_LABEL.test(label) && !label.startsWith('-') && !label.endsWith('-'));
}

/** The domain itself or a true subdomain of it — never a host that merely ends in its letters. */
export function coversHost(domain: string, hostname: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** The built-in site a hostname (as `URL.hostname` gives it) belongs to, or `null`. */
export function siteForHostname(hostname: string): SiteData | null {
  if (!isCanonicalHostname(hostname)) return null;
  return (
    SITES.sites.find((site) => site.hosts.some((domain) => coversHost(domain, hostname))) ?? null
  );
}

export function siteById(id: string): SiteData | null {
  return SITES.sites.find((site) => site.id === id) ?? null;
}

/**
 * Whether `pathname` is one of the site's player routes. Never on a site without a module in
 * this build, and never on a pathname over the SDK's cap: routes are reviewed, not proven
 * linear, so their input is bounded instead.
 */
export function isPlayerRoute(site: SiteData, pathname: string): boolean {
  return playerRouteGroups(site, pathname) !== null;
}

/**
 * The capture groups of the first player route that matches `pathname` — index 0 the whole
 * match, a group that took part in no match `null` — or `null` off every route. A state path's
 * `routeGroup` steps name them; they reach the page as plain data.
 */
export function playerRouteGroups(
  site: SiteData,
  pathname: string,
): readonly (string | null)[] | null {
  if (site.module === null || pathname.length > SITES.limits.maxRouteInput) return null;
  for (const route of ROUTES.get(site.id) ?? []) {
    const match = route.exec(pathname);
    if (match !== null) return Array.from(match, (group: string | undefined) => group ?? null);
  }
  return null;
}
