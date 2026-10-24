/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Whether a site is tracked, and as which built-in service: the one decision the content
// messages, the bootstrap into open tabs and the popup's site line all ask.

import { isBlockedHost } from '@mt/core';
import type { SettingsValue } from '@mt/core';

import type { ActiveSite } from '../messaging/protocol';
import { canonicalHost } from '../platform/settings';
import { originPattern } from '../platform/site-permissions';
import { coversHost, siteForHostname } from '../sites';
import type { SiteData } from '../sites';

const MAX_URL_LENGTH = 8192;

type Refusal = 'blocked' | 'excluded' | 'not_allowed' | 'disabled';

export type Decision =
  | { readonly kind: 'tracked'; readonly site: SiteData | null }
  | { readonly kind: 'refused'; readonly reason: Refusal };

/**
 * Whether a host is tracked, and as which built-in site: the block list first, then the person's
 * exclusions, then a built-in (unless turned off), then the sites they allowed.
 */
export function decide(hostname: string, settings: SettingsValue): Decision {
  if (isBlockedHost(hostname)) return { kind: 'refused', reason: 'blocked' };
  if (settings.excludedHosts.some((host) => coversHost(host, hostname))) {
    return { kind: 'refused', reason: 'excluded' };
  }
  const site = siteForHostname(hostname);
  if (site !== null) {
    return settings.disabledServices.includes(site.id)
      ? { kind: 'refused', reason: 'disabled' }
      : { kind: 'tracked', site };
  }
  if (settings.allowedHosts.some((host) => coversHost(host, hostname)) || settings.allSites) {
    return { kind: 'tracked', site: null };
  }
  return { kind: 'refused', reason: 'not_allowed' };
}

/** How the popup states a decision: what *Track this site* can and cannot change. */
export function trackingOf(decision: Decision): ActiveSite['tracking'] {
  if (decision.kind === 'tracked') return 'tracked';
  switch (decision.reason) {
    case 'blocked':
      return 'blocked';
    case 'disabled':
      return 'turned_off';
    // Tracking an excluded site removes the exclusion (`ui/track-site`).
    case 'excluded':
    case 'not_allowed':
      return 'trackable';
  }
}

/**
 * The site of a tab, from its address. A trackable site carries the pattern *Track this site*
 * asks for; one no pattern can name is no site the popup can speak of.
 */
export function siteOf(url: URL, settings: SettingsValue): ActiveSite | null {
  const tracking = trackingOf(decide(url.hostname, settings));
  const pattern = tracking === 'trackable' ? originPattern(url.origin) : null;
  if (tracking === 'trackable' && pattern === null) return null;
  const name = siteForHostname(url.hostname)?.name ?? url.hostname;
  return { origin: url.origin, name, tracking, pattern };
}

/** An `http(s)` URL with a canonical host, bounded; `null` for anything else. */
export function httpUrl(raw: string | undefined): URL | null {
  if (raw === undefined || raw.length > MAX_URL_LENGTH) return null;
  if (!raw.startsWith('https://') && !raw.startsWith('http://')) return null;
  try {
    const url = new URL(raw);
    return canonicalHost(url.hostname) === url.hostname ? url : null;
  } catch {
    return null;
  }
}
