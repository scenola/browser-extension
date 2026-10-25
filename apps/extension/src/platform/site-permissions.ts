/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Which sites beyond the built-ins are tracked (`SitePermissions`): the optional host permissions
// the person granted — from the all-sites switch or *Track this site*, always from a click in a
// page, or from Chrome's own site-access menu — and the bootstrap registered on exactly those,
// minus the block list and the person's exclusions. The granted permissions are the truth;
// `allowedHosts` and `allSites` in the settings mirror them.
//
// It never asks for access: Chrome shows its prompt only from a user gesture, and the worker has
// none. The pages ask, in their click handlers (popup/SiteCard.tsx, sites-switch.tsx), then tell
// the worker; this side reads, gives back and reconciles.

import { BLOCKED_HOST_SUFFIXES, BLOCKED_TLD_FORMS, isBlockedHost } from '@mt/core';
import type { Settings, SettingsValue } from '@mt/core';
import type { Browser } from 'wxt/browser';

import { API_BASE_URL } from '../config';
import { ALL_SITES_PATTERNS, domainPatterns } from '../host-patterns';
import { BOOTSTRAP_FILE } from '../script-files';
import { SITES } from '../sites';
import { canonicalHost } from './settings';

/** The run-time registration of the bootstrap content script. */
const GRANTED_SCRIPT_ID = 'mt-bootstrap-granted';

type Permissions = Pick<typeof Browser.permissions, 'contains' | 'remove' | 'getAll'>;
type Scripting = Pick<
  typeof Browser.scripting,
  | 'getRegisteredContentScripts'
  | 'registerContentScripts'
  | 'updateContentScripts'
  | 'unregisterContentScripts'
>;

export interface SitePermissions {
  /** Gives the access to every site back (the all-sites switch turned off). */
  forgetAllSites(): Promise<void>;
  /** The site's access is granted. */
  has(origin: string): Promise<boolean>;
  /** Access to every site is granted. */
  hasAllSites(): Promise<boolean>;
  /** Gives one site's access back. */
  forget(origin: string): Promise<void>;
  /** Gives every optional access back (*Clear all local data*). */
  forgetAll(): Promise<void>;
  /**
   * Registers the bootstrap on every granted optional origin, minus blocked and excluded hosts,
   * and mirrors the grants into the settings. Re-run at startup, on every permission change and
   * on every change to the exclusions.
   */
  reconcile(): Promise<void>;
}

const MAX_ORIGIN_LENGTH = 300;

/**
 * `https://host` or `http://host[:port]` — an origin as `URL.origin` writes it — as a match
 * pattern. A match pattern names no port (it matches every port of its host), so an origin with
 * one is asked for by its host.
 */
export function originPattern(origin: string): string | null {
  if (origin.length > MAX_ORIGIN_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.origin !== origin) return null;
  const host = canonicalHost(url.hostname);
  if (host === null || host !== url.hostname || isBlockedHost(host)) return null;
  return `${url.protocol}//${host}/*`;
}

