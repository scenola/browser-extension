/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The snapshot of a frame: exactly what the site's module declared, plus the generic readers'
// inputs (JSON-LD, Media Session, Open Graph, the document's title and language), each bounded
// where it is read — by the elements examined, not only by the values kept — and within the
// protocol's limits (messaging/limits.ts), so a snapshot is never refused for what the page
// holds. Total: a page of any shape gives a snapshot, never a throw. Nothing here is logged.
//
// Only what a reader reads is gathered: the Open Graph properties core's readers read
// (`OPEN_GRAPH_PROPERTIES`) and no other tag, and the JSON-LD cut to the fields core's reader
// reads (`cutJsonLd`) — unless the site's module declared the JSON-LD, which it reads itself and
// gets as it was. So no image link, description or page link of a page is held.

import { OPEN_GRAPH_PROPERTIES, cutJsonLd } from '@mt/core';
import type { Snapshot } from '@mt/core';
import type { CollectSpec, SelectorSpec } from '@mt/services';

import { SNAPSHOT_LIMITS as L } from '../messaging/limits';
import { isVisible } from './election';

/** Elements examined per selector, whatever the page holds: the values kept are fewer. */
const MAX_EXAMINED = 50;
/** `<script type="application/ld+json">` and `<meta>` elements examined. */
const MAX_JSON_LD_SCRIPTS = 32;
const MAX_META = 128;
/** Raw text looked at before whitespace is collapsed: more than one value can ever keep. */
const RAW_TEXT_FACTOR = 4;
/** Containers kept in one JSON-LD value, below the protocol's depth (its array is a level). */
const JSON_LD_MAX_DEPTH = L.jsonLdDepth - 2;
/** JSON values kept across all of the page's JSON-LD, below the protocol's node budget. */
const JSON_LD_MAX_NODES = L.jsonNodes - 100;

/** A page string made a value: whitespace collapsed, trimmed, at most `max` characters. */
function clean(raw: string | null | undefined, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .slice(0, max * RAW_TEXT_FACTOR)
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

function queryAll(doc: Document, css: string): NodeListOf<Element> | null {
  try {
    return doc.querySelectorAll(css);
  } catch {
    // A selector this browser does not parse matches nothing.
    return null;
  }
}

/** The values of one declared selector: at most `max` (≤ 5), each at most 300 characters. */
function selectorValues(doc: Document, spec: SelectorSpec): string[] {
  const max = Math.min(spec.max ?? L.selectorValues, L.selectorValues);
  const visibleOnly = spec.visibleOnly !== false;
  const list = queryAll(doc, spec.css);
  const values: string[] = [];
  if (list === null) return values;
  for (let i = 0; i < list.length && i < MAX_EXAMINED && values.length < max; i += 1) {
    const element = list[i];
    if (element === undefined || (visibleOnly && !isVisible(element))) continue;
    const raw = spec.attr === undefined ? element.textContent : element.getAttribute(spec.attr);
    const value = clean(raw, L.selectorValue);
    if (value !== '') values.push(value);
  }
  return values;
}

/** Whether any of the first elements matching `css` is visible (a module's signal). */
export function signalVisible(doc: Document, css: string | undefined): boolean {
  if (css === undefined) return false;
  const list = queryAll(doc, css);
  if (list === null) return false;
  for (let i = 0; i < list.length && i < MAX_EXAMINED; i += 1) {
    const element = list[i];
    if (element !== undefined && isVisible(element)) return true;
  }
  return false;
}

/** Whether `value` holds no container deeper than `maxDepth` (the value itself is depth 1). */
function withinDepth(value: unknown, maxDepth: number): boolean {
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    if (typeof item.value !== 'object' || item.value === null) continue;
    if (item.depth > maxDepth) return false;
    for (const member of Object.values(item.value)) {
      if (typeof member === 'object' && member !== null) {
        stack.push({ value: member, depth: item.depth + 1 });
      }
    }
  }
  return true;
}

/** Thrown inside `JSON.parse`'s reviver once the page's JSON-LD has used up the node budget. */
class TooLarge extends Error {}

/**
 * The page's JSON-LD blocks, parsed: at most 20, from at most 64 KB of script text examined in
 * all (kept or not), a value of more nodes or depth than the protocol carries dropped whole. A
 * number JSON cannot carry (`1e400` parses to `Infinity`) becomes `null`. Malformed blocks are
 * skipped. Each is cut to what core's reader reads, unless `whole`: the site's module declared
 * the JSON-LD.
 */
