/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The composition root and the account: the connection check, the account's lines kept for the
// connection that read them, the finish line and a film begun, the plays the lines did not count,
// *Disconnect from this browser*, and a play kept for the account it was recorded for. Through
// the harness (test-harness.ts).

import { DEFAULT_RULE } from '@mt/core';
import type {
  AccountRule,
  ConnectionCheckResult,
  ConnectionState,
  HistoryEntry,
  OutboxEntry,
  SettingsValue,
} from '@mt/core';
import { FakeAuthStrategy, InMemoryConnectionRepo } from '@mt/core/testing';
import { describe, expect, test, vi } from 'vitest';

import { createRoot } from './root';
import {
  CONNECTED,
  DAY,
  MemoryCheckStore,
  PRIME_FILM,
  ROOT_ACCOUNT,
  T0,
  WHOLE_FILM,
  askUi,
  drainMicrotasks,
  filmSnapshot,
  harness,
  leaving,
  loggedAs,
  playFilm,
  report,
  sampleAt,
  settle,
  snapshotOf,
  useRootTestEnvironment,
} from './test-harness';
import type { Harness } from './test-harness';

useRootTestEnvironment();

// The finish line is the account's, read with the connection, and the extension has no counting
// setting of its own.
describe('the account’s finish line decides what is recorded', () => {
  test('ui/settings takes no counting threshold', async () => {
    const h = harness();
    const response = await askUi(h, { type: 'ui/settings', patch: { countAt: 0.9 } });
    expect(response).toMatchObject({ ok: false, error: 'bad_request' });
    const read = await askUi(h, { type: 'ui/settings', patch: {} });
    expect((read as { data?: SettingsValue }).data).not.toHaveProperty('countAt');
  });

  test('the line the connection check kept decides what is sent', async () => {
    // 15…105 of a 150 s film played, then it ended: 90 s of a story of 132 s (150 less the
    // 12 % credits estimate) — about 68 %: over a 50 % line, under the never-read 70 %.
    const positions = [0, 15, 30, 45, 60, 75, 90, 105, 150];
    const frame = { tabId: 1, frameId: 0, url: PRIME_FILM };
    const unread = harness({ ruleKept: null });
    await playFilm(unread, frame, positions);
    expect(unread.outbox.entries()).toEqual([]);
    expect(unread.gateway.sends).toEqual([]);

    const lenient = harness({
      ruleKept: null,
      check: {
        kind: 'ok',
        accountKey: ROOT_ACCOUNT,
        status: 'active',
        expiresAt: T0 + 60 * DAY,
        rule: { ...DEFAULT_RULE, finishThresholdPercent: 50 },
      },
    });
    await lenient.root.onUiOpened();
    await playFilm(lenient, frame, positions);
    expect(lenient.outbox.entries().length + lenient.gateway.sends.length).toBe(1);
  });
});

