/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Snapshot } from './snapshot';

/**
 * What the sanitiser removes, by kind, in the order a capture lists them: query
 * values, entries named for an account or a profile, e-mail addresses, tokens, links with a query
 * and strings too long to read through.
 */
export const REMOVED_KINDS = [
  'query_values',
  'named_entries',
  'emails',
  'tokens',
  'links_with_query',
  'overlong',
] as const;

export type RemovedKind = (typeof REMOVED_KINDS)[number];

/** How many of each kind one capture removed. */
export type Removed = Readonly<Record<RemovedKind, number>>;

/**
 * A captured page sample, safe to attach to a public issue: what a module would read, without
 * anything that looks like the person, and how much of each kind was removed. Pure and total over
 * any snapshot.
 *
 * - **A string that looks personal is dropped** wherever it is — a selector value, the JSON-LD,
 *   the Media Session, Open Graph, the page state: an e-mail address, a JWT, a MediaTracker
 *   token (`mts_…`, `mt_rt_…`), a URL with a query, and any string too long to read through
 *   (over 2,000 characters). The document title and the URL's hash, which must stay strings,
 *   become empty instead — the hash also when it names the person as a key below would
 *   (`#access_token=…`, `#/account/…`), counted as a named entry.
 * - **A key that names the person is dropped with its value**, at any depth of the page state
 *   and the JSON-LD, the page state's own top-level entry names included: any key
 *   containing `profile`, `account`, `email`, `user`, `token` or `session`, in any case
 *   (`profileName`, `userId`, `sessionToken`), and any key that looks personal itself.
 * - **The URL's query values become `"<redacted>"`**, their names kept (a module's fixture
 *   needs to know the parameter was there).
 * - **A segment of the URL's path that looks personal becomes `"<redacted>"`**, as it
 *   reads or percent-decoded, the rest of the path kept for the module's routes; a path too
 *   long to read through becomes `"/<redacted>"`.
 * - An e-mail address is one in any script (RFC 6531): `josé@example.com` is one.
 *
 * Each removal counts once, by the kind that removed it: a string by the first of overlong, an
 * e-mail address, a token, a link with a query that it is; a key by being named for the person.
 * The walk is bounded (depth 64): anything deeper is dropped, never followed or counted.
 */
export function sanitizeCapture(s: Snapshot): { snapshot: Snapshot; removed: Removed } {
  const removed: Record<RemovedKind, number> = {
    query_values: 0,
    named_entries: 0,
    emails: 0,
    tokens: 0,
    links_with_query: 0,
    overlong: 0,
  };
  /** Whether `value` is the person's (or too long to tell), counted by its kind when it is. */
  const personal = (value: string): boolean => {
    const kind = personalKind(value);
    if (kind !== null) removed[kind] += 1;
    return kind !== null;
  };
  /** Whether `key` names the person, counted when it does. */
  const named = (key: string): boolean => {
    const is = PERSONAL_KEY.test(key) || personalKind(key) !== null;
    if (is) removed.named_entries += 1;
    return is;
  };
  const json = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return personal(value) ? DROP : value;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'object' || depth >= MAX_DEPTH) return DROP;
    if (Array.isArray(value)) {
      return (value as readonly unknown[])
        .map((item) => json(item, depth + 1))
        .filter((item) => item !== DROP);
    }
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      if (named(key)) continue;
      const clean = json(member, depth + 1);
      if (clean !== DROP) out[key] = clean;
    }
    return out;
  };
  /**
   * The URL's path with every segment that looks personal — read as it is or percent-decoded —
   * replaced by `"<redacted>"`, the others kept, so a module's routes still read it. A path too
   * long to read through is `"/<redacted>"`; anything not a string, `""`.
   */
  const path = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    if (value.length > MAX_STRING) {
      removed.overlong += 1;
      return `/${REDACTED}`;
    }
    return value
      .split('/')
      .map((segment) => {
        const kind = personalKind(segment) ?? personalKind(decoded(segment));
        if (kind === null) return segment;
        removed[kind] += 1;
        return REDACTED;
      })
      .join('/');
  };

  const selectors: Record<string, readonly string[]> = {};
  for (const [name, values] of Object.entries(s.selectors)) {
    selectors[name] = values.filter((value) => !personal(value));
  }
  const openGraph: Record<string, string> = {};
  for (const [name, value] of Object.entries(s.openGraph)) {
    if (!personal(value)) openGraph[name] = value;
  }
  const query: Record<string, string> = {};
  for (const name of Object.keys(s.url.query)) {
    query[name] = REDACTED;
    removed.query_values += 1;
  }
  const pageState: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(s.pageState)) {
    // A module names its entries, and whoever reads the sample reads the names; the person's
    // are dropped all the same, as they are at every depth below.
    if (named(name)) continue;
    const clean = json(value, 0);
    if (clean !== DROP) pageState[name] = clean;
  }
  const session = s.mediaSession;
  const kept = (value: string | undefined): value is string =>
    value !== undefined && !personal(value);
  const snapshot: Snapshot = {
    url: {
      hostname: s.url.hostname,
      pathname: path(s.url.pathname),
      query,
      // A fragment can carry what a sign-in handed the page (`#access_token=…`): one that names
      // the person as a key would goes too.
      hash: personal(s.url.hash) || named(s.url.hash) ? '' : s.url.hash,
    },
    lang: s.lang,
    documentTitle: personal(s.documentTitle) ? '' : s.documentTitle,
    selectors,
    jsonLd: s.jsonLd.map((item) => json(item, 0)).filter((item) => item !== DROP),
    mediaSession:
      session === null
        ? null
        : {
            ...(kept(session.title) ? { title: session.title } : {}),
            ...(kept(session.artist) ? { artist: session.artist } : {}),
            ...(kept(session.album) ? { album: session.album } : {}),
          },
    openGraph,
    pageState,
    signals: { endOfContent: s.signals.endOfContent, adPlaying: s.signals.adPlaying },
  };
  return { snapshot, removed };
}

