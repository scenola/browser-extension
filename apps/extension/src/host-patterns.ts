/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// How a bare domain becomes match patterns — the one spelling, shared by the manifest (built-in
// hosts at install) and the run-time registration of the bootstrap.

/** A site's domain and every subdomain of it, over `https:`: what a built-in host grants. */
export function domainPatterns(domain: string): readonly string[] {
  return [`https://*.${domain}/*`, `https://${domain}/*`];
}

/** Every site, over both schemes: what the all-sites switch asks for. */
export const ALL_SITES_PATTERNS: readonly string[] = Object.freeze(['https://*/*', 'http://*/*']);