describe('the connection check', () => {
  const SERVER_EXPIRY = T0 + 60 * DAY;
  const ACTIVE: ConnectionCheckResult = {
    kind: 'ok',
    accountKey: ROOT_ACCOUNT,
    status: 'active',
    expiresAt: SERVER_EXPIRY,
    rule: DEFAULT_RULE,
  };

  const pending = (): OutboxEntry => ({
    playId: '0192f1a2-7b3c-7d4e-8f5a-6b7c8d9e0f10',
    viewingId: 'v-1',
    body: {
      kind: 'movie',
      title: 'Arrival',
      watched_at: '2026-10-20T21:40:00+02:00',
      duration_seconds: 6_960,
      furthest_position_seconds: 6_500,
      ended: true,
    },
    createdAt: T0,
    watchedAt: T0,
    attempts: 0,
    nextAttemptAt: T0 + DAY,
    state: 'pending',
    lastError: null,
  });

  test('a page opening its port asks once; the server’s expiry replaces the estimate', async () => {
    const h = harness({ check: ACTIVE });
    await h.root.onUiOpened();
    expect(h.checker.check).toHaveBeenCalledTimes(1);
    const state = await h.root.uiState(null);
    expect(state.connection).toMatchObject({
      kind: 'connected',
      id: 'conn-1',
      expiresAt: SERVER_EXPIRY,
    });
    expect(state.connectionCheck).toEqual({
      status: 'active',
      expiresAt: SERVER_EXPIRY,
      checkedAt: T0,
    });
  });

  test('the worker asks when it starts', async () => {
    const h = harness({ check: ACTIVE });
    await h.root.onWake();
    await drainMicrotasks();
    expect(h.checker.check).toHaveBeenCalledTimes(1);
  });

  test('at most once a minute, a restarted worker included (storage.session)', async () => {
    const checks = new MemoryCheckStore();
    const h = harness({ check: ACTIVE, checks });
    await h.root.onUiOpened();
    h.clock.set(T0 + 59_000);
    await h.root.onUiOpened();
    expect(h.checker.check).toHaveBeenCalledTimes(1);

    const restarted = harness({ check: ACTIVE, checks });
    restarted.clock.set(T0 + 59_000);
    await restarted.root.onWake();
    await drainMicrotasks();
    expect(restarted.checker.check).not.toHaveBeenCalled();
    // What the server said is still shown by the new worker.
    expect((await restarted.root.uiState(null)).connectionCheck?.status).toBe('active');
    restarted.clock.set(T0 + 60_000);
    await restarted.root.onUiOpened();
    expect(restarted.checker.check).toHaveBeenCalledTimes(1);
  });

  test('two pages opening at once ask once', async () => {
    const h = harness({ check: ACTIVE });
    await Promise.all([h.root.onUiOpened(), h.root.onUiOpened()]);
    expect(h.checker.check).toHaveBeenCalledTimes(1);
  });

  test('401: the connection is broken and the outbox pauses, as the plays route’s 401 does', async () => {
    const h = harness({ check: { kind: 'credential_invalid' } });
    await h.outbox.add(pending());
    await h.root.onUiOpened();
    expect(await h.connection.get()).toEqual({ kind: 'broken', reason: 'credential_invalid' });
    expect(h.outbox.entries().map((e) => e.state)).toEqual(['paused']);
    const state = await h.root.uiState(null);
    expect(state.connection).toEqual({ kind: 'broken', reason: 'credential_invalid' });
    expect(state.connectionCheck).toBeNull();
  });

  test('braked: stated, and the icon shows the braked problem', async () => {
    const h = harness({
      check: {
        kind: 'ok',
        accountKey: ROOT_ACCOUNT,
        status: 'braked',
        expiresAt: SERVER_EXPIRY,
        rule: DEFAULT_RULE,
      },
    });
    await h.root.onUiOpened();
    expect((await h.root.uiState(null)).connectionCheck?.status).toBe('braked');
    const shown = h.status.shown.filter((s) => s.tabId === null).at(-1)?.status;
    expect(shown?.tooltip.key).toBe('status.problem.braked');
    expect(shown?.badge).toEqual({ text: '!', tone: 'danger' });
  });

  test('suspended: stated; the icon says nothing of it', async () => {
    const h = harness({
      check: {
        kind: 'ok',
        accountKey: ROOT_ACCOUNT,
        status: 'suspended',
        expiresAt: SERVER_EXPIRY,
        rule: DEFAULT_RULE,
      },
    });
    await h.root.onUiOpened();
    expect((await h.root.uiState(null)).connectionCheck?.status).toBe('suspended');
    const shown = h.status.shown.filter((s) => s.tabId === null).at(-1)?.status;
    // The default icon says "not tracking this page", not "nothing playing"
    expect(shown?.tooltip.key).toBe('status.not_tracking');
    expect(shown?.badge).toBeNull();
  });

  test('a credential with no end keeps the estimate', async () => {
    const h = harness({
      check: {
        kind: 'ok',
        accountKey: ROOT_ACCOUNT,
        status: 'active',
        expiresAt: null,
        rule: DEFAULT_RULE,
      },
    });
    await h.root.onUiOpened();
    expect(await h.connection.get()).toEqual(CONNECTED);
    expect((await h.root.uiState(null)).connectionCheck).toEqual({
      status: 'active',
      expiresAt: null,
      checkedAt: T0,
    });
  });

  test('no answer changes nothing, is logged by its detail, and still counts for the minute', async () => {
    const h = harness({ check: { kind: 'unavailable', detail: 'http_503' } });
    await h.root.onUiOpened();
    expect(await h.connection.get()).toEqual(CONNECTED);
    expect((await h.root.uiState(null)).connectionCheck).toBeNull();
    expect(h.diagnostics.log).toHaveBeenCalledWith('connection.check_unavailable', {
      detail: 'http_503',
    });
    h.clock.set(T0 + 30_000);
    await h.root.onUiOpened();
    expect(h.checker.check).toHaveBeenCalledTimes(1);
  });

  test('a check that throws is no answer', async () => {
    const h = harness({ check: () => Promise.reject(new TypeError('boom')) });
    await h.root.onUiOpened();
    expect(await h.connection.get()).toEqual(CONNECTED);
    expect((await h.root.uiState(null)).connectionCheck).toBeNull();
  });

  test.each<[string, ConnectionCheckResult]>([
    ['a 401', { kind: 'credential_invalid' }],
    ['a 200', ACTIVE],
  ])('%s for a connection replaced meanwhile changes nothing', async (_name, result) => {
    let release: (r: ConnectionCheckResult) => void = () => undefined;
    const h = harness({
      check: () =>
        new Promise<ConnectionCheckResult>((resolve) => {
          release = resolve;
        }),
    });
    const opened = h.root.onUiOpened();
    await drainMicrotasks();
    expect(h.checker.check).toHaveBeenCalledTimes(1);
    const reconnected: ConnectionState = {
      kind: 'connected',
      id: 'conn-2',
      strategy: 'pkce_dpop',
      connectedAt: T0,
      expiresAt: T0 + 90 * DAY,
    };
    await h.connection.set(reconnected);
    release(result);
    await opened;
    expect(await h.connection.get()).toEqual(reconnected);
    expect((await h.root.uiState(null)).connectionCheck).toBeNull();
  });

  test.each<[string, ConnectionState]>([
    ['without a connection', { kind: 'none' }],
    ['with a broken one', { kind: 'broken', reason: 'credential_invalid' }],
  ])('%s nothing is asked', async (_name, state) => {
    const h = harness({
      check: ACTIVE,
      overrides: { connection: new InMemoryConnectionRepo(state) },
    });
    await h.root.onUiOpened();
    await h.root.onWake();
    await drainMicrotasks();
    expect(h.checker.check).not.toHaveBeenCalled();
  });

  test('a clock that went back does not hold the next ask off', async () => {
    const h = harness({ check: ACTIVE });
    await h.root.onUiOpened();
    h.clock.set(T0 - 10_000);
    await h.root.onUiOpened();
    expect(h.checker.check).toHaveBeenCalledTimes(2);
  });

  test.each(['ui/disconnect', 'ui/clear'])('%s forgets what the server said', async (type) => {
    const h = harness({ check: ACTIVE });
    await h.root.onUiOpened();
    expect(h.checks.record).not.toBeNull();
    await askUi(h, leaving(type));
    expect(h.checks.record).toBeNull();
    expect((await h.root.uiState(null)).connectionCheck).toBeNull();
  });
});

