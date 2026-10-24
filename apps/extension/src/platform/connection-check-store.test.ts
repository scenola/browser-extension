/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The last connection check in `storage.session`: it survives a worker restart
// within the browser session, and a value that is not a record reads as none.

import { afterEach, describe, expect, test } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { ConnectionCheckRecord } from '../composition/ports';
import { SessionConnectionCheckStore, readCheckRecord } from './connection-check-store';

const T0 = Date.UTC(2026, 9, 22, 20, 0);
const RECORD: ConnectionCheckRecord = {
  connectionId: 'conn-1',
  askedAt: T0,
  answer: { status: 'braked', expiresAt: T0 + 86_400_000, checkedAt: T0 + 120 },
};

afterEach(() => {
  fakeBrowser.reset();
});

describe('SessionConnectionCheckStore', () => {
  test('keeps a record across stores over the same area (a worker restart)', async () => {
    await new SessionConnectionCheckStore(fakeBrowser.storage.session).set(RECORD);
    expect(await new SessionConnectionCheckStore(fakeBrowser.storage.session).get()).toEqual(
      RECORD,
    );
  });

  test('null forgets it', async () => {
    const store = new SessionConnectionCheckStore(fakeBrowser.storage.session);
    await store.set(RECORD);
    await store.set(null);
    expect(await store.get()).toBeNull();
  });

  test('nothing stored is none', async () => {
    expect(await new SessionConnectionCheckStore(fakeBrowser.storage.session).get()).toBeNull();
  });
});

describe('readCheckRecord is total', () => {
  test('a record, and one asked and not answered yet', () => {
    expect(readCheckRecord(RECORD)).toEqual(RECORD);
    expect(readCheckRecord({ ...RECORD, answer: null })).toEqual({ ...RECORD, answer: null });
    const noEnd = { ...RECORD, answer: { ...RECORD.answer, expiresAt: null } };
    expect(readCheckRecord(noEnd)).toEqual(noEnd);
  });

  test.each<[string, unknown]>([
    ['nothing', undefined],
    ['null', null],
    ['an array', [RECORD]],
    ['a string', 'conn-1'],
    ['no connection id', { ...RECORD, connectionId: '' }],
    ['a connection id that is no id', { ...RECORD, connectionId: 7 }],
    ['an over-long connection id', { ...RECORD, connectionId: 'x'.repeat(129) }],
    ['no askedAt', { ...RECORD, askedAt: undefined }],
    ['an askedAt past the Date range', { ...RECORD, askedAt: 9e15 }],
    [
      'a status the route does not answer',
      { ...RECORD, answer: { ...RECORD.answer, status: 'revoked' } },
    ],
    ['an expiry that is text', { ...RECORD, answer: { ...RECORD.answer, expiresAt: 'soon' } }],
    ['no checkedAt', { ...RECORD, answer: { ...RECORD.answer, checkedAt: Number.NaN } }],
    ['an answer that is not one', { ...RECORD, answer: 'braked' }],
  ])('%s reads as none', (_name, value) => {
    expect(readCheckRecord(value)).toBeNull();
  });
});
