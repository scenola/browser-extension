/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the mock answers about a connection's account, against the extension's own protocol
// code: a play's receipt, the connection read, and the account's start and finish lines.

import { describe, expect, test } from 'vitest';

import { dpopSigner } from '../../packages/api/src/index';
import { DEFAULT_RULE } from '../../packages/core/src/index';
import type { PlayBody, StartBody, ViewingBody } from '../../packages/core/src/index';

import { startMockApi } from './server.ts';
import { accountKeyOf } from './state.ts';
import type { MockApi } from './server.ts';
import {
  DAY,
  MINUTE,
  MT_ID,
  SECOND,
  T0,
  connect,
  film,
  iso,
  newKey,
  useMockApi,
} from './test-client.ts';
import type { Connected } from './test-client.ts';

const start = useMockApi();

describe('receipts', () => {
  test('another connection’s play is 404; a malformed id is 422; case and aliases are one id', async () => {
    const mock = await start();
    const mine = await connect(mock);
    const theirs = await connect(mock);
    const sent = await mine.gateway.send(newKey(), film());
    const id = sent.kind === 'accepted' ? (sent.scrobbleId ?? '') : '';
    expect(await theirs.gateway.receipt(id)).toEqual({ kind: 'not_found' });
    expect((await mine.gateway.receipt(id.toUpperCase())).kind).toBe('ok');
    const aliased = id.replaceAll('0', 'O').replaceAll('1', 'l');
    expect((await mine.gateway.receipt(aliased)).kind).toBe('ok');
    const signer = dpopSigner({
      pair: mine.pair,
      jwk: mine.jwk,
      accessToken: mine.accessToken,
      nonces: mine.nonces,
      now: () => Date.now(),
      jti: newKey,
    });
    const url = `${mock.url}/v1/integrations/plays/not-an-id`;
    const response = await fetch(url, { headers: await signer.headers('GET', url) });
    expect(response.status).toBe(422);
    expect(response.headers.get('DPoP-Nonce')).not.toBeNull();
  });

  test('a scripted progression is read on the mock’s clock', async () => {
    const mock = await start({
      script: {
        progression: () => [
          { afterMs: 0, state: 'received' },
          { afterMs: 10 * SECOND, state: 'needs_confirmation', reason: 'text_only' },
          { afterMs: 60 * SECOND, state: 'duplicate' },
        ],
      },
    });
    const c = await connect(mock);
    const sent = await c.gateway.send(newKey(), film());
    const id = sent.kind === 'accepted' ? (sent.scrobbleId ?? '') : '';
    mock.advance(10 * SECOND);
    expect(await c.gateway.receipt(id)).toEqual({
      kind: 'ok',
      state: 'needs_confirmation',
      reason: 'text_only',
      titleId: null,
      questionKey: null,
    });
    mock.advance(50 * SECOND);
    const settled = await c.gateway.receipt(id);
    expect(settled.kind === 'ok' ? [settled.state, settled.titleId] : null).toEqual([
      'duplicate',
      expect.stringMatching(MT_ID),
    ]);
  });

  test('a scripted question key is answered only while the play waits on the person', async () => {
    const mock = await start({
      script: {
        progression: () => [
          { afterMs: 0, state: 'needs_confirmation', reason: 'text_only', questionKey: 'q1:a' },
          { afterMs: 10 * SECOND, state: 'received', questionKey: 'q1:a' },
        ],
      },
    });
    const c = await connect(mock);
    const sent = await c.gateway.send(newKey(), film());
    const id = sent.kind === 'accepted' ? (sent.scrobbleId ?? '') : '';
    expect(await c.gateway.receipt(id)).toMatchObject({
      state: 'needs_confirmation',
      questionKey: 'q1:a',
    });
    mock.advance(10 * SECOND);
    expect(await c.gateway.receipt(id)).toMatchObject({ state: 'received', questionKey: null });
  });

  // A viewing short of the finish line is answered at the door and
  // not kept — it is no longer stored and then ignored.
  test('by default a play short of 70 % with numbers is answered ignored(not_completed), not kept', async () => {
    const mock = await start();
    const c = await connect(mock);
    const sent = await c.gateway.send(newKey(), {
      ...film(),
      ended: false,
      furthest_position_seconds: 600,
    });
    expect(sent).toEqual({
      kind: 'accepted',
      scrobbleId: null,
      state: 'ignored',
      reason: 'not_completed',
    });
    expect(mock.plays).toEqual([]);
  });
});

