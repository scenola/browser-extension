/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The account's lines through observation ingest and the outbox, from the rules in words: one
// start per viewing, never after the viewing's own play and never when that play is queued by the
// same observation; a viewing short of the finish line stays open and can still start; a worker
// that stops between the writes queues the same start again, never a second; and an answer that
// says the lines did not count settles the entry and asks for the rule again.
//
// A 1000 s film has a story of 880 s (its credits are estimated at 12 % of the length). At 10 %
// with a one-minute floor a start is due at 88 s played; at the never-read 70 % finish line a play
// is due at 616 s. The tab binds at 15 s, so playing in 15 s steps from 0 has 90 s of the story
// played at the 105 s sample, and 630 s at the 645 s one.

import { describe, expect, test, vi } from 'vitest';

import { isStart } from '../domain/play';
import type { ServiceReading } from '../domain/reading';
import { receiptView, sentPlayView } from '../domain/receipts';
import { DAY_MS } from '../domain/time';
import { episodeReading, filmReading, makeWorld, must, observe, watch } from './test-world';
import type { World } from './test-world';

const START_10_60 = { startThresholdPercent: 10, startFloorSeconds: 60 };

const starts = async (w: World) => (await w.outbox.list()).filter((e) => isStart(e.body));
const plays = async (w: World) => (await w.outbox.list()).filter((e) => !isStart(e.body));

describe('one start per viewing', () => {
  test('watching on after the start queues no second one', async () => {
    const w = makeWorld({ rule: START_10_60 });
    const film = filmReading('Arrival', 2016);
    const results = await watch(w, film, 0, 600);
    expect(results.filter((r) => r.started === true)).toHaveLength(1);
    expect(await starts(w)).toHaveLength(1);
    expect(await plays(w)).toHaveLength(0);
  });

  test('a later sitting of the same viewing queues none either', async () => {
    const w = makeWorld({ rule: START_10_60 });
    const film = filmReading('Arrival', 2016);
    await watch(w, film, 0, 150);
    w.clock.advance(3_600_000);
    await watch(w, film, 150, 300);
    expect(await starts(w)).toHaveLength(1);
  });

  test('the start’s time is recorded the moment it is queued', async () => {
    const w = makeWorld({ rule: START_10_60 });
    await watch(w, filmReading('Arrival', 2016), 0, 150);
    const viewing = must(w.viewings.all()[0]);
    const [entry] = await starts(w);
    expect(viewing.startSentAt).toBe(entry?.createdAt);
    expect(viewing.startPlayId).toBe(entry?.playId);
  });

  test('the viewing’s own play goes after it, as its own entry under its own key', async () => {
    const w = makeWorld({ rule: START_10_60 });
    await watch(w, filmReading('Arrival', 2016), 0, 900);
    const [start] = await starts(w);
    const [play] = await plays(w);
    expect(start).toBeDefined();
    expect(play).toBeDefined();
    expect(start?.playId).not.toBe(play?.playId);
    expect(play?.body).toHaveProperty('watched_at');
    expect(play?.body).toHaveProperty('ended', false);
    expect(start?.body).not.toHaveProperty('watched_at');
    expect(start?.body).not.toHaveProperty('ended');
  });

  test('an observation that crosses both lines sends the play alone', async () => {
    // A stream that states no length until 705 s: until then there is no story and no line. The
    // length makes the story 880 s, of which 690 s were played: past the start line and the
    // finish line at once.
    const w = makeWorld({ rule: START_10_60 });
    const film = filmReading('Arrival', 2016);
    const unknown = { serviceId: 'svc', sample: { duration: null } };
    await watch(w, film, 0, 690, unknown);
    expect(await w.outbox.list()).toEqual([]);
    const known = { ...film, contentDurationSeconds: 1000 };
    const crossed = await observe(w, known, 705, { serviceId: 'svc' });
    expect(crossed).toMatchObject({ reported: true });
    expect(crossed.started).toBeUndefined();
    expect(await starts(w)).toHaveLength(0);
    expect(await plays(w)).toHaveLength(1);
    // Played on, the reported viewing starts nothing either.
    await watch(w, known, 720, 900, { serviceId: 'svc' });
    expect(await w.outbox.list()).toHaveLength(1);
  });

  test('a viewing skipped does not start, nor does it after the line is passed', async () => {
    const w = makeWorld({ rule: START_10_60 });
    const film = filmReading('Arrival', 2016);
    await watch(w, film, 0, 45);
    await w.skip.execute(must(w.viewings.all()[0]).id);
    await watch(w, film, 60, 400);
    expect(await w.outbox.list()).toEqual([]);
  });

  test('a viewing whose play is already queued sends no start', async () => {
    // A floor above the story keeps the start line out of reach; the play goes at the finish line.
    const w = makeWorld({ rule: { startThresholdPercent: 10, startFloorSeconds: 900 } });
    const film = filmReading('Arrival', 2016);
    await watch(w, film, 0, 900);
    expect(await plays(w)).toHaveLength(1);
    expect(await starts(w)).toHaveLength(0);
    // Watching the closed viewing on queues nothing more.
    await watch(w, film, 900, 960);
    expect(await w.outbox.list()).toHaveLength(1);
  });

  test('an episode starts nothing, at any progress', async () => {
    const w = makeWorld({ rule: { startThresholdPercent: 1, startFloorSeconds: 0 } });
    await watch(w, episodeReading(1), 0, 600);
    expect(await starts(w)).toEqual([]);
  });

  test('a length that is not known starts nothing', async () => {
    const w = makeWorld({ rule: { startThresholdPercent: 1, startFloorSeconds: 0 } });
    await watch(w, filmReading('Arrival', 2016), 0, 600, { sample: { duration: null } });
    expect(await starts(w)).toEqual([]);
  });

  test('starts off: nothing, however far the film is played', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Arrival', 2016), 0, 800);
    expect(await starts(w)).toEqual([]);
  });
});

