/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The person's preferences in `chrome.storage.local` (core's `Settings`), key `settings`,
// versioned. Version 2 added a counting threshold, `countAt`; version 3 drops it again, since
// when a viewing counts is the account's line, read with the connection. The version is recorded
// as WXT's storage helper recorded it, which kept it until the worker's size budget needed its
// 3 KB back: `settings$` holds `{ v }`, and a value without one is version 1. Reads are total:
// whatever is stored — another version's shape, a damaged value — comes back as a valid
// `SettingsValue`, a field that cannot be read taking its default. Reads and writes are
// serialised after the migration, so two patches never read the same value and lose one another.

import { DEFAULT_SETTINGS, isHistoryDays } from '@mt/core';
import type { Settings, SettingsValue } from '@mt/core';
import { browser } from 'wxt/browser';
import type { Browser } from 'wxt/browser';

import { isRecord } from '../values';
import { Serial } from './serial';

const KEY = 'settings';
/** Where the version is recorded: the key WXT's storage helper used (`<key>$`). */
const VERSION_KEY = 'settings$';
const SETTINGS_VERSION = 3;
const MAX_HOSTS = 500;
const MAX_SERVICES = 32;
const SERVICE_ID = /^[a-z][a-z0-9_]{1,30}$/u;
const HOST_LABEL = /^[a-z0-9-]{1,63}$/u;

/** A hostname as `URL.hostname` writes one (lower case ASCII, no port, no trailing dot), or `null`. */
export function canonicalHost(x: unknown): string | null {
  if (typeof x !== 'string' || x.length === 0 || x.length > 253) return null;
  const host = x.trim().toLowerCase().replace(/\.$/u, '');
  const labels = host.split('.');
  if (labels.length < 2) return host === 'localhost' ? host : null;
  return labels.every((l) => HOST_LABEL.test(l) && !l.startsWith('-') && !l.endsWith('-'))
    ? host
    : null;
}

function list(x: unknown, max: number, read: (item: unknown) => string | null): readonly string[] {
  if (!Array.isArray(x)) return [];
  const out = new Set<string>();
  for (const item of (x as unknown[]).slice(0, max)) {
    const value = read(item);
    if (value !== null) out.add(value);
  }
  return [...out].sort();
}

/** Any stored value as a valid `SettingsValue`. */
function readSettings(raw: unknown): SettingsValue {
  const r = isRecord(raw) ? raw : {};
  const pausedUntil = r.pausedUntil;
  return {
    pausedUntil:
      typeof pausedUntil === 'number' && Number.isFinite(pausedUntil) ? pausedUntil : null,
    trackIncognito: r.trackIncognito === true,
    disabledServices: list(r.disabledServices, MAX_SERVICES, (s) =>
      typeof s === 'string' && SERVICE_ID.test(s) ? s : null,
    ),
    excludedHosts: list(r.excludedHosts, MAX_HOSTS, canonicalHost),
    allowedHosts: list(r.allowedHosts, MAX_HOSTS, canonicalHost),
    allSites: r.allSites === true,
    diagnostics: r.diagnostics === true,
    historyDays: isHistoryDays(r.historyDays) ? r.historyDays : DEFAULT_SETTINGS.historyDays,
  };
}

/**
 * Versions 1 and 2 → 3: whatever counting threshold the value holds is discarded, since the
 * account's finish line decides now. Total: a damaged value migrates to one that reads as the
 * defaults, never a throw.
 */
function toVersion3(old: unknown): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...(isRecord(old) ? old : {}) };
  delete rest.countAt;
  return rest;
}

/**
 * Closes `chrome.storage.local` to content scripts, which it is open to by default. The
 * extension's own never read it, and a page whose renderer was taken over could otherwise read
 * which sites the person tracks, or rewrite the settings and the account's rule. Run at every
 * worker start; a Chrome that cannot restrict the area keeps its default.
 */
export async function closeToContentScripts(
  area: Pick<Browser.storage.StorageArea, 'setAccessLevel'> = browser.storage.local,
): Promise<void> {
  try {
    await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // A Chrome that refuses it: the area stays as open as it always was.
  }
}

type Area = Pick<Browser.storage.StorageArea, 'get' | 'set'>;

export class ChromeSettings implements Settings {
  readonly #area: Area;
  readonly #serial: Serial;

  constructor(area: Area = browser.storage.local) {
    this.#area = area;
    // Once per instance, before any read or write; a failed migration leaves the value to the
    // total read.
    this.#serial = new Serial(this.#migrate().catch(() => undefined));
  }

  get(): Promise<SettingsValue> {
    return this.#serial.run(() => this.#read());
  }

  patch(p: Partial<SettingsValue>): Promise<void> {
    return this.#serial.run(async () => {
      await this.#write(readSettings({ ...(await this.#read()), ...p }));
    });
  }

  /** Back to a fresh install's settings (*Clear all local data*). */
  reset(): Promise<void> {
    return this.#serial.run(() => this.#write(DEFAULT_SETTINGS));
  }

  /** A stored value of an older version becomes this one's; an absent one waits for a write. */
  async #migrate(): Promise<void> {
    const stored = await this.#area.get([KEY, VERSION_KEY]);
    const value: unknown = stored[KEY];
    const meta = stored[VERSION_KEY];
    const version = isRecord(meta) && typeof meta.v === 'number' ? meta.v : 1;
    if (value == null || version >= SETTINGS_VERSION) return;
    await this.#area.set({
      [KEY]: toVersion3(value),
      [VERSION_KEY]: { ...(isRecord(meta) ? meta : {}), v: SETTINGS_VERSION },
    });
  }

  async #read(): Promise<SettingsValue> {
    return readSettings((await this.#area.get(KEY))[KEY]);
  }

  #write(value: SettingsValue): Promise<void> {
    return this.#area.set({ [KEY]: value, [VERSION_KEY]: { v: SETTINGS_VERSION } });
  }
}