describe('a sign-in or receipt that could not ask says why in the log only', () => {
  test('ui/connect: an unavailable answer’s detail is logged and never reaches the page', async () => {
    const strategy = new FakeAuthStrategy('pkce_dpop', { kind: 'unavailable', detail: 'http_503' });
    const h = harness({ strategies: [strategy] });
    const response = await askUi(h, { type: 'ui/connect', strategy: 'pkce_dpop' });
    expect(response).toEqual({ ok: true, data: { result: { kind: 'unavailable' } } });
    expect(h.diagnostics.log).toHaveBeenCalledWith('connect.unavailable', {
      strategy: 'pkce_dpop',
      detail: 'http_503',
    });
  });

  test('a receipt read that is unavailable is logged by its detail', async () => {
    const h = harness();
    h.gateway.onReceipt = () => ({ kind: 'unavailable', detail: 'http_404' });
    await h.history.put({
      playId: 'play-1',
      scrobbleId: '01jxk4a9b2c8m4n6p8q0r2s4t6',
      body: {
        kind: 'movie',
        title: 'Arrival',
        watched_at: '2026-10-20T21:40:00+02:00',
        duration_seconds: 6_960,
        furthest_position_seconds: 6_500,
        ended: true,
      },
      sentAt: T0 - 60_000,
      receipt: null,
      receiptReadAt: null,
      receiptGoneAt: null,
      label: 'Arrival',
      accountKey: ROOT_ACCOUNT,
    });
    await h.root.onAlarm('receipts');
    expect(h.gateway.reads).toEqual(['01jxk4a9b2c8m4n6p8q0r2s4t6']);
    expect(h.diagnostics.log).toHaveBeenCalledWith('receipt.unavailable', { detail: 'http_404' });
  });
});

describe('the account’s start rule, from the connection check', () => {
  const RULE = { startThresholdPercent: 10, startFloorSeconds: 300, finishThresholdPercent: 70 };
  const ON: ConnectionCheckResult = {
    kind: 'ok',
    accountKey: ROOT_ACCOUNT,
    status: 'active',
    expiresAt: T0 + 60 * DAY,
    rule: RULE,
  };

  test('kept for the connection that asked; another connection has none until it asks', async () => {
    const h = harness({ check: ON, ruleKept: null });
    expect((await h.root.uiState(null)).accountRule).toEqual(DEFAULT_RULE);
    await h.root.onUiOpened();
    expect((await h.root.uiState(null)).accountRule).toEqual(RULE);
    expect(h.rules.record).toEqual({ connectionId: 'conn-1', rule: RULE });
    await h.connection.set({ ...CONNECTED, id: 'conn-2' });
    expect((await h.root.uiState(null)).accountRule).toEqual(DEFAULT_RULE);
  });

  test('a start the rule refused asks again at once, past the once-a-minute bound', async () => {
    const h = harness({ check: ON });
    await h.root.onUiOpened();
    expect(h.checker.check).toHaveBeenCalledTimes(1);
    await h.outbox.add({
      playId: '0192f1a2-7b3c-7d4e-8f5a-6b7c8d9e0f11',
      viewingId: 'v-1',
      body: {
        report: 'start',
        kind: 'movie',
        title: 'Arrival',
        duration_seconds: 6_960,
        furthest_position_seconds: 1_020,
      },
      createdAt: T0,
      watchedAt: T0,
      attempts: 0,
      nextAttemptAt: T0,
      state: 'pending',
      lastError: null,
      accountKey: ROOT_ACCOUNT,
    });
    h.gateway.onSend = () => ({
      kind: 'accepted',
      scrobbleId: null,
      state: 'ignored',
      reason: 'not_completed',
    });
    await h.root.onAlarm('outbox');
    await drainMicrotasks();
    expect(h.checker.check).toHaveBeenCalledTimes(2);
    expect(await h.outbox.list()).toEqual([]);
    expect(h.diagnostics.log).toHaveBeenCalledWith('play.not_counted', {});
  });
});

