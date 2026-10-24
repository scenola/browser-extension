/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The account's lines, measured over the story by what was played. The expected numbers come from
// the rules in words: the story runs from the intro's end to the credits' start (the credits start
// being, with no marker, `duration − min(12 % of it, 20 min)`), the lines are `ceil(share × story
// / 100)`, a start line is the larger of that and the floor, and a report sends whole seconds
// rounded down. Seeded, so CI runs the same cases.

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { dueStart, readAccountRule, startLine } from './account-rule';
import type { AccountRule } from './account-rule';
import { MAX_SECONDS, buildPlay, buildStart } from './play';
import type { MergedReading } from './reading';
import { newViewing, playedSeconds, reportVerdict, shareLine, storySeconds } from './viewing';
import type { Viewing } from './viewing';

const SEED = 20_261_023;

const FILM: MergedReading = { kind: 'movie', title: 'Arrival', year: 2016, sources: [] };

/** An open film viewing of `duration` seconds that played `ranges`. */
function film(
  duration: number | null,
  ranges: readonly [number, number][],
  over: Partial<Viewing> = {},
): Viewing {
  const v = newViewing({ id: 'v1', serviceId: null, reading: FILM, at: 0, incognito: false });
  if (v === null) throw new Error('the fixture names a film');
  return { ...v, durationSeconds: duration, ranges, engaged: true, ...over };
}

/** An open episode viewing of 1000 s that played most of it. */
function episode(): Viewing {
  const reading: MergedReading = {
    kind: 'episode',
    showTitle: 'Show',
    season: 1,
    episode: 1,
    sources: [],
  };
  const v = newViewing({ id: 'e', serviceId: null, reading, at: 0, incognito: false });
  if (v === null) throw new Error('the fixture names an episode');
  return { ...v, durationSeconds: 1000, ranges: [[0, 800]], engaged: true };
}

const rule = (over: Partial<AccountRule> = {}): AccountRule => ({
  startThresholdPercent: 10,
  startFloorSeconds: 300,
  finishThresholdPercent: 90,
  ...over,
});

/** The story's length as the rule is worded, in whole seconds, for a length in whole hundreds. */
const storyOfRoundDuration = (hundreds: number): number => {
  const duration = hundreds * 100;
  // 12 % of a multiple of 100 is a whole number of seconds: no fractions to round.
  return duration - Math.min(12 * hundreds, 20 * 60);
};

describe('the story, from the credits estimate', () => {
  test.each([
    // 12 % of 1000 s is 120 s.
    [1000, 880],
    // 12 % of 9000 s is 1080 s, under the 20-minute cap.
    [9000, 7920],
    // 12 % of 10 000 s is 1200 s, exactly the cap.
    [10_000, 8800],
    // 12 % of 20 000 s is 2400 s: the cap binds.
    [20_000, 18_800],
    // 12 % of 9960 s is 1195.2 s, so the story ends at 8764.8 s: rounded down.
    [9960, 8764],
    // The length is rounded down too: 1000.9 − 120.108 = 880.792.
    [1000.9, 880],
  ])('a %f s film has a story of %i s', (duration, story) => {
    expect(storySeconds(film(duration, []))).toBe(story);
  });

  test('a length that is not known has no story', () => {
    expect(storySeconds(film(null, []))).toBeNull();
    expect(storySeconds(film(0, []))).toBeNull();
    expect(storySeconds(film(Number.NaN, []))).toBeNull();
  });

  test('a stated credits start in the second half is the story’s end', () => {
    expect(storySeconds(film(1000, [], { creditsStartSeconds: 950 }))).toBe(950);
    expect(storySeconds(film(1000, [], { creditsStartSeconds: 500 }))).toBe(500);
  });

  test('a stated credits start in the first half is no credits start: the estimate stands', () => {
    expect(storySeconds(film(1000, [], { creditsStartSeconds: 499 }))).toBe(880);
  });

  test('a stated intro end shortens the story from the front', () => {
    expect(storySeconds(film(1000, [], { introEndSeconds: 60 }))).toBe(820);
  });

  test('the story is never longer than the running time, and lengths are whole numbers', () => {
    fc.assert(
      fc.property(fc.double({ min: 2, max: MAX_SECONDS, noNaN: true }), (duration) => {
        const story = storySeconds(film(duration, []));
        if (story === null) return;
        expect(Number.isInteger(story)).toBe(true);
        expect(story).toBeGreaterThanOrEqual(1);
        expect(story).toBeLessThanOrEqual(Math.floor(duration));
      }),
      { seed: SEED },
    );
  });

  test('for a length in whole hundreds the story is exactly the length less its credits', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6048 }), (hundreds) => {
        expect(storySeconds(film(hundreds * 100, []))).toBe(storyOfRoundDuration(hundreds));
      }),
      { seed: SEED },
    );
  });
});