describe('a viewing short of the finish line at its credits stays open and can still start', () => {
  test('half the story, a skip to the credits: no play; played on to the start line: a start', async () => {
    const w = makeWorld({ rule: { startThresholdPercent: 60, startFloorSeconds: 0 } });
    const film = filmReading('Arrival', 2016);
    // 60 % of 880 s is 528 s. Play 15 s to 435 s (420 s of the story played)...
    await watch(w, film, 0, 435);
    // ...skip to the credits: nothing skipped is played, so 420 s is short of both lines.
    await watch(w, film, 880, 900);
    expect(await w.outbox.list()).toEqual([]);
    expect(must(w.viewings.all()[0]).state).toBe('open');
    // Play more of the middle: the start comes once 528 s have been played, the play never.
    await observe(w, film, 435);
    await watch(w, film, 450, 600);
    expect(await starts(w)).toHaveLength(1);
    expect(await plays(w)).toHaveLength(0);
    expect(must(w.viewings.all()[0]).state).toBe('open');
  });
});

describe('a worker that stops between the writes', () => {
  async function started(w: World) {
    const film = filmReading('Arrival', 2016);
    await watch(w, film, 0, 150);
    return film;
  }

  test('after the entry and before the viewing’s time is recorded: the same start, not a second', async () => {
    const w = makeWorld({ rule: START_10_60 });
    const film = await started(w);
    const [first] = await starts(w);
    const viewing = must(w.viewings.all()[0]);
    await w.viewings.put({ ...viewing, startSentAt: null });
    await observe(w, film, 165);
    const after = await starts(w);
    expect(after).toHaveLength(1);
    expect(after[0]?.playId).toBe(first?.playId);
    expect(must(w.viewings.all()[0]).startSentAt).not.toBeNull();
  });

  test('after the start was delivered: nothing is queued again', async () => {
    const w = makeWorld({ rule: START_10_60 });
    const film = await started(w);
    await w.drain.execute();
    expect(w.gateway.sends).toHaveLength(1);
    const viewing = must(w.viewings.all()[0]);
    await w.viewings.put({ ...viewing, startSentAt: null });
    await observe(w, film, 165);
    expect(await w.outbox.list()).toEqual([]);
    expect(must(w.viewings.all()[0]).startSentAt).not.toBeNull();
  });

  test('after the id was reserved and before the entry: the entry is under the reserved id', async () => {
    const w = makeWorld({ rule: START_10_60 });
    const film = filmReading('Arrival', 2016);
    await watch(w, film, 0, 60);
    const viewing = must(w.viewings.all()[0]);
    await w.viewings.put({ ...viewing, startPlayId: 'reserved-start-id' });
    await watch(w, film, 75, 150);
    const [entry] = await starts(w);
    expect(await starts(w)).toHaveLength(1);
    expect(entry?.playId).toBe('reserved-start-id');
  });
});