describe('the account’s rule is kept for the connection that read it', () => {
  const RULE = { startThresholdPercent: 10, startFloorSeconds: 300, finishThresholdPercent: 70 };
  const ON: ConnectionCheckResult = {
    kind: 'ok',
    accountKey: ROOT_ACCOUNT,
    status: 'active',
    expiresAt: T0 + 60 * DAY,
    rule: RULE,
  };
  const ruleOf = async (h: Harness) => (await h.root.uiState(null)).accountRule;

  test('a rule never read: starts are off and the finish line is the server’s 70 %', async () => {
    const h = harness({ ruleKept: null });
    expect(await ruleOf(h)).toMatchObject({
      startThresholdPercent: null,
      finishThresholdPercent: 70,
    });
  });

  test('a restarted worker still has it: it lives in storage that outlasts the worker', async () => {
    const h = harness({ check: ON, ruleKept: null });
    await h.root.onUiOpened();
    const restarted = createRoot(h.deps);
    expect((await restarted.uiState(null)).accountRule).toEqual(RULE);
  });

  test('a connect forgets it without a write; the next check reads it for the new connection', async () => {
    // The connect asks at once; that first ask finds the server unavailable.
    const answers: ConnectionCheckResult[] = [ON, { kind: 'unavailable', detail: 'http_503' }];
    const h = harness({
      check: () => Promise.resolve(answers.shift() ?? ON),
      ruleKept: null,
      strategies: [
        new FakeAuthStrategy('pkce_dpop', {
          kind: 'connected',
          state: { ...CONNECTED, id: 'conn-2', strategy: 'pkce_dpop' },
        }),
      ],
    });
    await h.root.onUiOpened();
    expect(await ruleOf(h)).toEqual(RULE);
    await askUi(h, { type: 'ui/connect', strategy: 'pkce_dpop' });
    await drainMicrotasks();
    expect(h.checker.check).toHaveBeenCalledTimes(2);
    expect(await ruleOf(h)).toMatchObject({
      startThresholdPercent: null,
      finishThresholdPercent: 70,
    });
    // The old connection's record is still there: nothing was written, nothing is decided by it.
    expect(h.rules.record).toEqual({ connectionId: 'conn-1', rule: RULE });
    h.clock.advance(61_000);
    await h.root.onUiOpened();
    expect(await ruleOf(h)).toEqual(RULE);
    expect(h.rules.record?.connectionId).toBe('conn-2');
  });

  test.each<[string, ConnectionState]>([
    ['broken', { kind: 'broken', reason: 'credential_invalid' }],
    ['absent', { kind: 'none' }],
  ])('a %s connection has the never-read rule, whatever is stored', async (_name, state) => {
    const h = harness({ check: ON, ruleKept: null });
    await h.root.onUiOpened();
    await h.connection.set(state);
    expect(await ruleOf(h)).toMatchObject({
      startThresholdPercent: null,
      finishThresholdPercent: 70,
    });
  });

  test.each(['ui/disconnect', 'ui/clear'])('%s deletes it', async (type) => {
    const h = harness({ check: ON, ruleKept: null });
    await h.root.onUiOpened();
    expect(h.rules.record).not.toBeNull();
    await askUi(h, leaving(type));
    expect(h.rules.record).toBeNull();
  });

  test.each(['ui/disconnect', 'ui/clear'])(
    '%s while an answer is being kept: nothing of it is written after',
    async (type) => {
      // The check's store holds the answer's write until the request has run.
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const checks = new MemoryCheckStore();
      const write = checks.set.bind(checks);
      checks.set = async (record) => {
        if (record?.answer != null) await held;
        await write(record);
      };
      const h = harness({ check: ON, ruleKept: null, checks });
      const checking = h.root.onUiOpened();
      await drainMicrotasks();
      const forgetting = askUi(h, leaving(type));
      await drainMicrotasks();
      release();
      await Promise.all([checking, forgetting]);
      expect(h.rules.record).toBeNull();
      expect(await h.connection.get()).toEqual({ kind: 'none' });
    },
  );

  test('the export carries it as a stored field', async () => {
    const h = harness({ check: ON, ruleKept: null });
    await h.root.onUiOpened();
    const response = await askUi(h, { type: 'ui/export' });
    expect((response as { data?: { accountRule?: unknown } }).data?.accountRule).toEqual(RULE);
  });

  test('a change of the kept rule is logged without a title, and the same rule again is not', async () => {
    const h = harness({ check: ON, ruleKept: null });
    await h.root.onUiOpened();
    const logged = () => loggedAs(h, 'connection.rule');
    expect(logged()).toEqual([
      [
        'connection.rule',
        { startThresholdPercent: 10, startFloorSeconds: 300, finishThresholdPercent: 70 },
      ],
    ]);
    h.clock.advance(61_000);
    await h.root.onUiOpened();
    expect(logged()).toHaveLength(1);
  });

  test('starts off is logged as "off", and nothing invalid is logged for it', async () => {
    const off: ConnectionCheckResult = { ...ON, rule: { ...RULE, startThresholdPercent: null } };
    const h = harness({ check: off, ruleKept: null });
    await h.root.onUiOpened();
    expect(h.diagnostics.log).toHaveBeenCalledWith('connection.rule', {
      startThresholdPercent: 'off',
      startFloorSeconds: 300,
      finishThresholdPercent: 70,
    });
    expect(loggedAs(h, 'connection.rule_invalid')).toEqual([]);
  });

  test('fields that were missing or out of bounds are named, and the answer still counts', async () => {
    const answer: ConnectionCheckResult = {
      ...ON,
      rule: DEFAULT_RULE,
      ruleInvalid: ['start_threshold_percent', 'finish_threshold_percent'],
    };
    const h = harness({ check: answer, ruleKept: null });
    await h.root.onUiOpened();
    expect(h.diagnostics.log).toHaveBeenCalledWith('connection.rule_invalid', {
      fields: 'start_threshold_percent,finish_threshold_percent',
    });
    // The route's status and expiry are still read from the same answer.
    expect((await h.root.uiState(null)).connectionCheck).toMatchObject({
      status: 'active',
      expiresAt: T0 + 60 * DAY,
    });
  });
});