describe('the seconds played', () => {
  test('are the story’s seconds played at least once, rounded down', () => {
    expect(playedSeconds(film(1000, [[0, 100]]))).toBe(100);
    // Two stretches: 10.6 + 10.6 is 21.2 s, rounded down once, not stretch by stretch.
    expect(
      playedSeconds(
        film(1000, [
          [0, 10.6],
          [20, 30.6],
        ]),
      ),
    ).toBe(21);
  });

  test('a stretch played twice counts once', () => {
    expect(
      playedSeconds(
        film(1000, [
          [0, 100],
          [50, 150],
        ]),
      ),
    ).toBe(150);
  });

  test('time in the credits and before a stated intro’s end is not the story’s', () => {
    // The story runs 0–880 s; the stretch past it is the credits.
    expect(playedSeconds(film(1000, [[0, 1000]]))).toBe(880);
    // With the intro over at 60 s, the first minute is not played story.
    expect(playedSeconds(film(1000, [[0, 100]], { introEndSeconds: 60 }))).toBe(40);
  });

  test('is never more than the story, whatever the ranges hold', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 200, max: 20_000 }),
        fc.array(
          fc.tuple(
            fc.double({ min: 0, max: 30_000, noNaN: true }),
            fc.double({ min: 0, max: 30_000, noNaN: true }),
          ),
        ),
        (duration, pairs) => {
          const ranges = pairs.map(([a, b]): [number, number] => [Math.min(a, b), Math.max(a, b)]);
          const v = film(duration, ranges);
          const story = storySeconds(v);
          expect(playedSeconds(v)).toBeLessThanOrEqual(story ?? 0);
          expect(playedSeconds(v)).toBeGreaterThanOrEqual(0);
        },
      ),
      { seed: SEED },
    );
  });

  test('without a story, nothing was played', () => {
    expect(playedSeconds(film(null, [[0, 100]]))).toBe(0);
  });
});

describe('a share of a story, rounded up to a whole second', () => {
  test('whole percentages: the least whole number of seconds that holds the share', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: MAX_SECONDS }),
        (p, story) => {
          const line = shareLine(p, story);
          // Exact integer arithmetic: p × story / 100 ≤ line < p × story / 100 + 1.
          expect(line * 100).toBeGreaterThanOrEqual(p * story);
          expect((line - 1) * 100).toBeLessThan(p * story);
        },
      ),
      { seed: SEED },
    );
  });

  test('a share that is a whole number of seconds is not rounded past itself', () => {
    expect(shareLine(10, 9960)).toBe(996);
    expect(shareLine(90, 880)).toBe(792);
    expect(shareLine(50, 100)).toBe(50);
  });

  test('a share that falls between seconds goes up', () => {
    expect(shareLine(10, 10_001)).toBe(1001);
    expect(shareLine(90, 881)).toBe(793);
    expect(shareLine(1, 1)).toBe(1);
  });

  test('a threshold with a fraction in bounds rounds up the same way', () => {
    // Tenths of a percent, in exact integer arithmetic: ceil(tenths × story / 1000).
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 1000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (tenths, story) => {
          const expected = Math.floor((tenths * story + 999) / 1000);
          expect(shareLine(tenths / 10, story)).toBe(expected);
        },
      ),
      { seed: SEED },
    );
  });
});

