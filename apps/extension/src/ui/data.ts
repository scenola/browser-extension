/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the settings and welcome pages read and write through the worker: the settings
// (`ui/settings`, `{}` to read), and the files the person takes away — the export and a captured
// page sample — saved as a download the page builds from the worker's answer.

import type { SettingsValue } from '@mt/core';
import { useEffect, useState } from 'preact/hooks';

import type { SettingsPatch, UiResponse } from '../messaging/protocol';
import { isRecord } from '../values';
import type { UiConnection } from './store';

const isStringList = (x: unknown): x is readonly string[] =>
  Array.isArray(x) && x.every((item) => typeof item === 'string');

/** The worker's settings, when the answer has their shape. */
function readSettings(x: unknown): SettingsValue | null {
  if (!isRecord(x)) return null;
  if (
    typeof x.trackIncognito !== 'boolean' ||
    typeof x.allSites !== 'boolean' ||
    typeof x.diagnostics !== 'boolean' ||
    !isStringList(x.disabledServices) ||
    !isStringList(x.excludedHosts) ||
    !isStringList(x.allowedHosts)
  ) {
    return null;
  }
  return x as unknown as SettingsValue;
}

/**
 * The settings, read again whenever the worker pushes a new state (a pause from the popup, a
 * permission granted in Chrome's own menu), and `patch` to change some.
 */
export function useSettings(ui: UiConnection) {
  const [settings, setSettings] = useState<SettingsValue | null>(null);
  const pushed = ui.state.value;

  useEffect(() => {
    let current = true;
    void ui.send({ type: 'ui/settings', patch: {} }).then((response) => {
      const read = response.ok ? readSettings(response.data) : null;
      if (current && read !== null) setSettings(read);
    });
    return () => {
      current = false;
    };
  }, [pushed, ui]);

  const patch = async (p: SettingsPatch): Promise<UiResponse> => {
    const response = await ui.send({ type: 'ui/settings', patch: p });
    const read = response.ok ? readSettings(response.data) : null;
    if (read !== null) setSettings(read);
    return response;
  };

  return { settings, patch };
}

/**
 * Keys and values an export must never hold: the credential and the key pair, by name, and
 * anything shaped like a Scenola credential. The worker builds the export without them;
 * this is the page's own check before a file leaves the browser.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'accessToken',
  'access_token',
  'keyPair',
  'privateKey',
]);
const SECRET_VALUE = /(?:^|[^A-Za-z0-9_])(?:mts|mt_rt)_[A-Za-z0-9_]{20,}/u;
const MAX_DEPTH = 64;

export function holdsSecret(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (typeof value === 'string') return SECRET_VALUE.test(value.slice(0, 4096));
  if (Array.isArray(value)) return value.some((item) => holdsSecret(item, depth + 1));
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([key, item]) => SECRET_KEYS.has(key) || holdsSecret(item, depth + 1),
    );
  }
  return false;
}

/** Saves `value` as a JSON file the person chooses where to keep. */
export function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Long enough for the download to start reading it.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

/** Today's local date as `YYYY-MM-DD`, for a file name. */
export function fileDate(now: number): string {
  const at = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
