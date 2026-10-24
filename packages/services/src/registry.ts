/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isBlockedHost } from '@mt/core';

import { coversHost, isBareDomain, isoDay } from './sdk';
import type { ServiceDefinition } from './sdk';
import { appleTv } from './services/apple_tv/definition';
import { netflix } from './services/netflix/definition';

/**
 * A site the extension knows from its first release: its permanent id, its
 * hosts — every one of them is in the first manifest's `host_permissions`, since adding a
 * host later disables the extension until the person accepts it — and the module that
 * reads it, or `null` where the generic readers do.
 */
export interface BuiltInSite {
  readonly id: string;
  readonly name: string;
  readonly hosts: readonly string[];
  readonly module: ServiceDefinition | null;
}

export type BuildMode = 'development' | 'store';

/** A store build refuses a module whose verification is older than this. */
const VERIFICATION_MAX_AGE_DAYS = 90;

/** The registry's data does not hold, or a build was asked for with a value it cannot use. */
export class RegistryError extends Error {
  override readonly name = 'RegistryError';
}

const ID = /^[a-z][a-z0-9_]{1,30}$/;

/** Validates the registry and freezes it; throws `RegistryError` naming the site at fault. */
export function defineSites(sites: readonly BuiltInSite[]): readonly BuiltInSite[] {
  const seen: { readonly id: string; readonly host: string }[] = [];
  const ids = new Set<string>();
  for (const site of sites) {
    if (!ID.test(site.id)) throw new RegistryError(`site ${site.id}: the id is not a module id`);
    if (ids.has(site.id)) throw new RegistryError(`site ${site.id}: the id is listed twice`);
    ids.add(site.id);
    if (site.name.trim() === '') throw new RegistryError(`site ${site.id}: the name is empty`);
    if (site.hosts.length === 0) throw new RegistryError(`site ${site.id}: no hosts`);
    for (const host of site.hosts) {
      if (!isBareDomain(host)) {
        throw new RegistryError(`site ${site.id}: ${host} is not a bare domain`);
      }
      if (isBlockedHost(host)) throw new RegistryError(`site ${site.id}: ${host} is blocked`);
      const overlap = seen.find(
        (other) => coversHost(other.host, host) || coversHost(host, other.host),
      );
      if (overlap !== undefined) {
        throw new RegistryError(
          `site ${site.id}: ${host} overlaps ${overlap.host} of ${overlap.id}`,
        );
      }
      seen.push({ id: site.id, host });
    }
    const module = site.module;
    if (module !== null) {
      if (module.id !== site.id) {
        throw new RegistryError(`site ${site.id}: its module is ${module.id}`);
      }
      const own = [...site.hosts].sort().join(' ');
      if ([...module.hosts].sort().join(' ') !== own) {
        throw new RegistryError(`site ${site.id}: its module reads other hosts`);
      }
    }
  }
  return Object.freeze(
    sites.map((site) => Object.freeze({ ...site, hosts: Object.freeze([...site.hosts]) })),
  );
}

/**
 * The built-in sites — the single edit point: the manifest's host permissions and content
 * script matches are generated from it.
 */
export const BUILT_IN_SITES: readonly BuiltInSite[] = defineSites([
  { id: 'netflix', name: 'Netflix', hosts: ['netflix.com'], module: netflix },
  // Apple TV+ until October 2025; the id stays `apple_tv` whatever the next name is.
  { id: 'apple_tv', name: 'Apple TV', hosts: ['tv.apple.com'], module: appleTv },
  // primevideo.com serves every region, the US included; amazon.* is not listed.
  { id: 'prime_video', name: 'Prime Video', hosts: ['primevideo.com'], module: null },
  { id: 'disney_plus', name: 'Disney+', hosts: ['disneyplus.com'], module: null },
  // Max from 2023 to July 2025; max.com now only redirects here.
  { id: 'hbo_max', name: 'HBO Max', hosts: ['hbomax.com'], module: null },
  { id: 'crunchyroll', name: 'Crunchyroll', hosts: ['crunchyroll.com'], module: null },
  { id: 'paramount_plus', name: 'Paramount+', hosts: ['paramountplus.com'], module: null },
]);

const ALL_HOSTS: readonly string[] = Object.freeze(BUILT_IN_SITES.flatMap((site) => site.hosts));

const MAX_HOSTNAME = 253;
const HOSTNAME_LABEL = /^[a-z0-9-]{1,63}$/;

/** `URL.hostname`'s form: lower-case ASCII labels, no port, no trailing dot, nothing else. */
function isCanonicalHostname(hostname: unknown): hostname is string {
  if (typeof hostname !== 'string' || hostname.length === 0 || hostname.length > MAX_HOSTNAME) {
    return false;
  }
  return hostname
    .split('.')
    .every((label) => HOSTNAME_LABEL.test(label) && !label.startsWith('-') && !label.endsWith('-'));
}

/**
 * The built-in site a page's hostname belongs to: the host itself or a true subdomain of
 * one of its hosts. It takes `URL.hostname` as the URL parser gives it; anything else —
 * a URL, a port, a trailing dot, upper case, a Unicode name — answers `null`.
 */
export function siteForHost(hostname: string): BuiltInSite | null {
  if (!isCanonicalHostname(hostname)) return null;
  return (
    BUILT_IN_SITES.find((site) => site.hosts.some((host) => coversHost(host, hostname))) ?? null
  );
}

/** Every built-in site's hosts, in registry order (the manifest's host permissions). */
export function allBuiltInHosts(): readonly string[] {
  return ALL_HOSTS;
}

function dayOf(today: string): number {
  const day = isoDay(today);
  if (day === null) throw new RegistryError(`today must be a calendar date, YYYY-MM-DD`);
  return day;
}

function verifiedWithin(module: ServiceDefinition, today: number): boolean {
  if (module.verified === null) return false;
  const on = isoDay(module.verified.on);
  if (on === null) return false;
  const age = today - on;
  return age >= 0 && age <= VERIFICATION_MAX_AGE_DAYS;
}

/**
 * The modules a build ships: every one in development; in a store build, only those
 * verified within the last 90 UTC calendar days, today included and a date after today
 * excluded, so a silently broken module never reaches the store.
 */
export function selectForBuild(
  modules: readonly ServiceDefinition[],
  mode: BuildMode,
  today: string,
): readonly ServiceDefinition[] {
  const day = dayOf(today);
  // Widened on purpose: the mode can come from a build variable no type checked.
  const asked: string = mode;
  if (asked === 'development') return [...modules];
  if (asked === 'store') return modules.filter((module) => verifiedWithin(module, day));
  throw new RegistryError(`unknown build mode ${asked}`);
}

/** The built-in modules a build of `mode` ships on `today` (`YYYY-MM-DD`, UTC). */
export function modulesForBuild(mode: BuildMode, today: string): readonly ServiceDefinition[] {
  const attached = BUILT_IN_SITES.flatMap((site) => (site.module === null ? [] : [site.module]));
  return selectForBuild(attached, mode, today);
}