function jsonLdOf(doc: Document, whole: boolean): unknown[] {
  const scripts = queryAll(doc, 'script[type="application/ld+json"]');
  const blocks: unknown[] = [];
  if (scripts === null) return blocks;
  let examined = 0;
  let nodes = 0;
  for (let i = 0; i < scripts.length && i < MAX_JSON_LD_SCRIPTS; i += 1) {
    if (blocks.length >= L.jsonLdObjects) break;
    const text = scripts[i]?.textContent ?? '';
    if (text.length === 0 || examined + text.length > L.jsonLdChars) continue;
    examined += text.length;
    let used = 0;
    let value: unknown;
    try {
      value = JSON.parse(text, (_key, member: unknown) => {
        used += 1;
        if (nodes + used > JSON_LD_MAX_NODES) throw new TooLarge();
        return typeof member === 'number' && !Number.isFinite(member) ? null : member;
      });
    } catch {
      continue;
    }
    if (!withinDepth(value, JSON_LD_MAX_DEPTH)) continue;
    nodes += used;
    blocks.push(whole ? value : cutJsonLd(value));
  }
  // Written out, a value can outgrow its source (a lone surrogate is escaped): trim to fit.
  while (blocks.length > 0 && JSON.stringify(blocks).length > L.jsonLdChars) blocks.pop();
  return blocks;
}

/** `navigator.mediaSession.metadata`'s title, artist and album, as far as the page set them. */
function mediaSessionOf(): Snapshot['mediaSession'] {
  try {
    const metadata = navigator.mediaSession.metadata;
    if (metadata === null) return null;
    const title = clean(metadata.title, L.mediaSessionField);
    const artist = clean(metadata.artist, L.mediaSessionField);
    const album = clean(metadata.album, L.mediaSessionField);
    return {
      ...(title === '' ? {} : { title }),
      ...(artist === '' ? {} : { artist }),
      ...(album === '' ? {} : { album }),
    };
  } catch {
    return null;
  }
}

/** Every tag of a property the readers read, by `property` or by `name`. */
const OPEN_GRAPH_META = OPEN_GRAPH_PROPERTIES.flatMap((p) => [
  `meta[property="${p}"]`,
  `meta[name="${p}"]`,
]).join(', ');
const READ_PROPERTIES: ReadonlySet<string> = new Set(OPEN_GRAPH_PROPERTIES);

/** The Open Graph tags the readers read: the first value of each property, and no other tag. */
function openGraphOf(doc: Document): Record<string, string> {
  const entries: Record<string, string> = {};
  let count = 0;
  const metas = queryAll(doc, OPEN_GRAPH_META);
  if (metas === null) return entries;
  for (let i = 0; i < metas.length && i < MAX_META && count < L.openGraphEntries; i += 1) {
    const meta = metas[i];
    if (meta === undefined) continue;
    const name = meta.getAttribute('property') ?? meta.getAttribute('name') ?? '';
    if (!READ_PROPERTIES.has(name) || Object.hasOwn(entries, name)) continue;
    const content = clean(meta.getAttribute('content'), L.openGraphValue);
    if (content === '') continue;
    entries[name] = content;
    count += 1;
  }
  return entries;
}

/** The query parameters the module declared, and no other. */
function queryOf(location: Location, names: readonly string[] | undefined): Record<string, string> {
  const query: Record<string, string> = {};
  if (names === undefined || names.length === 0) return query;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search.slice(0, L.pathname));
  } catch {
    return query;
  }
  for (const name of names.slice(0, L.queryParams)) {
    if (name.length > L.queryName) continue;
    const value = params.get(name);
    if (value !== null) query[name] = value.slice(0, L.queryValue);
  }
  return query;
}

function langOf(doc: Document): string | null {
  try {
    const lang = doc.documentElement.lang.trim();
    return lang === '' || lang.length > L.lang ? null : lang;
  } catch {
    return null;
  }
}

/**
 * The snapshot of `doc` for a module's `spec` (`null` on a site without one), with the page
 * state the worker read (`pageState`; the collector itself reads none). The generic readers'
 * inputs are always collected.
 */
export function buildSnapshot(
  doc: Document,
  location: Location,
  spec: CollectSpec | null,
  pageState: Readonly<Record<string, unknown>>,
): Snapshot {
  const selectors: Record<string, string[]> = {};
  const declared = spec?.selectors ?? {};
  for (const name of Object.keys(declared).slice(0, L.selectorNames)) {
    const selector = declared[name];
    if (selector === undefined || name.length > L.selectorName) continue;
    selectors[name] = selectorValues(doc, selector);
  }
  return {
    url: {
      hostname: location.hostname.slice(0, L.hostname),
      pathname: location.pathname.slice(0, L.pathname),
      query: queryOf(location, spec?.queryParams),
      hash: location.hash.slice(0, L.hash),
    },
    lang: langOf(doc),
    documentTitle: clean(doc.title, L.documentTitle),
    selectors,
    jsonLd: jsonLdOf(doc, spec?.jsonLd === true),
    mediaSession: mediaSessionOf(),
    openGraph: openGraphOf(doc),
    pageState,
    signals: {
      endOfContent: signalVisible(doc, spec?.signals?.endOfContent),
      adPlaying: signalVisible(doc, spec?.signals?.adPlaying),
    },
  };
}