describe('the start line: the larger of the share and the floor', () => {
  test('is max(ceil(share × story / 100), floor) for any story', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 3600 }),
        fc.integer({ min: 1, max: 100_000 }),
        (p, floor, story) => {
          const expected = Math.max(Math.floor((p * story + 99) / 100), floor);
          expect(
            startLine(rule({ startThresholdPercent: p, startFloorSeconds: floor }), story),
          ).toBe(expected);
        },
      ),
      { seed: SEED },
    );
  });

  test('starts off draw no line, whatever the floor', () => {
    expect(startLine(rule({ startThresholdPercent: null }), 5000)).toBeNull();
  });
});

describe('the rule as the connection states it', () => {
  test('any share from 1 to 100 and any floor from 0 to a week are the rule, field by field', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 100, noNaN: true }),
        fc.integer({ min: 0, max: MAX_SECONDS }),
        fc.double({ min: 1, max: 100, noNaN: true }),
        (start, floor, finish) => {
          expect(readAccountRule(start, floor, finish)).toEqual({
            rule: {
              startThresholdPercent: start,
              startFloorSeconds: floor,
              finishThresholdPercent: finish,
            },
            invalid: [],
          });
        },
      ),
      { seed: SEED },
    );
  });

  test.each([1, 100, 0.5 + 0.5, 99.99])('a share of %f is in bounds', (share) => {
    expect(readAccountRule(share, 0, share).invalid).toEqual([]);
  });

  test.each([0, 0.99, 100.01, -5, Number.NaN, Number.POSITIVE_INFINITY, '10', true, {}, []])(
    'a share of %j is out of bounds, for the start and for the finish alike',
    (bad) => {
      expect(readAccountRule(bad, 300, 90).invalid).toEqual(['start_threshold_percent']);
      expect(readAccountRule(10, 300, bad).invalid).toEqual(['finish_threshold_percent']);
    },
  );

  test.each([
    -1,
    1.5,
    MAX_SECONDS + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '300',
    null,
    undefined,
  ])('a floor of %j is out of bounds', (bad) => {
    expect(readAccountRule(10, bad, 90).invalid).toEqual(['start_floor_seconds']);
  });

  test('the floor’s bounds are 0 and a week', () => {
    expect(readAccountRule(10, 0, 90).invalid).toEqual([]);
    expect(readAccountRule(10, MAX_SECONDS, 90).invalid).toEqual([]);
  });

  test('a start field out of bounds turns starts off and leaves the finish line as read', () => {
    const read = readAccountRule(500, 300, 70);
    expect(read.rule).toEqual({
      startThresholdPercent: null,
      startFloorSeconds: 0,
      finishThresholdPercent: 70,
    });
    const other = readAccountRule(10, -3, 50);
    expect(other.rule.startThresholdPercent).toBeNull();
    expect(other.rule.finishThresholdPercent).toBe(50);
  });

  test('a finish line out of bounds is 70 and leaves the start line as read', () => {
    const read = readAccountRule(10, 300, null);
    expect(read.rule).toEqual({
      startThresholdPercent: 10,
      startFloorSeconds: 300,
      finishThresholdPercent: 70,
    });
    expect(read.invalid).toEqual(['finish_threshold_percent']);
  });

  test('a null start with a floor in bounds is off, and nothing is wrong', () => {
    expect(readAccountRule(null, 300, 50).invalid).toEqual([]);
    expect(readAccountRule(null, 300, 50).rule.startThresholdPercent).toBeNull();
  });

  test('a null start with a floor out of bounds still names the floor', () => {
    expect(readAccountRule(null, -1, 90).invalid).toEqual(['start_floor_seconds']);
  });

  test('everything missing is the never-read rule, with all three fields named', () => {
    const read = readAccountRule(undefined, undefined, undefined);
    expect(read.invalid).toEqual([
      'start_threshold_percent',
      'start_floor_seconds',
      'finish_threshold_percent',
    ]);
    expect(read.rule).toEqual({
      startThresholdPercent: null,
      startFloorSeconds: 0,
      finishThresholdPercent: 70,
    });
  });
});