describe('a film begun, in the worker', () => {
  const FRAME = { tabId: 1, frameId: 0, url: PRIME_FILM };
  // A film of 150 s has a story of 150 − 12 % = 132 s. At 5 % of it with no floor, the start
  // line is 7 s played; at 20 % with a floor of 60 s it is 60 s played.
  const EARLY: AccountRule = {
    startThresholdPercent: 5,
    startFloorSeconds: 0,
    finishThresholdPercent: 50,
  };
  const startsOf = (h: Harness) =>
    [...h.outbox.entries().map((e) => e.body), ...h.gateway.sends.map((s) => s.body)].filter(
      (body) => body.report === 'start',
    );

  test('past the start line, one start with the play’s numbers and no time; then the play itself', async () => {
    const h = harness({ ruleKept: EARLY });
    await playFilm(h, FRAME, WHOLE_FILM);
    const starts = startsOf(h);
    expect(starts).toHaveLength(1);
    const start = starts[0];
    expect(start).toMatchObject({
      report: 'start',
      kind: 'movie',
      title: 'Arrival',
      year: 2016,
      duration_seconds: 150,
      story_seconds: 132,
    });
    expect(start?.played_seconds).toBeGreaterThanOrEqual(7);
    expect(start?.furthest_position_seconds).toBeGreaterThanOrEqual(7);
    // No time, no end: the start says only that the film was begun.
    expect(start).not.toHaveProperty('watched_at');
    expect(start).not.toHaveProperty('ended');
    // The viewing is its own play, with its own key.
    const keys = [
      ...h.outbox.entries().map((e) => e.playId),
      ...h.gateway.sends.map((s) => s.playId),
    ];
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    const plays = [...h.outbox.entries().map((e) => e.body), ...h.gateway.sends.map((s) => s.body)];
    const viewing = plays.find((body) => body.report !== 'start');
    expect(viewing).toMatchObject({ kind: 'movie', title: 'Arrival' });
    expect(typeof (viewing as { watched_at?: unknown }).watched_at).toBe('string');
  });

  test('the start is queued before the play, which waits for its own line', async () => {
    const h = harness({ ruleKept: EARLY });
    await playFilm(h, FRAME, [0, 15, 30, 45]);
    expect(startsOf(h)).toHaveLength(1);
    const bodies = [
      ...h.outbox.entries().map((e) => e.body),
      ...h.gateway.sends.map((s) => s.body),
    ];
    expect(bodies.filter((body) => body.report !== 'start')).toEqual([]);
  });

  test('starts off: none is sent, the finished film is its one play', async () => {
    const h = harness({ ruleKept: { ...EARLY, startThresholdPercent: null } });
    await playFilm(h, FRAME, WHOLE_FILM);
    expect(startsOf(h)).toEqual([]);
    expect(h.gateway.sends.length + h.outbox.entries().length).toBe(1);
  });

  test('a rule never read: starts are off', async () => {
    const h = harness({ ruleKept: null });
    await playFilm(h, FRAME, [0, 15, 30, 45, 60, 75, 90]);
    expect(startsOf(h)).toEqual([]);
  });

  test('a skim to the end plays too little to start: nothing is sent, however far the position went', async () => {
    const h = harness({
      ruleKept: { startThresholdPercent: 20, startFloorSeconds: 60, finishThresholdPercent: 50 },
    });
    // Bound at the second observation, then a jump to the end: the furthest position is the
    // end, and the story seconds played are about the 30 s before the jump and the 15 after.
    await playFilm(h, FRAME, [0, 15, 30, 135, 150]);
    expect(h.gateway.sends).toEqual([]);
    expect(h.outbox.entries()).toEqual([]);
  });

  test('a start has no time to age by: its entry is counted from the moment it was queued', async () => {
    const h = harness({ ruleKept: EARLY });
    h.gateway.onSend = () => ({ kind: 'unavailable', detail: 'http_503' });
    await playFilm(h, FRAME, [0, 15, 30, 45]);
    const entry = h.outbox.entries().find((e) => e.body.report === 'start');
    expect(entry).toBeDefined();
    expect(entry?.watchedAt).toBe(entry?.createdAt);
  });

  test('an episode is never started', async () => {
    const url = 'https://series.example/watch/221#t:221-s:5-e:1';
    const h = harness({ settings: { allowedHosts: ['series.example'] }, ruleKept: EARLY });
    const snapshot = snapshotOf(url, {
      openGraph: { 'og:type': 'video.tv_series', 'og:title': 'Some Show (2020)' },
    });
    await playFilm(h, { tabId: 1, frameId: 0, url }, [0, 15, 30, 45, 60], snapshot);
    expect(h.viewings.all()).toHaveLength(1);
    expect(startsOf(h)).toEqual([]);
  });

  test('the rule is read only when one of its lines may apply: once the length is known', async () => {
    const url = 'https://series.example/watch/221#t:221-s:5-e:1';
    const h = harness({ settings: { allowedHosts: ['series.example'] }, ruleKept: EARLY });
    const read = vi.spyOn(h.rules, 'get');
    const snapshot = snapshotOf(url, {
      openGraph: { 'og:type': 'video.tv_series', 'og:title': 'Some Show (2020)' },
    });
    // An episode whose player states no length: there is no story to draw a line on.
    for (const [i, position] of [0, 15, 30, 45].entries()) {
      h.clock.set(T0 + i * 15_000);
      await report(
        h,
        { tabId: 1, frameId: 0, url },
        sampleAt(h.clock, position, { duration: null }),
        snapshot,
      );
      await settle();
    }
    expect(h.viewings.all()).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
    // The length shows: the finish line may be reached in any observation from now on.
    await playFilm(h, { tabId: 1, frameId: 0, url }, [60, 75], snapshot, 60);
    expect(read).toHaveBeenCalled();
  });

  test('queueing a start is logged with the viewing’s id and nothing of the film', async () => {
    const h = harness({ ruleKept: EARLY });
    await playFilm(h, FRAME, [0, 15, 30, 45]);
    const [viewing] = h.viewings.all();
    expect(loggedAs(h, 'viewing.started')).toEqual([
      ['viewing.started', { viewingId: viewing?.id }],
    ]);
  });

  test('a start nobody could send for 29 days is given up, and never sent after', async () => {
    const h = harness({ ruleKept: EARLY });
    h.gateway.onSend = () => ({ kind: 'unavailable', detail: 'http_503' });
    await playFilm(h, FRAME, [0, 15, 30, 45]);
    const queued = h.outbox.entries().find((e) => e.body.report === 'start');
    expect(queued).toBeDefined();
    const sends = h.gateway.sends.length;
    h.clock.set((queued?.createdAt ?? 0) + 29 * DAY + 1_000);
    await h.root.onAlarm('outbox');
    await drainMicrotasks();
    expect(h.outbox.entries().find((e) => e.playId === queued?.playId)?.state).toBe('dead');
    expect(h.gateway.sends.length).toBe(sends);
  });

  test('a film that has sent its start reads the rule for its finish line, and none after its play', async () => {
    const h = harness({ ruleKept: EARLY });
    const read = vi.spyOn(h.rules, 'get');
    await playFilm(h, FRAME, [0, 15, 30, 45]);
    expect(startsOf(h)).toHaveLength(1);
    const before = read.mock.calls.length;
    // Its finish line, 66 s of the 132 s story, is reached at the 90 s sample.
    await playFilm(h, FRAME, [60, 75, 90], filmSnapshot(PRIME_FILM), 60);
    expect(read.mock.calls.length).toBeGreaterThan(before);
    expect(h.viewings.all()[0]?.state).toBe('reported');
    const reported = read.mock.calls.length;
    await playFilm(h, FRAME, [105, 120], filmSnapshot(PRIME_FILM), 105);
    expect(read.mock.calls.length).toBe(reported);
  });
});