/** `sanitizeCapture`'s sample alone. */
export const sanitizeSnapshot = (s: Snapshot): Snapshot => sanitizeCapture(s).snapshot;

const REDACTED = '<redacted>';
const MAX_DEPTH = 64;
/** A string longer than this is dropped rather than searched. */
const MAX_STRING = 2000;

/** Marks a value the walk drops. */
const DROP: unique symbol = Symbol('drop');

// Every test below is linear in the string, which is capped at MAX_STRING first: each scans
// forward once (`indexOf`, a split on a single character class) and never re-reads a suffix.
const PERSONAL_KEY = /profile|account|email|user|token|session/iu;
/** A local-part character, in any script (RFC 6531: `josé@…` is an address). */
const EMAIL_LOCAL_CHAR = /^[\p{L}\p{N}\p{M}._%+-]$/u;
/**
 * A domain after an `@`, read from `lastIndex`, in any script (an IDN, `例子.广告`): labels of a
 * class without `.`, so linear.
 */
const EMAIL_DOMAIN = /[\p{L}\p{N}\p{M}-]+(?:\.[\p{L}\p{N}\p{M}-]+)+/uy;
const NOT_JWT_CHAR = /[^A-Za-z0-9_.-]+/u;
const WHITESPACE = /\s+/u;

/** The character (a whole code point) that ends just before `index`. */
function charBefore(value: string, index: number): string {
  const unit = value.charCodeAt(index - 1);
  const pair = unit >= 0xdc00 && unit <= 0xdfff && index >= 2;
  return value.slice(pair ? index - 2 : index - 1, index);
}

/** An `@` with a local-part character before it and a dotted domain after it. */
function hasEmail(value: string): boolean {
  for (let at = value.indexOf('@'); at > 0; at = value.indexOf('@', at + 1)) {
    if (!EMAIL_LOCAL_CHAR.test(charBefore(value, at))) continue;
    EMAIL_DOMAIN.lastIndex = at + 1;
    if (EMAIL_DOMAIN.test(value)) return true;
  }
  return false;
}

/** Three dot-separated base64url segments, the first a JSON header (`eyJ…`). */
function hasJwt(value: string): boolean {
  for (const run of value.split(NOT_JWT_CHAR)) {
    const start = run.indexOf('eyJ');
    if (start < 0) continue;
    const [header = '', payload = '', ...rest] = run.slice(start).split('.');
    if (header.length > 3 && payload.length > 0 && rest.length > 0) return true;
  }
  return false;
}

/** A URL (`scheme://…`) with a `?` before any `#`. */
function hasUrlWithQuery(value: string): boolean {
  for (const segment of value.split(WHITESPACE)) {
    const scheme = segment.indexOf('://');
    if (scheme <= 0) continue;
    const rest = segment.slice(scheme + 3);
    const query = rest.indexOf('?');
    const hash = rest.indexOf('#');
    if (query >= 0 && (hash < 0 || query < hash)) return true;
  }
  return false;
}

/** Why a string may be the person's — or is too long to tell — or `null` when it is not. */
function personalKind(value: string): RemovedKind | null {
  if (value.length > MAX_STRING) return 'overlong';
  if (hasEmail(value)) return 'emails';
  if (hasJwt(value) || value.includes('mts_') || value.includes('mt_rt_')) return 'tokens';
  return hasUrlWithQuery(value) ? 'links_with_query' : null;
}

/** A percent-decoded path segment, or the segment as it is when it does not decode. */
function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
