/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import type { ConnectionState } from './connection';
import { PAUSE_INDEFINITELY } from './settings';
import { computeStatus } from './status';
import type { StatusInputs } from './status';
import { DAY_MS } from './time';

const NOW = 1_000_000 * DAY_MS;
const connected: ConnectionState = {
  kind: 'connected',
  id: 'c',
  strategy: 'pkce_dpop',
  connectedAt: NOW - DAY_MS,
  expiresAt: NOW + 80 * DAY_MS,
};
const base: StatusInputs = {
  connection: connected,
  pausedUntil: null,
  now: NOW,
  tab: null,
  waitingCount: 0,
  problem: null,
};
const tracking = {
  tracking: { label: 'Breaking Bad · S1 E2' },
  addedAt: null,
  addedLabel: null,
  notTracked: null,
};
const ready = { ...tracking, tracking: null };

describe('computeStatus', () => {
  // The default icon (no tab of its own) is "not tracking this page".
  test('the default icon is dimmed', () => {
    const s = computeStatus(base);
    expect(s.icon).toBe('dimmed');
    expect(s.badge).toBeNull();
    expect(s.tooltip.key).toBe('status.not_tracking');
  });

  test('a tracked page with nothing recording is the outline mark', () => {
    const s = computeStatus({ ...base, tab: ready });
    expect(s.icon).toBe('outline');
    expect(s.tooltip.key).toBe('status.idle');
  });

  test.each([
    [{ why: 'service_off', service: 'Netflix' }, 'status.service_off', { service: 'Netflix' }],
    [{ why: 'incognito' }, 'status.incognito_off', {}],
    [{ why: 'site' }, 'status.blocked', {}],
  ] as const)('a tab not tracked (%j) is dimmed and says why', (notTracked, key, params) => {
    const s = computeStatus({ ...base, tab: { ...ready, notTracked } });
    expect(s.icon).toBe('dimmed');
    expect(s.tooltip).toEqual({ key, params });
  });

  test('a problem badge shows over a dimmed default', () => {
    const s = computeStatus({ ...base, problem: 'braked' });
    expect(s.icon).toBe('dimmed');
    expect(s.badge).toEqual({ text: '!', tone: 'danger' });
  });

  test('tracking names what the page says', () => {
    const s = computeStatus({ ...base, tab: tracking });
    expect(s.icon).toBe('recording');
    expect(s.tooltip).toEqual({
      key: 'status.tracking',
      params: { label: 'Breaking Bad · S1 E2' },
    });
  });

  test('disconnected shows a danger bang', () => {
    for (const connection of [
      { kind: 'none' },
      { kind: 'broken', reason: 'credential_invalid' },
    ] as const) {
      const s = computeStatus({ ...base, connection });
      expect(s.badge).toEqual({ text: '!', tone: 'danger' });
    }
    expect(computeStatus({ ...base, connection: { kind: 'none' } }).tooltip.key).toBe(
      'status.disconnected',
    );
    expect(
      computeStatus({ ...base, connection: { kind: 'broken', reason: 'key_missing' } }).tooltip.key,
    ).toBe('status.connection_broken');
  });

  test('expiring soon is a bang', () => {
    const s = computeStatus({
      ...base,
      connection: { ...connected, expiresAt: NOW + 3 * DAY_MS },
    });
    expect(s.badge).toEqual({ text: '!', tone: 'danger' });
    expect(s.tooltip.key).toBe('status.connection_expiring');
  });

  test('waiting 3 is a lamp 3; 12 is 9+; 9 is 9', () => {
    expect(computeStatus({ ...base, waitingCount: 3 }).badge).toEqual({ text: '3', tone: 'lamp' });
    expect(computeStatus({ ...base, waitingCount: 12 }).badge).toEqual({
      text: '9+',
      tone: 'lamp',
    });
    expect(computeStatus({ ...base, waitingCount: 9 }).badge?.text).toBe('9');
    expect(computeStatus({ ...base, waitingCount: 3 }).tooltip).toEqual({
      key: 'status.waiting',
      params: { count: 3 },
    });
  });

  test('added within 10 s is filled-check, after is recording', () => {
    const at = (ago: number) => ({
      ...tracking,
      addedAt: NOW - ago,
      addedLabel: 'Breaking Bad · S1 E2',
    });
    const fresh = computeStatus({ ...base, tab: at(5_000) });
    expect(fresh.icon).toBe('filled-check');
    expect(fresh.tooltip).toEqual({
      key: 'status.added',
      params: { label: 'Breaking Bad · S1 E2' },
    });
    expect(computeStatus({ ...base, tab: at(11_000) }).icon).toBe('recording');
  });

  test('added without a label uses the plain message', () => {
    const s = computeStatus({ ...base, tab: { ...tracking, addedAt: NOW - 1000 } });
    expect(s.icon).toBe('filled-check');
    expect(s.tooltip).toEqual({ key: 'status.added_plain', params: {} });
  });

  test('paused is dimmed and says until when', () => {
    const s = computeStatus({ ...base, tab: tracking, pausedUntil: NOW + 3_600_000 });
    expect(s.icon).toBe('dimmed');
    expect(s.tooltip).toEqual({ key: 'status.paused', params: { until: NOW + 3_600_000 } });
  });

  test('a pause until the person turns it back on names no time', () => {
    const s = computeStatus({ ...base, tab: tracking, pausedUntil: PAUSE_INDEFINITELY });
    expect(s.icon).toBe('dimmed');
    expect(s.tooltip).toEqual({ key: 'status.paused_indefinitely', params: {} });
  });

  test('a pause already over does not dim', () => {
    expect(computeStatus({ ...base, tab: ready, pausedUntil: NOW - 1 }).icon).toBe('outline');
  });

  test('a problem outranks waiting', () => {
    const s = computeStatus({ ...base, waitingCount: 4, problem: 'braked' });
    expect(s.badge).toEqual({ text: '!', tone: 'danger' });
    expect(s.tooltip.key).toBe('status.problem.braked');
    expect(computeStatus({ ...base, problem: 'plus_lapsed' }).tooltip.key).toBe(
      'status.problem.plus_lapsed',
    );
  });
});
