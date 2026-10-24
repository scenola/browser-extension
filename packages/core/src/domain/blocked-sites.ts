/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sites the collector is never injected on, whatever the person allowed.
 * Each entry is a registrable suffix: it matches the host itself and any
 * subdomain of it, never a host that merely ends in the same letters.
 */
export const BLOCKED_HOST_SUFFIXES: readonly string[] = [
  // User-generated video is not a film or an episode, and a play from it is noise.
  'youtube.com',
  'm.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
];

/**
 * Content policy: no support of russian services. It is applied by the host's last
 * label alone, `.ru` and `.рф`, with no list of named sites.
 */
export const BLOCKED_TLDS: readonly string[] = ['ru', 'рф'];

/**
 * The same domains in the form a host can arrive in. Chrome and the URL parser hand
 * over an internationalised domain in punycode, so `.рф` arrives as `.xn--p1ai`. This
 * is the same domain, not another one.
 */
const PUNYCODE: Readonly<Record<string, string>> = { рф: 'xn--p1ai' };

export const BLOCKED_TLD_FORMS: readonly string[] = BLOCKED_TLDS.flatMap((tld) => {
  const ascii = PUNYCODE[tld];
  return ascii === undefined ? [tld] : [tld, ascii];
});

/** Case and a trailing root dot do not change which host this is. */
const canonical = (hostname: string): string => hostname.trim().toLowerCase().replace(/\.$/u, '');

export function isBlockedHost(hostname: string): boolean {
  const host = canonical(hostname);
  if (host === '') return false;
  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (BLOCKED_TLD_FORMS.includes(tld)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}