describe('when a start is due', () => {
  // A 1000 s film: the story is 880 s. At 10 % with a 60 s floor the line is 88 s.
  const line = rule({ startFloorSeconds: 60 });

  test('not a second short of the line, and at it', () => {
    expect(dueStart(film(1000, [[0, 87.99]]), line)).toBeNull();
    expect(dueStart(film(1000, [[0, 88]]), line)).not.toBeNull();
  });

  test('the floor binds when it is larger than the share', () => {
    const floor = rule({ startThresholdPercent: 5, startFloorSeconds: 300 });
    // 5 % of 880 s is 44 s; the floor holds it to 300 s.
    expect(dueStart(film(1000, [[0, 299]]), floor)).toBeNull();
    expect(dueStart(film(1000, [[0, 300]]), floor)).not.toBeNull();
  });

  test('a floor longer than the story is never reached', () => {
    const long = rule({ startFloorSeconds: 900 });
    expect(dueStart(film(1000, [[0, 1000]]), long)).toBeNull();
  });

  test('a floor of nothing leaves the share alone', () => {
    expect(dueStart(film(1000, [[0, 88]]), rule({ startFloorSeconds: 0 }))).not.toBeNull();
    expect(dueStart(film(1000, [[0, 87]]), rule({ startFloorSeconds: 0 }))).toBeNull();
  });

  test('skipped time is not played: a jump past the line starts nothing', () => {
    // Furthest position 600 s, but only 20 s of the story was played.
    expect(
      dueStart(
        film(1000, [
          [0, 10],
          [590, 600],
        ]),
        line,
      ),
    ).toBeNull();
  });

  test('time in the credits is not the story’s', () => {
    expect(dueStart(film(1000, [[880, 1000]]), line)).toBeNull();
  });

  test('starts off, or a length that is not known, start nothing', () => {
    expect(dueStart(film(1000, [[0, 800]]), rule({ startThresholdPercent: null }))).toBeNull();
    expect(dueStart(film(null, [[0, 800]]), line)).toBeNull();
  });

  test('an episode never starts', () => {
    expect(dueStart(episode(), line)).toBeNull();
  });

  test.each(['reported', 'skipped', 'expired'] as const)('a %s viewing starts nothing', (state) => {
    expect(dueStart(film(1000, [[0, 800]], { state }), line)).toBeNull();
  });

  test('a viewing whose own play is reserved starts nothing', () => {
    expect(dueStart(film(1000, [[0, 800]], { reportedPlayId: 'p1' }), line)).toBeNull();
  });

  test('one start per viewing: a queued start is never due again', () => {
    expect(dueStart(film(1000, [[0, 800]], { startSentAt: 5 }), line)).toBeNull();
    expect(dueStart(film(1000, [[0, 800]], { startSentAt: null }), line)).not.toBeNull();
  });

  test('a viewing stored before starts existed is due like a new one', () => {
    const stored = film(1000, [[0, 800]]);
    const old = { ...stored } as Record<string, unknown>;
    delete old.startSentAt;
    delete old.startPlayId;
    expect(dueStart(old as unknown as Viewing, line)).not.toBeNull();
  });

  test('is due exactly when the seconds played reach the line, for any film', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 400 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 1200 }),
        fc.nat(100),
        (hundreds, percent, floor, playedPercent) => {
          const duration = hundreds * 100;
          const story = storyOfRoundDuration(hundreds);
          const r = rule({ startThresholdPercent: percent, startFloorSeconds: floor });
          const expectedLine = Math.max(Math.floor((percent * story + 99) / 100), floor);
          const played = Math.floor((story * playedPercent) / 100);
          const due = dueStart(film(duration, [[0, played]]), r) !== null;
          expect(due).toBe(played >= expectedLine);
          const justShort = expectedLine - 1;
          if (justShort >= 0 && justShort <= story) {
            expect(dueStart(film(duration, [[0, justShort]]), r)).toBeNull();
          }
        },
      ),
      { seed: SEED },
    );
  });
});