/** Dune finished: its story (credits off) and the story seconds played, as the extension sends them. */
const watched = (played: number, o: Partial<ViewingBody> = {}): ViewingBody => ({
  ...film(),
  ended: false,
  furthest_position_seconds: 8900,
  story_seconds: 8400,
  played_seconds: played,
  ...o,
});

describe('the finish line, as the server’s', () => {
  test('the connection read states it: 70 % until set, then the set line', async () => {
    const mock = await start();
    const c = await connect(mock);
    expect(await c.gateway.check()).toMatchObject({ rule: { finishThresholdPercent: 70 } });
    mock.setFinishThreshold(50);
    expect(await c.gateway.check()).toMatchObject({ rule: { finishThresholdPercent: 50 } });
    expect(() => {
      mock.setFinishThreshold(60 as 50);
    }).toThrow(RangeError);
  });

  test('a viewing counts once the story seconds played reach the line over the story', async () => {
    const mock = await start();
    const c = await connect(mock);
    // 70 % of an 8400 s story is 5880 s, whatever the furthest position says.
    expect(await c.gateway.send(newKey(), watched(5879))).toMatchObject({ scrobbleId: null });
    expect(await c.gateway.send(newKey(), watched(5880))).toMatchObject({ state: 'received' });
    mock.setFinishThreshold(50);
    expect(await c.gateway.send(newKey(), watched(4200))).toMatchObject({ state: 'received' });
    expect(mock.plays).toHaveLength(2);
  });

  test('`ended: true` counts whatever was played', async () => {
    const mock = await start();
    const c = await connect(mock);
    expect(await c.gateway.send(newKey(), watched(10, { ended: true }))).toMatchObject({
      state: 'received',
    });
  });

  test.each<[string, Readonly<Record<string, unknown>>]>([
    ['a story longer than the title', { story_seconds: 9400 }],
    ['a story without the seconds played', { played_seconds: undefined }],
    ['more played than the story', { played_seconds: 8401 }],
    [
      'more played than the title, without a story',
      { story_seconds: undefined, played_seconds: 9361 },
    ],
  ])('%s is a 422', async (_name, change) => {
    const mock = await start();
    const c = await connect(mock);
    const body = JSON.parse(JSON.stringify({ ...watched(8000), ...change })) as PlayBody;
    expect(await c.gateway.send(newKey(), body)).toEqual({
      kind: 'rejected',
      status: 422,
      code: 'validation.failed',
    });
  });
});

// ── the connection read (`GET /v1/integrations/connection`) ──────────────────────────────────

/** The read as a raw request, so a test sees the status, the headers and the body. */
async function readConnection(mock: MockApi, c: Connected): Promise<Response> {
  const signer = dpopSigner({
    pair: c.pair,
    jwk: c.jwk,
    accessToken: c.accessToken,
    nonces: c.nonces,
    now: () => Date.now(),
    jti: newKey,
  });
  const url = `${mock.url}/v1/integrations/connection`;
  return fetch(url, { headers: await signer.headers('GET', url) });
}

/** Python's `datetime.isoformat()` for a UTC instant, as the backend writes `created_at`. */
const pythonIso = (at: number): string => iso(at).replace(/\.000Z$/, '+00:00');