describe('the rule is read only when one of its lines may apply', () => {
  test('a viewing whose length is unknown never reads it: there is no story to draw a line on', async () => {
    const w = makeWorld({ rule: START_10_60 });
    await watch(w, episodeReading(1), 0, 600, { sample: { duration: null } });
    expect(w.rules.reads).toBe(0);
  });

  test('an episode in progress reads it on every observation, since its finish line may fall there', async () => {
    const w = makeWorld({ rule: START_10_60 });
    const episode = episodeReading(1);
    await watch(w, episode, 0, 45);
    const reads = w.rules.reads;
    expect(reads).toBeGreaterThan(0);
    await observe(w, episode, 60);
    expect(w.rules.reads).toBe(reads + 1);
  });

  test('a viewing whose play was queued reads it no more', async () => {
    const w = makeWorld({ rule: START_10_60 });
    const film = filmReading('Arrival', 2016);
    await watch(w, film, 0, 645);
    expect(await plays(w)).toHaveLength(1);
    const reads = w.rules.reads;
    await watch(w, film, 660, 900);
    expect(w.rules.reads).toBe(reads);
  });

  test('a film that has not begun reads it on every observation, to know its line', async () => {
    const w = makeWorld({ rule: START_10_60 });
    const film = filmReading('Arrival', 2016);
    await watch(w, film, 0, 45);
    const reads = w.rules.reads;
    await observe(w, film, 60);
    expect(w.rules.reads).toBe(reads + 1);
  });

  test('a line changed between two observations is the one in force at the second', async () => {
    const w = makeWorld({ rule: START_10_60 });
    const film = filmReading('Arrival', 2016);
    await watch(w, film, 0, 60);
    w.rules.value = { ...w.rules.value, startThresholdPercent: null };
    await watch(w, film, 75, 400);
    expect(await starts(w)).toEqual([]);
    w.rules.value = { ...w.rules.value, startThresholdPercent: 10 };
    await observe(w, film, 415);
    expect(await starts(w)).toHaveLength(1);
  });
});

describe('a film whose start is not due reads its viewing once per observation', () => {
  test.each([
    ['starts off', {}],
    ['short of the start line', { startThresholdPercent: 90 }],
  ])('%s', async (_, rule) => {
    const w = makeWorld({ rule });
    const film = filmReading('Arrival', 2016);
    await watch(w, film, 0, 45);
    const byId = vi.spyOn(w.viewings, 'byId');
    await watch(w, film, 60, 195);
    expect(byId).toHaveBeenCalledTimes(10);
    expect(await w.outbox.list()).toEqual([]);
  });
});

describe('where the viewing’s play could not go, no start goes', () => {
  test('an incognito viewing, once the setting is off, starts nothing', async () => {
    const w = makeWorld({ rule: START_10_60, settings: { trackIncognito: true } });
    const film = filmReading('Arrival', 2016);
    await watch(w, film, 0, 45, { incognito: true });
    await w.settings.patch({ trackIncognito: false });
    // The same title continues in a normal window: the viewing remembers it was incognito.
    await watch(w, film, 60, 300);
    expect(w.viewings.all()).toHaveLength(1);
    expect(must(w.viewings.all()[0]).incognito).toBe(true);
    expect(await w.outbox.list()).toEqual([]);
  });

  test('an incognito viewing with the setting on starts like any other', async () => {
    const w = makeWorld({ rule: START_10_60, settings: { trackIncognito: true } });
    await watch(w, filmReading('Arrival', 2016), 0, 150, { incognito: true });
    expect(await starts(w)).toHaveLength(1);
  });

  test('a film the play builder refuses starts nothing', async () => {
    // A service names the title only by an id the wire would not carry: no title, no usable id.
    const w = makeWorld({ rule: START_10_60 });
    const reading: ServiceReading = {
      kind: { value: 'movie', confidence: 1, source: 'module' },
      providerIds: [{ level: 'title', key: '9bad key', value: 'abc' }],
    };
    await watch(w, reading, 0, 300, { serviceId: 'svc' });
    // It is a viewing (the service names it), played well past the line, and still sends nothing.
    expect(w.viewings.all()).toHaveLength(1);
    expect(await w.outbox.list()).toEqual([]);
  });
});

describe('the start’s outbox entry', () => {
  test('is counted from the moment it was queued: given up 29 days after, not before', async () => {
    const w = makeWorld({ rule: START_10_60 });
    await watch(w, filmReading('Arrival', 2016), 0, 150);
    const [entry] = await starts(w);
    const queued = must(entry).createdAt;
    expect(must(entry).watchedAt).toBe(queued);
    w.clock.set(queued + 29 * DAY_MS);
    await w.drain.execute();
    expect(w.gateway.sends).toHaveLength(1);
  });

  test('past the 29 days it is given up without a request', async () => {
    const w = makeWorld({ rule: START_10_60 });
    await watch(w, filmReading('Arrival', 2016), 0, 150);
    const [entry] = await starts(w);
    w.clock.set(must(entry).createdAt + 29 * DAY_MS + 1);
    await w.drain.execute();
    expect(w.gateway.sends).toEqual([]);
    expect((await w.outbox.list())[0]).toMatchObject({ state: 'dead', lastError: 'too_old' });
  });
});