describe('the bodies a play and a start carry', () => {
  const played = film(1000, [[15, 105]]);
  const FIELDS = [
    'duration_seconds',
    'furthest_position_seconds',
    'story_seconds',
    'played_seconds',
  ] as const;

  test('a start carries four numbers and says it is one, with no time and no end', () => {
    const body = buildStart(played);
    expect(body).toEqual({
      report: 'start',
      kind: 'movie',
      title: 'Arrival',
      year: 2016,
      duration_seconds: 1000,
      furthest_position_seconds: 105,
      story_seconds: 880,
      played_seconds: 90,
    });
    expect(body).not.toHaveProperty('watched_at');
    expect(body).not.toHaveProperty('ended');
  });

  test('a viewing’s play carries the same four numbers, its time and `ended`, and no `report`', () => {
    const body = buildPlay(played, Date.parse('2026-10-20T19:00:00Z'), 120);
    expect(body).toEqual({
      kind: 'movie',
      title: 'Arrival',
      year: 2016,
      watched_at: '2026-10-20T21:00:00+02:00',
      duration_seconds: 1000,
      furthest_position_seconds: 105,
      story_seconds: 880,
      played_seconds: 90,
      ended: false,
    });
    expect(body).not.toHaveProperty('report');
  });

  test('a start and a play share every other field, whatever the viewing', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 200, max: 30_000 }),
        fc.double({ min: 0, max: 30_000, noNaN: true }),
        fc.double({ min: 0, max: 30_000, noNaN: true }),
        (duration, a, b) => {
          const v = film(duration, [[Math.min(a, b), Math.max(a, b)]]);
          const start = buildStart(v);
          const play = buildPlay(v, 0, 0);
          if (start === null || play === null) return;
          for (const key of FIELDS) expect(start[key]).toBe(play[key]);
          expect(start.title).toBe(play.title);
          expect(start.year).toBe(play.year);
        },
      ),
      { seed: SEED },
    );
  });

  test('all four numbers are whole, in order: played ≤ story ≤ duration, furthest ≤ duration', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 2, max: MAX_SECONDS, noNaN: true }),
        fc.array(
          fc.tuple(
            fc.double({ min: 0, max: MAX_SECONDS * 2, noNaN: true }),
            fc.double({ min: 0, max: MAX_SECONDS * 2, noNaN: true }),
          ),
        ),
        (duration, pairs) => {
          const ranges = pairs.map(([a, b]): [number, number] => [Math.min(a, b), Math.max(a, b)]);
          const body = buildPlay(film(duration, ranges), 0, 0);
          if (body === null) return;
          const {
            duration_seconds: d,
            furthest_position_seconds: f,
            story_seconds: s,
            played_seconds: p,
          } = body;
          for (const n of [d, f, s, p]) expect(Number.isInteger(n)).toBe(true);
          expect(s).toBeGreaterThanOrEqual(1);
          expect(s).toBeLessThanOrEqual(d ?? 0);
          expect(p).toBeLessThanOrEqual(s ?? 0);
          expect(f).toBeLessThanOrEqual(d ?? 0);
          expect(d).toBeLessThanOrEqual(MAX_SECONDS);
        },
      ),
      { seed: SEED },
    );
  });

  test('the running time is rounded down', () => {
    expect(buildPlay(film(1000.9, [[0, 100]]), 0, 0)?.duration_seconds).toBe(1000);
    expect(buildStart(film(1000.9, [[0, 100]]))?.duration_seconds).toBe(1000);
  });

  test('the furthest position is the end of the furthest range, rounded down, within the length', () => {
    expect(buildPlay(film(1000, [[0, 100.9]]), 0, 0)?.furthest_position_seconds).toBe(100);
    expect(buildPlay(film(1000, [[0, 1500]]), 0, 0)?.furthest_position_seconds).toBe(1000);
  });

  test('a length the wire cannot take has no story, no play and no start', () => {
    for (const duration of [0.5, 0.99, MAX_SECONDS + 1]) {
      const v = film(duration, [[0, 0.4]]);
      expect(buildPlay(v, 0, 0)).toBeNull();
      expect(buildStart(v)).toBeNull();
      expect(dueStart(v, rule({ startFloorSeconds: 0 }))).toBeNull();
    }
    expect(buildPlay(film(MAX_SECONDS, []), 0, 0)).not.toBeNull();
  });

  test('a length that is not known has no play and no start', () => {
    expect(buildPlay(film(null, []), 0, 0)).toBeNull();
    expect(buildStart(film(null, []))).toBeNull();
  });

  test('`ended` is only what the player or the service showed', () => {
    const credits = film(1000, [[0, 900]], { creditsStartSeconds: 880 });
    expect(buildPlay(credits, 0, 0)?.ended).toBe(false);
    expect(buildPlay({ ...credits, contentEnded: true }, 0, 0)?.ended).toBe(true);
    // Past the estimated credits start with the element not ended: still false.
    expect(buildPlay(film(1000, [[0, 1000]]), 0, 0)?.ended).toBe(false);
  });

  test('a start is for a film only', () => {
    expect(buildStart(episode())).toBeNull();
  });
});