describe('a play or a start the account’s lines did not count', () => {
  const ON: ConnectionCheckResult = {
    kind: 'ok',
    accountKey: ROOT_ACCOUNT,
    status: 'active',
    expiresAt: T0 + 60 * DAY,
    rule: { startThresholdPercent: 10, startFloorSeconds: 300, finishThresholdPercent: 70 },
  };
  const entry = (n: number, report: 'start' | 'viewing'): OutboxEntry => ({
    playId: `0192f1a2-7b3c-7d4e-8f5a-6b7c8d9e0f${String(30 + n)}`,
    viewingId: `v-${String(n)}`,
    body:
      report === 'start'
        ? {
            report: 'start',
            kind: 'movie',
            title: `Film ${String(n)}`,
            duration_seconds: 6_960,
            furthest_position_seconds: 1_020,
          }
        : {
            kind: 'movie',
            title: `Film ${String(n)}`,
            watched_at: '2026-10-20T21:40:00+02:00',
            duration_seconds: 6_960,
            furthest_position_seconds: 6_500,
          },
    createdAt: T0,
    watchedAt: T0,
    attempts: 0,
    nextAttemptAt: T0,
    state: 'pending',
    lastError: null,
    accountKey: ROOT_ACCOUNT,
  });
  const notCounted: SendResultLike = () => ({
    kind: 'accepted',
    scrobbleId: null,
    state: 'ignored',
    reason: 'not_completed',
  });
  type SendResultLike = NonNullable<Harness['gateway']['onSend']>;

  test('a pass that met several asks once, however many; the minute then counts from that ask', async () => {
    const h = harness({ check: ON });
    await h.root.onUiOpened();
    expect(h.checker.check).toHaveBeenCalledTimes(1);
    for (const e of [entry(1, 'start'), entry(2, 'start'), entry(3, 'viewing')]) {
      await h.outbox.add(e);
    }
    h.gateway.onSend = notCounted;
    await h.root.onAlarm('outbox');
    await drainMicrotasks();
    expect(h.gateway.sends).toHaveLength(3);
    expect(h.checker.check).toHaveBeenCalledTimes(2);
    expect(await h.outbox.list()).toEqual([]);

    // The bound counts from the forced ask.
    h.clock.advance(59_000);
    await h.root.onUiOpened();
    expect(h.checker.check).toHaveBeenCalledTimes(2);
    h.clock.advance(2_000);
    await h.root.onUiOpened();
    expect(h.checker.check).toHaveBeenCalledTimes(3);
  });

  test('a viewing the lines did not count asks again too', async () => {
    const h = harness({ check: ON });
    await h.root.onUiOpened();
    await h.outbox.add(entry(1, 'viewing'));
    h.gateway.onSend = notCounted;
    await h.root.onAlarm('outbox');
    await drainMicrotasks();
    expect(h.checker.check).toHaveBeenCalledTimes(2);
    expect(h.diagnostics.log).toHaveBeenCalledWith('play.not_counted', {});
  });

  test('a check already running answers for it: no second ask goes out', async () => {
    let release: (r: ConnectionCheckResult) => void = () => undefined;
    const h = harness({
      check: () =>
        new Promise<ConnectionCheckResult>((resolve) => {
          release = resolve;
        }),
    });
    const opened = h.root.onUiOpened();
    await drainMicrotasks();
    expect(h.checker.check).toHaveBeenCalledTimes(1);
    await h.outbox.add(entry(1, 'start'));
    h.gateway.onSend = notCounted;
    await h.root.onAlarm('outbox');
    await drainMicrotasks();
    expect(h.checker.check).toHaveBeenCalledTimes(1);
    release(ON);
    await opened;
    expect(h.checker.check).toHaveBeenCalledTimes(1);
  });

  test('a viewing played in full asks nothing: the rule is read from where it was kept', async () => {
    const h = harness({ check: ON, ruleKept: { ...DEFAULT_RULE, finishThresholdPercent: 50 } });
    await playFilm(h, { tabId: 1, frameId: 0, url: PRIME_FILM }, WHOLE_FILM);
    expect(h.gateway.sends.length + h.outbox.entries().length).toBe(1);
    expect(h.checker.check).not.toHaveBeenCalled();
  });

  test('another answer that keeps nothing does not', async () => {
    const h = harness({ check: ON });
    await h.root.onUiOpened();
    await h.outbox.add(entry(1, 'start'));
    h.gateway.onSend = () => ({
      kind: 'accepted',
      scrobbleId: null,
      state: 'dismissed',
      reason: 'account_deletion',
    });
    await h.root.onAlarm('outbox');
    await drainMicrotasks();
    expect(h.checker.check).toHaveBeenCalledTimes(1);
    expect(h.diagnostics.log).not.toHaveBeenCalledWith('play.not_counted', {});
  });

  test('an answer of "not counted" for a start reads as such: neutral, settled, no link', async () => {
    const h = harness({ check: ON });
    await h.outbox.add(entry(1, 'start'));
    h.gateway.onSend = notCounted;
    await h.root.onAlarm('outbox');
    await drainMicrotasks();
    const [line] = (await h.root.uiState(null)).recent;
    expect(line).toMatchObject({
      start: true,
      href: null,
      view: { tone: 'neutral', link: null, settled: true },
    });
  });

  test('a viewing the lines did not count keeps its own words, not the start’s', async () => {
    const h = harness({ check: ON });
    await h.outbox.add(entry(1, 'start'));
    await h.outbox.add({ ...entry(2, 'viewing'), nextAttemptAt: T0 });
    h.gateway.onSend = notCounted;
    await h.root.onAlarm('outbox');
    await drainMicrotasks();
    const lines = (await h.root.uiState(null)).recent;
    const start = lines.find((l) => l.start);
    const viewing = lines.find((l) => !l.start);
    expect(start).toBeDefined();
    expect(viewing).toBeDefined();
    expect(start?.view.messageKey).not.toBe(viewing?.view.messageKey);
  });
});