describe('the connection read, as the server’s', () => {
  test('a live connection answers its status, its sign-in and the end of its credential', async () => {
    const mock = await start();
    const c = await connect(mock);
    const response = await readConnection(mock, c);
    expect(response.status).toBe(200);
    // Backend test: seven fields, no more; `no-store`; the verified proof earns a nonce.
    expect(await response.json()).toEqual({
      status: 'active',
      created_at: pythonIso(T0),
      // An extension's credential slides 90 days from its sign-in (`EXTENSION_SLIDING_LIFETIME`).
      expires_at: pythonIso(T0 + 90 * DAY),
      // The account's two lines: starts off until set and the server's floor; the finish at 70 %.
      start_threshold_percent: null,
      start_floor_seconds: 300,
      finish_threshold_percent: 70,
      // The account it acts for: `a1:` and 32 lowercase hexadecimal digits.
      account_key: accountKeyOf('account-a'),
    });
    expect(accountKeyOf('account-a')).toMatch(/^a1:[0-9a-f]{32}$/u);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('DPoP-Nonce')).not.toBeNull();
  });

  test('reading it slides nothing, however often and however late', async () => {
    const mock = await start();
    const c = await connect(mock);
    // Through the extension's own gateway, which signs the nonce a late read is asked for.
    const endOf = async (): Promise<number | null> => {
      const result = await c.gateway.check();
      return result.kind === 'ok' ? result.expiresAt : null;
    };
    const signIn = T0 + 90 * DAY;

    mock.advance(2 * MINUTE);
    expect(await endOf()).toBe(signIn);
    mock.advance(2 * 60 * MINUTE);
    expect(await endOf()).toBe(signIn);
    expect(await endOf()).toBe(signIn);
  });

  test('a stored play slides it at most once every ten minutes', async () => {
    const mock = await start();
    const c = await connect(mock);
    mock.advance(60 * MINUTE);
    expect((await c.gateway.send(newKey(), film(T0))).kind).toBe('accepted');
    const slid = T0 + 60 * MINUTE + 90 * DAY;
    expect(await c.gateway.check()).toMatchObject({ expiresAt: slid });
    // Five minutes on, another stored play: inside the interval, so the end stays.
    mock.advance(5 * MINUTE);
    expect((await c.gateway.send(newKey(), film(T0 + 30 * MINUTE))).kind).toBe('accepted');
    expect(await c.gateway.check()).toMatchObject({ expiresAt: slid });
    mock.advance(6 * MINUTE);
    expect((await c.gateway.send(newKey(), film(T0 + 40 * MINUTE))).kind).toBe('accepted');
    expect(await c.gateway.check()).toMatchObject({ expiresAt: slid + 11 * MINUTE });
  });

  test('a stored play moves the end to its arrival + 90 days', async () => {
    const mock = await start();
    const c = await connect(mock);
    mock.advance(2 * 60 * MINUTE);
    const sent = await c.gateway.send(newKey(), film(T0 + 2 * 60 * MINUTE - 3 * MINUTE));
    expect(sent.kind).toBe('accepted');
    const response = await readConnection(mock, c);
    expect(((await response.json()) as { expires_at: string }).expires_at).toBe(
      pythonIso(T0 + 2 * 60 * MINUTE + 90 * DAY),
    );
    // `created_at` is the sign-in and never moves.
    expect(
      ((await (await readConnection(mock, c)).json()) as { created_at: string }).created_at,
    ).toBe(pythonIso(T0));
  });

  test('the end is never past a year after the sign-in', async () => {
    const mock = await start();
    const c = await connect(mock);
    // Plays 85 days apart keep sliding the credential: 90 days after the last one, until the
    // year after sign-in caps it (`EXTENSION_ABSOLUTE_LIFETIME`).
    for (let day = 85; day <= 340; day += 85) {
      mock.advance(85 * DAY);
      const sent = await c.gateway.send(newKey(), film(T0 + day * DAY - 3 * MINUTE));
      expect(sent.kind).toBe('accepted');
    }
    // 340 days in: 340 + 90 would be 430, the year caps it at 365.
    expect(await c.gateway.check()).toEqual({
      kind: 'ok',
      accountKey: accountKeyOf('account-a'),
      status: 'active',
      expiresAt: T0 + 365 * DAY,
      rule: DEFAULT_RULE,
    });
  });

  test('the key names the account: one per account, the same across its connections', async () => {
    const mock = await start();
    const keyOf = async () =>
      ((await (await readConnection(mock, await connect(mock))).json()) as { account_key: string })
        .account_key;
    const a = await keyOf();
    expect(await keyOf()).toBe(a);
    mock.signInAs('account-b');
    const b = await keyOf();
    expect(b).not.toBe(a);
    expect(b).toBe(accountKeyOf('account-b'));
    // A play is recorded for the account its connection acts for.
    const c = await connect(mock);
    expect((await c.gateway.send(newKey(), film(T0))).kind).toBe('accepted');
    expect(mock.plays.at(-1)?.account).toBe('account-b');
  });

  test('braked and suspended are stated; neither is a 401', async () => {
    const mock = await start();
    const c = await connect(mock);
    mock.setStatus('braked');
    expect(((await (await readConnection(mock, c)).json()) as { status: string }).status).toBe(
      'braked',
    );
    mock.setStatus('suspended');
    expect(((await (await readConnection(mock, c)).json()) as { status: string }).status).toBe(
      'suspended',
    );
    mock.setStatus('active');
    expect(((await (await readConnection(mock, c)).json()) as { status: string }).status).toBe(
      'active',
    );
    expect(() => {
      mock.setStatus('revoked' as 'active');
    }).toThrow(RangeError);
  });

  test('a revoked connection is the plays route’s 401 at every route', async () => {
    const mock = await start();
    const c = await connect(mock);
    const sent = await c.gateway.send(newKey(), film());
    const id = sent.kind === 'accepted' ? (sent.scrobbleId ?? '') : '';
    expect(mock.connections()).toHaveLength(1);
    expect(mock.revoke()).toBe(1);
    expect(mock.connections()).toEqual([]);

    const response = await readConnection(mock, c);
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer, DPoP algs="ES256"');
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scrobbling.credential_invalid');
    // The same refusal the plays route and the receipt read give.
    expect(await c.gateway.send(newKey(), film())).toEqual({ kind: 'credential_invalid' });
    expect(await c.gateway.receipt(id)).toEqual({ kind: 'credential_invalid' });
    expect(await c.gateway.check()).toEqual({ kind: 'credential_invalid' });
  });

  test('revoke names a connection, and only that one', async () => {
    const mock = await start();
    const mine = await connect(mock);
    const theirs = await connect(mock);
    const [first, second] = mock.connections();
    expect(first).toMatch(MT_ID);
    expect(() => mock.revoke('0'.repeat(26))).toThrow(RangeError);
    expect(mock.revoke(first)).toBe(1);
    expect(mock.connections()).toEqual([second]);
    expect((await readConnection(mock, mine)).status).toBe(401);
    expect((await readConnection(mock, theirs)).status).toBe(200);
  });

  test('a braked connection holds its plays; a suspended one answers and keeps none', async () => {
    const mock = await start();
    const c = await connect(mock);
    mock.setStatus('braked');
    expect(await c.gateway.send(newKey(), film())).toMatchObject({
      kind: 'accepted',
      state: 'held',
      reason: 'braked',
    });
    mock.setStatus('suspended');
    expect(await c.gateway.send(newKey(), film())).toEqual({
      kind: 'accepted',
      scrobbleId: null,
      state: 'dismissed',
      reason: 'account_deletion',
    });
    expect(mock.plays).toHaveLength(1);
  });

  test('its budget is 30 a minute: the 31st read is a 429, the window slides', async () => {
    const mock = await start();
    const c = await connect(mock);
    for (let i = 0; i < 30; i++) expect((await readConnection(mock, c)).status).toBe(200);
    const over = await readConnection(mock, c);
    expect(over.status).toBe(429);
    const body = (await over.json()) as {
      error: { code: string; retry_after_seconds: number; details: { bucket_capacity: number } };
    };
    expect(body.error.code).toBe('rate_limit.exceeded');
    expect(body.error.details.bucket_capacity).toBe(30);
    expect(body.error.retry_after_seconds).toBeGreaterThanOrEqual(1);
    // Its own bucket: the receipt and plays budgets are untouched.
    expect(await c.gateway.send(newKey(), film())).toMatchObject({ kind: 'accepted' });
    mock.advance(MINUTE);
    expect((await readConnection(mock, c)).status).toBe(200);
  });

  test('a credential presented as a bearer, or none, is the 401; a write is 405', async () => {
    const mock = await start();
    const c = await connect(mock);
    const bearer = await fetch(`${mock.url}/v1/integrations/connection`, {
      headers: { Authorization: `Bearer ${c.accessToken}` },
    });
    expect(bearer.status).toBe(401);
    const none = await fetch(`${mock.url}/v1/integrations/connection`);
    expect(none.status).toBe(401);
    const post = await fetch(`${mock.url}/v1/integrations/connection`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newKey() },
    });
    expect(post.status).toBe(405);
  });

  test('forced answers are consumed in order, one per read, then the mock judges', async () => {
    const mock = await start({
      script: {
        connection: [
          'unavailable',
          { fault: 'rate_limited', retryAfterSeconds: 7 },
          'credential_invalid',
          { fault: 'raw', status: 418, body: { teapot: true } },
          'internal_error',
          'feature_closed',
        ],
      },
    });
    const c = await connect(mock);
    const kinds = [];
    for (let i = 0; i < 7; i++) kinds.push(await c.gateway.check());
    expect(kinds).toEqual([
      { kind: 'unavailable', detail: 'http_503' },
      { kind: 'unavailable', detail: 'http_429' },
      { kind: 'credential_invalid' },
      { kind: 'unavailable', detail: 'http_418' },
      { kind: 'unavailable', detail: 'http_500' },
      { kind: 'unavailable', detail: 'http_404' },
      {
        kind: 'ok',
        accountKey: accountKeyOf('account-a'),
        status: 'active',
        expiresAt: T0 + 90 * DAY,
        rule: DEFAULT_RULE,
      },
    ]);
  });

  test('a forced credential_invalid revokes nothing; drop and nonce_required are as the receipt’s', async () => {
    const mock = await start();
    const c = await connect(mock);
    mock.force({ connection: ['drop', 'nonce_required'] });
    expect(await c.gateway.check()).toEqual({ kind: 'unavailable', detail: 'network:TypeError' });
    // The nonce the refusal hands over is signed into the retry, which the mock then judges.
    expect(await c.gateway.check()).toEqual({
      kind: 'ok',
      accountKey: accountKeyOf('account-a'),
      status: 'active',
      expiresAt: T0 + 90 * DAY,
      rule: DEFAULT_RULE,
    });
    expect(mock.connections()).toHaveLength(1);
  });

  test('a script naming an unknown connection answer is refused when it is given', async () => {
    await expect(
      startMockApi({ port: 0, script: { connection: ['not_found' as 'drop'] } }),
    ).rejects.toThrow(TypeError);
  });
});