/** The host a granted pattern names (`https://*.example.com/*` → `example.com`), if it is one. */
const GRANT = /^(?:https?|\*):\/\/(\*\.)?([^/*]{1,253})\/\*$/u;

function grantedHost(pattern: string): string | null {
  const host = GRANT.exec(pattern)?.[2];
  return host === undefined ? null : canonicalHost(host);
}

const ALL_SITES: ReadonlySet<string> = new Set(['<all_urls>', '*://*/*']);

/** The built-in services' hosts as the manifest grants them: never an optional grant. */
function builtInPatterns(): readonly string[] {
  return SITES.sites.flatMap((site) => site.hosts.flatMap((host) => domainPatterns(host)));
}

function blockedPatterns(): readonly string[] {
  const suffixes = BLOCKED_HOST_SUFFIXES.flatMap((s) => [`*://*.${s}/*`, `*://${s}/*`]);
  // A match pattern's host is ASCII: a Unicode TLD is matched in its punycode form.
  const ascii = BLOCKED_TLD_FORMS.filter((tld) => /^[a-z0-9-]+$/u.test(tld));
  const tlds = ascii.map((tld) => `*://*.${tld}/*`);
  return [...suffixes, ...tlds];
}

function excludedPatterns(settings: SettingsValue): readonly string[] {
  return settings.excludedHosts.flatMap((host) => [`*://${host}/*`, `*://*.${host}/*`]);
}

export class ChromeSitePermissions implements SitePermissions {
  readonly #permissions: Permissions;
  readonly #scripting: Scripting;
  readonly #settings: Settings;
  #running: Promise<void> | null = null;
  #again = false;

  constructor(permissions: Permissions, scripting: Scripting, settings: Settings) {
    this.#permissions = permissions;
    this.#scripting = scripting;
    this.#settings = settings;
  }

  async forgetAllSites(): Promise<void> {
    await this.#permissions.remove({ origins: [...ALL_SITES_PATTERNS] });
  }

  async has(origin: string): Promise<boolean> {
    const pattern = originPattern(origin);
    if (pattern === null) return false;
    return this.#permissions.contains({ origins: [pattern] });
  }

  hasAllSites(): Promise<boolean> {
    return this.#permissions.contains({ origins: [...ALL_SITES_PATTERNS] });
  }

  async forget(origin: string): Promise<void> {
    const pattern = originPattern(origin);
    if (pattern !== null) await this.#permissions.remove({ origins: [pattern] });
  }

  async forgetAll(): Promise<void> {
    const optional = (await this.#optionalGrants()).filter((p) => !ALL_SITES.has(p));
    if (optional.length > 0) await this.#permissions.remove({ origins: optional });
  }

  /** One pass at a time; a call during a pass runs one more after it, with what is granted then. */
  reconcile(): Promise<void> {
    if (this.#running !== null) {
      this.#again = true;
      return this.#running;
    }
    const run = (async () => {
      try {
        for (;;) {
          this.#again = false;
          await this.#reconcile();
          if (!this.#askedAgain()) break;
        }
      } finally {
        this.#running = null;
      }
    })();
    this.#running = run;
    return run;
  }

  /** Whether a call arrived during the pass that just ran (read after an `await`). */
  #askedAgain(): boolean {
    return this.#again;
  }

  /** The granted host permissions that are neither the built-ins' nor the API's. */
  async #optionalGrants(): Promise<readonly string[]> {
    const required = new Set([...builtInPatterns(), `${API_BASE_URL}/*`]);
    return ((await this.#permissions.getAll()).origins ?? []).filter((p) => !required.has(p));
  }

  async #reconcile(): Promise<void> {
    const grants = await this.#optionalGrants();
    const allSites =
      grants.some((p) => ALL_SITES.has(p)) || ALL_SITES_PATTERNS.every((p) => grants.includes(p));
    const hostGrants = grants.filter((p) => {
      if (ALL_SITES.has(p) || ALL_SITES_PATTERNS.includes(p)) return false;
      const host = grantedHost(p);
      return host !== null && !isBlockedHost(host);
    });
    const allowedHosts = [
      ...new Set(hostGrants.map(grantedHost).filter((h): h is string => h !== null)),
    ].sort();

    const settings = await this.#settings.get();
    if (
      settings.allSites !== allSites ||
      settings.allowedHosts.length !== allowedHosts.length ||
      settings.allowedHosts.some((host, i) => host !== allowedHosts[i])
    ) {
      await this.#settings.patch({ allSites, allowedHosts });
    }

    const matches = allSites ? [...ALL_SITES_PATTERNS] : hostGrants;
    const excludeMatches = [
      ...builtInPatterns(),
      ...blockedPatterns(),
      ...excludedPatterns(settings),
    ];
    const registered = await this.#scripting.getRegisteredContentScripts({
      ids: [GRANTED_SCRIPT_ID],
    });
    if (matches.length === 0) {
      if (registered.length > 0) {
        await this.#scripting.unregisterContentScripts({ ids: [GRANTED_SCRIPT_ID] });
      }
      return;
    }
    const script = {
      id: GRANTED_SCRIPT_ID,
      js: [BOOTSTRAP_FILE],
      matches,
      excludeMatches,
      allFrames: true,
      matchOriginAsFallback: true,
      runAt: 'document_start' as const,
      persistAcrossSessions: true,
    };
    if (registered.length > 0) await this.#scripting.updateContentScripts([script]);
    else await this.#scripting.registerContentScripts([script]);
  }
}
