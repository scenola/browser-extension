/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The account's rule as the last connection check read it, in `chrome.storage.local`: kept across
// a browser restart, so a browser started offline still sends a film's start by the rule it last
// knew. Nothing here is a secret (a share, a number of seconds, a connection id); the worker
// closes the area to content scripts (`closeToContentScripts`). A read is total: anything but a record is none, and a
// rule out of bounds is starts off, as the gateway reads one.

import { readAccountRule } from '@mt/core';
import type { Browser } from 'wxt/browser';

import type { AccountRuleRecord, AccountRuleStore } from '../composition/ports';
import { isRecord } from '../values';

const KEY = 'accountRule';
const MAX_ID = 128;

/** A stored value as a record, or `null` for anything that is not one. */
function readRuleRecord(x: unknown): AccountRuleRecord | null {
  if (!isRecord(x) || !isRecord(x.rule)) return null;
  const { connectionId } = x;
  if (typeof connectionId !== 'string' || connectionId === '' || connectionId.length > MAX_ID) {
    return null;
  }
  const { rule } = readAccountRule(
    x.rule.startThresholdPercent,
    x.rule.startFloorSeconds,
    x.rule.finishThresholdPercent,
  );
  return { connectionId, rule };
}

export class LocalAccountRuleStore implements AccountRuleStore {
  readonly #area: Pick<Browser.storage.StorageArea, 'get' | 'set' | 'remove'>;

  constructor(area: Pick<Browser.storage.StorageArea, 'get' | 'set' | 'remove'>) {
    this.#area = area;
  }

  async get(): Promise<AccountRuleRecord | null> {
    const stored = await this.#area.get(KEY);
    return readRuleRecord(stored[KEY]);
  }

  async set(record: AccountRuleRecord | null): Promise<void> {
    if (record === null) await this.#area.remove(KEY);
    else await this.#area.set({ [KEY]: record });
  }
}