/** Dune begun: 1020 s into its 9360, as the extension's start body says it. */
const begun = (furthest = 1020): StartBody => ({
  report: 'start',
  kind: 'movie',
  ids: { tmdb: 438631 },
  title: 'Dune',
  year: 2021,
  duration_seconds: 9360,
  furthest_position_seconds: furthest,
});

describe('a film begun (`report: "start"`), as the server’s', () => {
  test('the connection read states the account’s threshold; only 5, 10, 20 or null is one', async () => {
    const mock = await start();
    const c = await connect(mock);
    mock.setStartThreshold(10);
    const body = (await (await readConnection(mock, c)).json()) as Record<string, unknown>;
    expect([body.start_threshold_percent, body.start_floor_seconds]).toEqual([10, 300]);
    expect(await c.gateway.check()).toMatchObject({
      rule: { startThresholdPercent: 10, startFloorSeconds: 300 },
    });
    expect(() => {
      mock.setStartThreshold(7 as 5);
    }).toThrow(RangeError);
  });

  test('starts off (the default): answered ignored(not_completed), not kept', async () => {
    const mock = await start();
    const c = await connect(mock);
    expect(await c.gateway.send(newKey(), begun())).toEqual({
      kind: 'accepted',
      scrobbleId: null,
      state: 'ignored',
      reason: 'not_completed',
    });
    expect(mock.plays).toEqual([]);
  });

  test('at 10 %: short of the line is not kept; at it, kept and then started', async () => {
    const mock = await start();
    const c = await connect(mock);
    mock.setStartThreshold(10);
    // 10 % of 9360 s is 936 s, past the 300 s floor.
    expect(await c.gateway.send(newKey(), begun(935))).toMatchObject({
      scrobbleId: null,
      state: 'ignored',
      reason: 'not_completed',
    });
    const sent = await c.gateway.send(newKey(), begun(936));
    expect(sent).toMatchObject({ kind: 'accepted', state: 'received', reason: null });
    expect(mock.plays).toHaveLength(1);
    const id = sent.kind === 'accepted' ? (sent.scrobbleId ?? '') : '';
    mock.advance(5 * SECOND);
    const read = await c.gateway.receipt(id);
    expect(read).toMatchObject({ kind: 'ok', state: 'started', reason: null });
    expect(read.kind === 'ok' ? read.titleId : null).toMatch(MT_ID);
  });

  test('the floor binds a short share: 5 % of a 90-minute film is 270 s, the line is 300', async () => {
    const mock = await start();
    const c = await connect(mock);
    mock.setStartThreshold(5);
    const short = { ...begun(299), duration_seconds: 5400 };
    expect(await c.gateway.send(newKey(), short)).toMatchObject({ scrobbleId: null });
    expect(
      await c.gateway.send(newKey(), { ...short, furthest_position_seconds: 300 }),
    ).toMatchObject({ state: 'received' });
  });

  test('a film already recorded: the start reads ignored(status_stands), naming the film', async () => {
    const mock = await start();
    const c = await connect(mock);
    mock.setStartThreshold(10);
    expect((await c.gateway.send(newKey(), film())).kind).toBe('accepted');
    const sent = await c.gateway.send(newKey(), begun());
    const id = sent.kind === 'accepted' ? (sent.scrobbleId ?? '') : '';
    mock.advance(5 * SECOND);
    const read = await c.gateway.receipt(id);
    expect(read).toMatchObject({ state: 'ignored', reason: 'status_stands' });
    expect(read.kind === 'ok' ? read.titleId : null).toMatch(MT_ID);
  });

  test.each<[string, Readonly<Record<string, unknown>>]>([
    ['an episode', { kind: 'episode', show: { title: 'Dune' }, season_number: 1 }],
    ['no duration', { duration_seconds: undefined }],
    ['no furthest position', { furthest_position_seconds: undefined }],
    ['ended: true', { ended: true }],
  ])('a start with %s is a 422, whatever the threshold', async (_name, change) => {
    const mock = await start();
    const c = await connect(mock);
    mock.setStartThreshold(10);
    const body = JSON.parse(JSON.stringify({ ...begun(), ...change })) as PlayBody;
    expect(await c.gateway.send(newKey(), body)).toEqual({
      kind: 'rejected',
      status: 422,
      code: 'validation.failed',
    });
    expect(mock.plays).toEqual([]);
  });
});