describe('Disconnect from this browser, in the worker', () => {
  const queued = (n: number, o: Partial<OutboxEntry> = {}): OutboxEntry => ({
    playId: `0192f1a2-7b3c-7d4e-8f5a-6b7c8d9e0f${String(n).padStart(2, '0')}`,
    viewingId: `v-${String(n)}`,
    body: { kind: 'movie', title: 'Arrival', watched_at: '2026-10-20T21:40:00+02:00' },
    createdAt: T0 - n,
    watchedAt: T0 - n,
    attempts: 1,
    nextAttemptAt: T0 + DAY,
    state: 'pending',
    lastError: 'http_503',
    accountKey: ROOT_ACCOUNT,
    ...o,
  });
  const sentBefore: HistoryEntry = {
    playId: '0192f1a2-7b3c-7d4e-8f5a-6b7c8d9e0f90',
    scrobbleId: 's-90',
    body: { kind: 'movie', title: 'Heat', watched_at: '2026-10-19T21:40:00+02:00' },
    sentAt: T0 - DAY,
    receipt: { state: 'recorded', reason: null, titleId: 't-90' },
    receiptReadAt: T0 - DAY + 10_000,
    receiptGoneAt: null,
    label: 'Heat',
  };

  /** A connection with two plays waiting, one sent, an open viewing and the browser's settings. */
  async function withAccount(): Promise<Harness> {
    const h = harness({
      check: {
        kind: 'ok',
        accountKey: ROOT_ACCOUNT,
        status: 'active',
        expiresAt: T0 + 30 * DAY,
        rule: DEFAULT_RULE,
      },
      settings: { trackIncognito: true, allowedHosts: ['films.example'], diagnostics: true },
    });
    await playFilm(h, { tabId: 1, frameId: 0, url: PRIME_FILM }, WHOLE_FILM.slice(0, 4));
    await h.outbox.add(queued(1));
    await h.outbox.add(queued(2, { state: 'paused' }));
    await h.history.put(sentBefore);
    await h.root.onUiOpened();
    return h;
  }

  test('the offer counts the plays that can still go', async () => {
    const h = await withAccount();
    await h.outbox.add(queued(3, { state: 'dead', lastError: 'http_422' }));
    expect((await h.root.uiState(null)).unsent).toBe(2);
  });

  test('delete: everything of the account goes, the settings stay', async () => {
    const h = await withAccount();

    const answer = await askUi(h, { type: 'ui/disconnect', sendFirst: false });

    expect(answer).toEqual({ ok: true, data: { sent: 0, deleted: 2 } });
    expect(h.gateway.sends).toEqual([]);
    expect(await h.connection.get()).toEqual({ kind: 'none' });
    expect(h.outbox.entries()).toEqual([]);
    expect(h.history.entries()).toEqual([]);
    expect(h.viewings.all()).toEqual([]);
    expect(h.viewings.tabs()).toEqual([]);
    expect(h.checks.record).toBeNull();
    expect(h.rules.record).toBeNull();
    const state = await h.root.uiState(null);
    expect(state).toMatchObject({ recent: [], waiting: [], unsent: 0, connectionCheck: null });
    expect(await h.settings.get()).toMatchObject({
      trackIncognito: true,
      allowedHosts: ['films.example'],
      diagnostics: true,
    });
    expect(h.wipe).not.toHaveBeenCalled();
  });

  test('send first: what is left goes, then all of it is removed', async () => {
    const h = await withAccount();

    const answer = await askUi(h, { type: 'ui/disconnect', sendFirst: true });

    expect(answer).toEqual({ ok: true, data: { sent: 2, deleted: 0 } });
    expect(h.gateway.sends.map((s) => s.playId).sort()).toEqual([
      queued(1).playId,
      queued(2).playId,
    ]);
    expect(h.outbox.entries()).toEqual([]);
    expect(h.history.entries()).toEqual([]);
  });

  test('a disconnect the worker stopped in: nothing is shown, and the next start removes it', async () => {
    const h = await withAccount();
    h.account.stopBeforeRemove = true;

    expect((await askUi(h, { type: 'ui/disconnect', sendFirst: false })).ok).toBe(false);
    expect(h.outbox.entries()).toHaveLength(2);
    expect(await h.root.uiState(null)).toMatchObject({ recent: [], waiting: [], unsent: 0 });

    await h.root.onWake();

    expect(h.outbox.entries()).toEqual([]);
    expect(h.history.entries()).toEqual([]);
    expect(h.rules.record).toBeNull();
    expect(h.connection.leaving).toBe(false);
    expect(h.gateway.sends).toEqual([]);
  });
});