describe('the answer “the account’s lines did not count this”', () => {
  const notCompleted = {
    kind: 'accepted' as const,
    scrobbleId: null,
    state: 'ignored' as const,
    reason: 'not_completed',
  };

  async function queue(w: World, count: number) {
    for (let i = 0; i < count; i += 1) {
      const film = filmReading(`Film ${String(i)}`, 2000 + i);
      await watch(w, film, 0, 150);
      // Another film in the same tab: the first stays open with its start queued.
      w.clock.advance(60_000);
    }
  }

  test('a play so answered is settled as not kept, never retried, and the worker is told', async () => {
    const w = makeWorld({ rule: { finishThresholdPercent: 50 } });
    const film = filmReading('Arrival', 2016);
    await watch(w, film, 0, 450);
    await watch(w, film, 870, 900);
    expect(await plays(w)).toHaveLength(1);
    w.gateway.onSend = () => notCompleted;
    await w.drain.execute();
    expect(await w.outbox.list()).toEqual([]);
    expect(w.notCounted.count).toBe(1);
    const [sent] = await w.history.recent(10);
    // A viewing’s `not_completed` keeps its own words, not a start’s.
    expect(sentPlayView(must(sent)).messageKey).toBe('receipt.ignored.not_completed');
    await w.drain.execute();
    expect(w.gateway.sends).toHaveLength(1);
  });

  test('however many such answers a pass meets, the worker is told once', async () => {
    const w = makeWorld({ rule: START_10_60 });
    await queue(w, 3);
    expect((await starts(w)).length).toBeGreaterThanOrEqual(2);
    w.gateway.onSend = () => notCompleted;
    await w.drain.execute();
    expect(w.gateway.sends.length).toBeGreaterThanOrEqual(2);
    expect(w.notCounted.count).toBe(1);
  });

  test('an answer that kept something is not “not counted”, with or without a reason', async () => {
    const w = makeWorld({ rule: START_10_60 });
    await watch(w, filmReading('Arrival', 2016), 0, 150);
    w.gateway.onSend = () => ({
      kind: 'accepted',
      scrobbleId: 's1',
      state: 'ignored',
      reason: 'not_completed',
    });
    await w.drain.execute();
    expect(w.notCounted.count).toBe(0);
  });

  test.each(['status_stands', 'not_placed', 'unknown_id'])(
    'an ignored answer for %s does not ask for the rule again',
    async (reason) => {
      const w = makeWorld({ rule: START_10_60 });
      await watch(w, filmReading('Arrival', 2016), 0, 150);
      w.gateway.onSend = () => ({ kind: 'accepted', scrobbleId: 's1', state: 'ignored', reason });
      await w.drain.execute();
      expect(w.notCounted.count).toBe(0);
    },
  );

  test('a pass that met nothing of the kind does not ask', async () => {
    const w = makeWorld({ rule: START_10_60 });
    await watch(w, filmReading('Arrival', 2016), 0, 150);
    await w.drain.execute();
    expect(w.notCounted.count).toBe(0);
  });
});

describe('how a start’s answer is shown', () => {
  test('started: done, settled, linked to the title', () => {
    expect(receiptView('started', null, true)).toMatchObject({
      tone: 'done',
      link: 'title',
      settled: true,
    });
  });

  test('already in the library: done, settled, linked to the title', () => {
    expect(receiptView('ignored', 'status_stands', true)).toMatchObject({
      tone: 'done',
      link: 'title',
      settled: true,
    });
  });

  test('could not tell which film: settled, neutral, linked nowhere', () => {
    expect(receiptView('ignored', 'not_placed', true)).toMatchObject({
      tone: 'neutral',
      link: null,
      settled: true,
    });
  });

  test('the account’s rule did not take it: neutral, settled, no link, and not an error', () => {
    expect(receiptView('ignored', 'not_completed', true)).toMatchObject({
      tone: 'neutral',
      link: null,
      settled: true,
    });
    expect(receiptView('ignored', 'not_completed', true).messageKey).not.toBe(
      receiptView('ignored', 'not_completed', false).messageKey,
    );
  });

  test('a viewing’s own not_completed keeps its words', () => {
    expect(receiptView('ignored', 'not_completed', false)).toMatchObject({
      messageKey: 'receipt.ignored.not_completed',
      settled: true,
    });
  });
});