// The two lines are shares of one base against one measure: the base is the story when it is
// sent, else the running time; the measure is the seconds played when sent, else the furthest
// position. Both lines round the share up to a whole second.
describe('the account’s two lines over the story and the seconds played', () => {
  const REFUSED = { kind: 'rejected', status: 422, code: 'validation.failed' } as const;
  const NOT_COUNTED = {
    kind: 'accepted',
    scrobbleId: null,
    state: 'ignored',
    reason: 'not_completed',
  } as const;
  const send = (c: Connected, body: unknown, key = newKey()) =>
    c.gateway.send(key, body as PlayBody);

  describe('a start', () => {
    test('is judged over the story: the line is max(ceil(10 % of the story), 300)', async () => {
      const mock = await start();
      const c = await connect(mock);
      mock.setStartThreshold(10);
      // Story 8400 s: the line is 840 s, not the 936 s the running time would give.
      const body = (played: number) => ({
        ...begun(100),
        story_seconds: 8400,
        played_seconds: played,
      });
      expect(await send(c, body(839))).toEqual(NOT_COUNTED);
      expect(await send(c, body(840))).toMatchObject({ state: 'received', reason: null });
      expect(mock.plays).toHaveLength(1);
    });

    test('is measured by the seconds played, never by the furthest position', async () => {
      const mock = await start();
      const c = await connect(mock);
      mock.setStartThreshold(10);
      // A skip to 9000 s with 100 s played has not begun the film.
      expect(await send(c, { ...begun(9000), story_seconds: 8400, played_seconds: 100 })).toEqual(
        NOT_COUNTED,
      );
      expect(mock.plays).toEqual([]);
    });

    test('with no story, the base is the running time and the measure still the seconds played', async () => {
      const mock = await start();
      const c = await connect(mock);
      mock.setStartThreshold(10);
      // 10 % of 9360 s is 936 s.
      expect(await send(c, { ...begun(9000), played_seconds: 935 })).toEqual(NOT_COUNTED);
      expect(await send(c, { ...begun(1000), played_seconds: 936 })).toMatchObject({
        state: 'received',
      });
    });

    test('the share rounds up to a whole second', async () => {
      const mock = await start();
      const c = await connect(mock);
      mock.setStartThreshold(20);
      // 20 % of a 1,001 s story is 200.2 s: the line is 201 s, or the floor of 300 if larger. A
      // 3,001 s story gives 600.2 s: the line is 601 s.
      const body = (played: number) => ({
        ...begun(100),
        duration_seconds: 3600,
        story_seconds: 3001,
        played_seconds: played,
      });
      expect(await send(c, body(600))).toEqual(NOT_COUNTED);
      expect(await send(c, body(601))).toMatchObject({ state: 'received' });
    });

    test('is a start whatever its numbers: a film played to its finish line is still only begun', async () => {
      const mock = await start();
      const c = await connect(mock);
      mock.setStartThreshold(10);
      const sent = await send(c, { ...begun(9000), story_seconds: 9000, played_seconds: 8900 });
      const id = sent.kind === 'accepted' ? (sent.scrobbleId ?? '') : '';
      mock.advance(5 * SECOND);
      expect(await c.gateway.receipt(id)).toMatchObject({ kind: 'ok', state: 'started' });
    });

    test.each<[string, Readonly<Record<string, unknown>>]>([
      ['a story without the seconds played', { story_seconds: 8400 }],
      ['a story longer than the title', { story_seconds: 9361, played_seconds: 1000 }],
      ['more played than the story', { story_seconds: 8400, played_seconds: 8401 }],
      ['more played than the title, with no story', { played_seconds: 9361 }],
    ])('%s is a 422', async (_name, change) => {
      const mock = await start();
      const c = await connect(mock);
      mock.setStartThreshold(10);
      const body = JSON.parse(JSON.stringify({ ...begun(1000), ...change })) as unknown;
      expect(await send(c, body)).toEqual(REFUSED);
      expect(mock.plays).toEqual([]);
    });

    test('a second start for a film already in progress is answered status_stands', async () => {
      const mock = await start();
      const c = await connect(mock);
      mock.setStartThreshold(10);
      const first = await send(c, begun(1000));
      expect(first).toMatchObject({ state: 'received' });
      const second = await send(c, begun(2000));
      const id = second.kind === 'accepted' ? (second.scrobbleId ?? '') : '';
      mock.advance(5 * SECOND);
      expect(await c.gateway.receipt(id)).toMatchObject({
        kind: 'ok',
        state: 'ignored',
        reason: 'status_stands',
      });
    });

    test('another film’s start is not held back by the first', async () => {
      const mock = await start();
      const c = await connect(mock);
      mock.setStartThreshold(10);
      await send(c, begun(1000));
      const other = await send(c, {
        ...begun(1000),
        ids: { tmdb: 693134 },
        title: 'Dune: Part Two',
        year: 2024,
      });
      const id = other.kind === 'accepted' ? (other.scrobbleId ?? '') : '';
      mock.advance(5 * SECOND);
      expect(await c.gateway.receipt(id)).toMatchObject({ kind: 'ok', state: 'started' });
    });
  });

  describe('a viewing', () => {
    test('with no number at all is a mark made by hand, and counts', async () => {
      const mock = await start();
      const c = await connect(mock);
      const sent = await send(c, { kind: 'movie', title: 'Dune', ids: { tmdb: 438631 } });
      expect(sent).toMatchObject({ state: 'received' });
    });

    test('with `ended: false` alone says the title did not play out, and does not count', async () => {
      const mock = await start();
      const c = await connect(mock);
      const sent = await send(c, {
        kind: 'movie',
        title: 'Dune',
        ids: { tmdb: 438631 },
        ended: false,
      });
      expect(sent).toEqual(NOT_COUNTED);
      expect(mock.plays).toEqual([]);
    });

    test('with `ended: true` alone counts', async () => {
      const mock = await start();
      const c = await connect(mock);
      const sent = await send(c, {
        kind: 'movie',
        title: 'Dune',
        ids: { tmdb: 438631 },
        ended: true,
      });
      expect(sent).toMatchObject({ state: 'received' });
    });

    test('the finish line rounds up: 70 % of a 1,001 s story is 701 s', async () => {
      const mock = await start();
      const c = await connect(mock);
      mock.setFinishThreshold(70);
      const body = (played: number) => ({
        ...film(),
        ended: false,
        duration_seconds: 1200,
        furthest_position_seconds: 1200,
        story_seconds: 1001,
        played_seconds: played,
      });
      expect(await send(c, body(700))).toEqual(NOT_COUNTED);
      expect(await send(c, body(701))).toMatchObject({ state: 'received' });
    });

    test('with no story, the base is the running time and the measure the seconds played', async () => {
      const mock = await start();
      const c = await connect(mock);
      mock.setFinishThreshold(50);
      // 50 % of 9360 s is 4680 s; the furthest position at the end does not count.
      const body = (played: number) => ({
        ...film(),
        ended: false,
        furthest_position_seconds: 9360,
        played_seconds: played,
      });
      expect(await send(c, body(4679))).toEqual(NOT_COUNTED);
      expect(await send(c, body(4680))).toMatchObject({ state: 'received' });
    });

    test('with no seconds played, the measure is the furthest position', async () => {
      const mock = await start();
      const c = await connect(mock);
      mock.setFinishThreshold(70);
      // 70 % of 9360 s is 6552 s.
      const body = (furthest: number) => ({
        ...film(),
        ended: false,
        furthest_position_seconds: furthest,
      });
      expect(await send(c, body(6551))).toEqual(NOT_COUNTED);
      expect(await send(c, body(6552))).toMatchObject({ state: 'received' });
    });

    test('is a viewing when `report` says so, and nothing else is a report', async () => {
      const mock = await start();
      const c = await connect(mock);
      expect(await send(c, { ...film(), report: 'viewing' })).toMatchObject({ state: 'received' });
      expect(await send(c, { ...film(), report: 'finish' })).toEqual(REFUSED);
    });

    test('a viewing short of the line is answered at the door: nothing is stored, and the answer stands', async () => {
      const mock = await start();
      const c = await connect(mock);
      const key = newKey();
      const short = watched(100);
      expect(await send(c, short, key)).toEqual(NOT_COUNTED);
      // The account moves its line afterwards; the same play under the same key is answered as
      // it was the first time.
      mock.setFinishThreshold(50);
      expect(await send(c, short, key)).toEqual(NOT_COUNTED);
      expect(mock.plays).toEqual([]);
    });
  });

  test('the connection read always states the finish line, one of 50, 70 or 90', async () => {
    const mock = await start();
    const c = await connect(mock);
    for (const percent of [50, 70, 90] as const) {
      mock.setFinishThreshold(percent);
      const body = (await (await readConnection(mock, c)).json()) as Record<string, unknown>;
      expect(body.finish_threshold_percent).toBe(percent);
    }
  });
});