describe('a play is held back with the account’s own line', () => {
  // A 1000 s film: the story is 880 s, played from the start to wherever playing stopped.
  const playedTo = (played: number) => film(1000, [[0, played]]);

  test.each([
    [50, 440],
    [70, 616],
    [90, 792],
  ])('at %i %% the line of an 880 s story is %i s played', (percent, line) => {
    expect(reportVerdict(playedTo(line), percent).kind).toBe('report');
    expect(reportVerdict(playedTo(line - 0.5), percent).kind).toBe('wait');
  });

  test('a line is rounded up: 90 % of 881 s is 793 s', () => {
    const v = film(1001.5, [[0, 792.5]]);
    expect(storySeconds(v)).toBe(881);
    expect(reportVerdict(v, 90).kind).toBe('wait');
    expect(reportVerdict({ ...v, ranges: [[0, 793]] }, 90).kind).toBe('report');
  });

  test('held back with the line in force at that moment: the same viewing, two lines', () => {
    const v = playedTo(500);
    expect(reportVerdict(v, 90).kind).toBe('wait');
    expect(reportVerdict(v, 50).kind).toBe('report');
  });

  test('a line that is not a number records nothing', () => {
    expect(reportVerdict(playedTo(880), Number.NaN).kind).toBe('wait');
    expect(reportVerdict(playedTo(880), undefined as unknown as number).kind).toBe('wait');
  });

  test('is reported exactly when the seconds played reach the line, for any film and line', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 400 }),
        fc.constantFrom(50, 70, 90),
        fc.nat(100),
        (hundreds, percent, playedPercent) => {
          const story = storyOfRoundDuration(hundreds);
          const played = Math.floor((story * playedPercent) / 100);
          const v = film(hundreds * 100, [[0, played]]);
          const line = Math.floor((percent * story + 99) / 100);
          expect(reportVerdict(v, percent).kind).toBe(played >= line ? 'report' : 'wait');
        },
      ),
      { seed: SEED },
    );
  });

  test('a story still playing is reported at the line, not held for its end', () => {
    expect(reportVerdict(film(1000, [[0, 700]]), 50).kind).toBe('report');
    // A skim to the credits, the content ended: nothing skipped counts towards the line.
    const skim = film(1000, [
      [0, 100],
      [870, 1000],
    ]);
    expect(reportVerdict({ ...skim, contentEnded: true }, 50).kind).toBe('wait');
  });
});