describe('a play belongs to the account it was recorded for', () => {
  const OTHER = 'a1:0000000000000000000000000000000b';
  const NEXT = { ...CONNECTED, id: 'conn-2', strategy: 'pkce_dpop' as const };
  const okFor = (accountKey: string): ConnectionCheckResult => ({
    kind: 'ok',
    accountKey,
    status: 'active',
    expiresAt: T0 + 60 * DAY,
    rule: DEFAULT_RULE,
  });
  const waiting = (n: number, accountKey?: string): OutboxEntry => ({
    playId: `0192f1a2-7b3c-7d4e-8f5a-6b7c8d9e0f${String(60 + n)}`,
    viewingId: `v-${String(n)}`,
    body: { kind: 'movie', title: 'Arrival', watched_at: '2026-10-20T21:40:00+02:00' },
    createdAt: T0 - n,
    watchedAt: T0 - n,
    attempts: 1,
    nextAttemptAt: T0,
    state: 'paused',
    lastError: 'credential_invalid',
    ...(accountKey === undefined ? {} : { accountKey }),
  });

  /** A broken connection's two plays waiting, and a sign-in that answers `answers` in turn. */
  async function reconnecting(answers: ConnectionCheckResult[]): Promise<Harness> {
    const h = harness({
      check: () => Promise.resolve(answers.shift() ?? { kind: 'unavailable', detail: 'gone' }),
      strategies: [new FakeAuthStrategy('pkce_dpop', { kind: 'connected', state: NEXT })],
    });
    await h.connection.set({ kind: 'broken', reason: 'credential_invalid' });
    await h.outbox.add(waiting(1, ROOT_ACCOUNT));
    await h.outbox.add(waiting(2, ROOT_ACCOUNT));
    return h;
  }

  test('another account connects: nothing of the one before is sent, and it is gone', async () => {
    const h = await reconnecting([okFor(OTHER)]);

    await askUi(h, { type: 'ui/connect', strategy: 'pkce_dpop' });
    await drainMicrotasks();

    expect(h.gateway.sends).toEqual([]);
    expect(h.outbox.entries()).toEqual([]);
    expect(h.connection.known).toEqual({ kind: 'read', key: OTHER });
    expect(h.diagnostics.log).toHaveBeenCalledWith('connection.account_kept', { deleted: 2 });
    // The log never holds the key itself.
    expect(JSON.stringify(h.diagnostics.log.mock.calls)).not.toContain(OTHER);
  });

  test('the same account reconnects: its plays go, once the check has named it', async () => {
    const h = await reconnecting([okFor(ROOT_ACCOUNT)]);

    await askUi(h, { type: 'ui/connect', strategy: 'pkce_dpop' });
    await drainMicrotasks();

    expect(h.gateway.sends).toHaveLength(2);
    expect(h.outbox.entries()).toEqual([]);
  });

  test('a check that cannot answer keeps everything waiting, unsent', async () => {
    const h = await reconnecting([{ kind: 'unavailable', detail: 'http_503' }]);

    await askUi(h, { type: 'ui/connect', strategy: 'pkce_dpop' });
    await drainMicrotasks();
    await h.root.onAlarm('outbox');
    await drainMicrotasks();

    expect(h.gateway.sends).toEqual([]);
    expect(h.outbox.entries()).toHaveLength(2);
    expect(h.connection.known).toEqual({ kind: 'unread' });
    // They may be another person's: the pages and the export show none of them meanwhile.
    expect(await h.root.uiState(null)).toMatchObject({ recent: [], unsent: 0 });
    const exported = (await askUi(h, { type: 'ui/export' })) as { data?: { outbox?: unknown } };
    expect(exported.data?.outbox).toEqual([]);
  });

  test('a connection from before keys: what it kept untagged is its own, tagged and sent', async () => {
    const h = harness({ check: okFor(ROOT_ACCOUNT) });
    h.connection.known = { kind: 'inherited' };
    await h.outbox.add({ ...waiting(1), state: 'pending' });

    await h.root.onWake();
    await drainMicrotasks();

    expect(h.connection.known).toEqual({ kind: 'read', key: ROOT_ACCOUNT });
    expect(h.gateway.sends.map((s) => s.playId)).toEqual([waiting(1).playId]);
  });

  test('the export leaves the key out', async () => {
    const h = harness();
    await playFilm(h, { tabId: 1, frameId: 0, url: PRIME_FILM }, WHOLE_FILM.slice(0, 4));
    await h.outbox.add({ ...waiting(1, ROOT_ACCOUNT), state: 'dead' });
    const answer = await askUi(h, { type: 'ui/export' });
    const text = JSON.stringify(answer);
    expect(text).not.toContain(ROOT_ACCOUNT);
    expect(text).not.toContain('accountKey');
  });
});
