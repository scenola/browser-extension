/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The local diagnostics log: off by default; when on, an IndexedDB ring buffer of at most 500
// entries kept 7 days (core's `Diagnostics` decides the retention). An entry is an event name
// and a few short values — ids and codes, never a title, a URL, page text, a credential or a
// token — and every value passes one scrubber on the way in anyway, so a careless caller cannot
// write a secret. Nothing here leaves the browser unless the person attaches an export to a
// report.

import { DIAGNOSTICS_MAX_ENTRIES } from '@mt/core';
import type { Clock, Diagnostics, EpochMs } from '@mt/core';

import type { DiagnosticsDetail, DiagnosticsEntry, MtDatabase } from './idb';

const MAX_EVENT = 64;
const MAX_VALUE = 200;
const MAX_DETAIL_KEYS = 16;
const EVENT = /^[a-z][a-z0-9_.:-]*$/u;
const DETAIL_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/u;

// Each pattern is linear — one character class per quantifier — and runs on a capped input. None
// is anchored to a word boundary: a token glued to the word before it is still a token.
/** Scenola's credentials and refresh-style tokens (`mts_ext_…`, `mts_pat_…`, `mt_rt_…`). */
const MT_TOKEN = /(?:mts|mt_rt)_[A-Za-z0-9_]+/gu;
/** An `Authorization` value: the scheme kept, the credential dropped. */
const AUTH_HEADER = /(DPoP|Bearer)\s+[^\s,;]+/giu;
/** A JWT (a DPoP proof): three base64url segments, the first a JSON header (`eyJ`). */
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/gu;

/**
 * One string as a diagnostics value: capped, and with every credential-shaped run removed.
 *
 * @public
 */
export function scrubText(value: string): string {
  return value
    .slice(0, MAX_VALUE)
    .replace(JWT, '<jwt>')
    .replace(AUTH_HEADER, '$1 <redacted>')
    .replace(MT_TOKEN, '<token>');
}

function scrubDetail(detail: Readonly<Record<string, unknown>>): DiagnosticsDetail {
  const out: Record<string, string | number | boolean | null> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(detail)) {
    if (kept >= MAX_DETAIL_KEYS) break;
    if (!DETAIL_KEY.test(key)) continue;
    if (typeof value === 'string') out[key] = scrubText(value);
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === 'boolean' || value === null) out[key] = value;
    else continue;
    kept += 1;
  }
  return out;
}

/** What the extension writes to the log, and what the settings page reads from it. */
export interface DiagnosticsLog extends Diagnostics {
  /** Records one event, if diagnostics are on. Never rejects: a log that fails costs nothing. */
  log(event: string, detail?: Readonly<Record<string, unknown>>): Promise<void>;
  /** Every entry, oldest first. */
  list(): Promise<readonly DiagnosticsEntry[]>;
  clear(): Promise<void>;
}

export class IdbDiagnostics implements DiagnosticsLog {
  readonly #db: () => Promise<MtDatabase>;
  readonly #clock: Clock;
  readonly #enabled: () => Promise<boolean>;

  constructor(db: () => Promise<MtDatabase>, clock: Clock, enabled: () => Promise<boolean>) {
    this.#db = db;
    this.#clock = clock;
    this.#enabled = enabled;
  }

  async log(event: string, detail: Readonly<Record<string, unknown>> = {}): Promise<void> {
    try {
      if (!(await this.#enabled())) return;
      const name = event.slice(0, MAX_EVENT);
      if (!EVENT.test(name)) return;
      const entry: DiagnosticsEntry = {
        at: this.#clock.now(),
        event: name,
        detail: scrubDetail(detail),
      };
      const tx = (await this.#db()).transaction('diagnostics', 'readwrite');
      await tx.store.add(entry);
      // The ring: past the cap, the oldest go (auto-increment keys run in insertion order).
      let excess = (await tx.store.count()) - DIAGNOSTICS_MAX_ENTRIES;
      for (let cursor = await tx.store.openCursor(); cursor !== null && excess > 0; excess -= 1) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      await tx.done;
    } catch {
      // Diagnostics never break what they observe.
    }
  }

  /** Removes entries from before `before`, then all but the newest `keep`. */
  async prune(before: EpochMs, keep: number): Promise<void> {
    const tx = (await this.#db()).transaction('diagnostics', 'readwrite');
    const old = await tx.store.index('at').getAllKeys(IDBKeyRange.upperBound(before, true));
    for (const key of old) await tx.store.delete(key);
    let excess = (await tx.store.count()) - Math.max(keep, 0);
    for (let cursor = await tx.store.openCursor(); cursor !== null && excess > 0; excess -= 1) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  async list(): Promise<readonly DiagnosticsEntry[]> {
    return (await this.#db()).getAll('diagnostics');
  }

  async clear(): Promise<void> {
    await (await this.#db()).clear('diagnostics');
  }
}
