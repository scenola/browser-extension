/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import { expiringSoon, slideExpiry } from './connection';
import type { ConnectionState } from './connection';
import { DAY_MS } from './time';

const NOW = 1_000_000 * DAY_MS;
const conn = (connectedAt: number, expiresAt: number): ConnectionState => ({
  kind: 'connected',
  id: 'c1',
  strategy: 'pkce_dpop',
  connectedAt,
  expiresAt,
});

describe('slideExpiry', () => {
  test('slides to now + 90 d', () => {
    const s = slideExpiry(conn(NOW - 10 * DAY_MS, NOW + 5 * DAY_MS), NOW);
    expect(s).toMatchObject({ kind: 'connected', expiresAt: NOW + 90 * DAY_MS });
  });
  test('caps at connectedAt + 365 d', () => {
    const connectedAt = NOW - 300 * DAY_MS;
    const s = slideExpiry(conn(connectedAt, NOW), NOW);
    expect(s).toMatchObject({ expiresAt: connectedAt + 365 * DAY_MS });
  });
  test('other states are returned as they are', () => {
    const none: ConnectionState = { kind: 'none' };
    expect(slideExpiry(none, NOW)).toBe(none);
  });
});

describe('expiringSoon', () => {
  test('within 14 days', () => {
    expect(expiringSoon(conn(0, NOW + 14 * DAY_MS), NOW)).toBe(true);
    expect(expiringSoon(conn(0, NOW + 14 * DAY_MS + 1), NOW)).toBe(false);
    expect(expiringSoon(conn(0, NOW - 1), NOW)).toBe(true);
  });
  test('only a connection can expire', () => {
    expect(expiringSoon({ kind: 'none' }, NOW)).toBe(false);
    expect(expiringSoon({ kind: 'broken', reason: 'key_missing' }, NOW)).toBe(false);
  });
});
