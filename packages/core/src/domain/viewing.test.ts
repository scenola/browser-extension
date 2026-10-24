/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import type { Interval, PlaybackSample } from './coverage';
import { titleKey } from './reading';
import type { MergedReading } from './reading';
import { DAY_MS } from './time';
import {
  CREDITS_ESTIMATE_MAX_S,
  CREDITS_ESTIMATE_SHARE,
  ENGAGED_AREA,
  INTRO_MAX_S,
  INTRO_MAX_SHARE,
  INTRO_WITHIN_SHARE,
  MIN_CONTENT_SECONDS,
  SAME_LENGTH_FLOOR_S,
  SAME_LENGTH_SHARE,
  VIEWING_IDLE_MS,
  applySample,
  joinTarget,
  lengthsAgree,
  mediaLength,
  momentOf,
  newViewing,
  readingJoins,
  reportVerdict,
  sameTitleRefinement,
} from './viewing';
import type { MediaLength, Viewing } from './viewing';

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

const READING: MergedReading = { kind: 'movie', title: 'Film', year: 2000, sources: ['json-ld'] };

function viewingWith(
  o: {
    duration?: number | null;
    ranges?: readonly Interval[];
    contentEnded?: boolean;
    state?: Viewing['state'];
    engaged?: boolean;
    reading?: MergedReading;
  } = {},
): Viewing {
  return {
    id: 'v1',
    key: 'mv:film:2000',
    serviceId: null,
    reading: o.reading ?? READING,
    ranges: o.ranges ?? [],
    durationSeconds: o.duration === undefined ? 1000 : o.duration,
    statedDurationSeconds: null,
    elementDurationSeconds: o.duration === undefined ? 1000 : o.duration,
    lastElementDuration: o.duration === undefined ? 1000 : o.duration,
    contentEnded: o.contentEnded ?? false,
    firstSeenAt: 1_000,
    lastSampleAt: 5_000,
    incognito: false,
    engaged: o.engaged ?? true,
    state: o.state ?? 'open',
    reportedPlayId: null,
  };
}

function sample(o: Partial<PlaybackSample> & { at: number; position: number }): PlaybackSample {
  return {
    duration: 1000,
    paused: false,
    ended: false,
    rate: 1,
    adPlaying: false,
    muted: false,
    visibleArea: 1,
    ...o,
  };
}

describe('constants', () => {
  test('are pinned', () => {
    // The story ends at the credits, estimated at the last min(12 %, 20 min); a skipped intro is
    // a seek within the first 15 %, of at most min(15 %, 20 min). The finish line itself is the
    // account's, not a constant.
    expect(CREDITS_ESTIMATE_SHARE).toBe(0.12);
    expect(CREDITS_ESTIMATE_MAX_S).toBe(1200);
    expect(INTRO_WITHIN_SHARE).toBe(0.15);
    expect(INTRO_MAX_SHARE).toBe(0.15);
    expect(INTRO_MAX_S).toBe(1200);
    expect(MIN_CONTENT_SECONDS).toBe(120);
    expect(VIEWING_IDLE_MS).toBe(7 * DAY_MS);
    expect(ENGAGED_AREA).toBe(0.25);
  });
});

describe('reportVerdict', () => {
  // The verdict is taken at the account's finish line; these use a 50 % line.
  const verdict = (v: Viewing) => reportVerdict(v, 50);

  // The story is 880 s of 1000 (the credits estimate), so the 50 % line is 440 s played.
  test('the line reached mid-story, far from the credits → report, at the last sample', () => {
    const v = viewingWith({ ranges: [[0, 440]] });
    expect(verdict(v)).toEqual({ kind: 'report', watchedAt: 5_000 });
  });

  test('at the credits, a second short of the line → wait', () => {
    expect(verdict(viewingWith({ ranges: [[441, 900]] }))).toEqual({ kind: 'wait' });
  });

  test('finished by contentEnded at 85 % furthest with 80 % coverage → report', () => {
    const v = viewingWith({ ranges: [[50, 850]], contentEnded: true });
    expect(verdict(v)).toMatchObject({ kind: 'report' });
  });

  test('scrubbed to the end: furthest 100 %, ended, coverage 10 % → wait', () => {
    const v = viewingWith({
      ranges: [
        [0, 90],
        [990, 1000],
      ],
      contentEnded: true,
    });
    expect(verdict(v)).toEqual({ kind: 'wait' });
  });

  // The floor is the person's threshold over the story (880 s here): exactly the threshold
  // reports, a second under it waits.
  test('coverage of the story exactly at the threshold → report; just under → wait', () => {
    expect(verdict(viewingWith({ ranges: [[440, 1000]] })).kind).toBe('report');
    expect(verdict(viewingWith({ ranges: [[441, 1000]] })).kind).toBe('wait');
    expect(reportVerdict(viewingWith({ ranges: [[264, 1000]] }), 70).kind).toBe('report');
    expect(reportVerdict(viewingWith({ ranges: [[265, 1000]] }), 70).kind).toBe('wait');
  });

  test('duration 119 s → never(too_short); 120 s → report', () => {
    expect(verdict(viewingWith({ duration: 119, ranges: [[0, 119]] }))).toEqual({
      kind: 'never',
      reason: 'too_short',
    });
    expect(verdict(viewingWith({ duration: 120, ranges: [[0, 120]] })).kind).toBe('report');
  });

  test.each([NaN, Infinity, 0, null])('duration %s never reports', (duration) => {
    const v = viewingWith({ duration, ranges: [[0, 1000]], contentEnded: true });
    expect(verdict(v).kind).not.toBe('report');
  });

  test('a skipped viewing never reports even when finished', () => {
    const v = viewingWith({ ranges: [[0, 1000]], state: 'skipped' });
    expect(verdict(v)).toEqual({ kind: 'never', reason: 'skipped' });
  });

  test('a reported viewing never reports again', () => {
    const v = viewingWith({ ranges: [[0, 1000]], state: 'reported' });
    expect(verdict(v)).toEqual({ kind: 'never', reason: 'already_reported' });
  });

  test('an expired viewing never reports', () => {
    expect(verdict(viewingWith({ ranges: [[0, 1000]], state: 'expired' })).kind).toBe('never');
  });

  test('a viewing that does not say what it is never reports', () => {
    const v = viewingWith({ ranges: [[0, 1000]], reading: { sources: [] } });
    expect(verdict(v)).toEqual({ kind: 'never', reason: 'not_identified' });
  });

  test('an unengaged viewing waits even when finished', () => {
    expect(verdict(viewingWith({ ranges: [[0, 1000]], engaged: false }))).toEqual({
      kind: 'wait',
    });
  });
});

describe('applySample', () => {
  const empty = viewingWith({ duration: null, ranges: [], engaged: false });

  test('playback between two samples adds a range and records the sample time', () => {
    const a = sample({ at: 0, position: 100 });
    const b = sample({ at: 15_000, position: 115 });
    const v = applySample(applySample(empty, null, a, READING), a, b, READING);
    expect(v.ranges).toEqual([[100, 115]]);
    expect(v.lastSampleAt).toBe(15_000);
    expect(v.durationSeconds).toBe(1000);
  });

  test('a seek adds nothing', () => {
    const v = applySample(
      empty,
      sample({ at: 0, position: 100 }),
      sample({ at: 15_000, position: 900 }),
      READING,
    );
    expect(v.ranges).toEqual([]);
  });

  test('duration keeps the largest finite value seen (ads shrink it mid-play)', () => {
    const s = [3000, 3000, 30, 30, null].map((duration, i) =>
      sample({ at: i * 15_000, position: i * 15, duration }),
    );
    let v = empty;
    s.forEach((cur, i) => {
      v = applySample(v, s[i - 1] ?? null, cur, READING);
    });
    expect(v.durationSeconds).toBe(3000);
  });

  test('a transient previous-episode duration never enters the maximum', () => {
    const s = [5400, 2700, 2700].map((duration, i) =>
      sample({ at: i * 15_000, position: i * 15, duration }),
    );
    let v = empty;
    s.forEach((cur, i) => {
      v = applySample(v, s[i - 1] ?? null, cur, READING);
    });
    expect(v.durationSeconds).toBe(2700);
  });

  test('the service-stated duration wins over an inflated element duration', () => {
    const a = sample({ at: 0, position: 0, duration: 6300 });
    const b = sample({ at: 15_000, position: 15, duration: 6300 });
    let v = applySample(applySample(empty, null, a, READING), a, b, READING);
    expect(v.durationSeconds).toBe(6300);
    v = applySample(v, b, sample({ at: 30_000, position: 30, duration: 6300 }), {
      ...READING,
      contentDurationSeconds: 6000,
    });
    expect(v.durationSeconds).toBe(6000);
    expect(v.statedDurationSeconds).toBe(6000);
  });

  test('the service-stated content duration is used before the element has agreed', () => {
    const s = sample({ at: 0, position: 0, duration: 60 });
    const v = applySample(empty, null, s, { ...READING, contentDurationSeconds: 2400 });
    expect(v.durationSeconds).toBe(2400);
  });

  test('a pre-roll that ends with adPlaying does not end the content', () => {
    const v = applySample(
      viewingWith(),
      null,
      sample({ at: 0, position: 30, ended: true, adPlaying: true }),
      READING,
    );
    expect(v.contentEnded).toBe(false);
    const viaReading = applySample(
      viewingWith(),
      null,
      sample({ at: 0, position: 30, ended: true }),
      { ...READING, adPlaying: true },
    );
    expect(viaReading.contentEnded).toBe(false);
  });

  // The story is 880 s of 1000 (the credits estimate), so the 70 % line is 616 s played.
  test('short of the line at the credits, then the missed middle played: report at the sample that reaches the line', () => {
    const verdicts: ReturnType<typeof reportVerdict>[] = [];
    const steps = (v0: Viewing, from: number, to: number, t0: number): Viewing => {
      let v = v0;
      let prev = sample({ at: t0, position: from });
      v = applySample(v, null, prev, READING);
      for (let p = from + 15; p <= to; p += 15) {
        const cur = sample({ at: t0 + (p - from) * 1000, position: p });
        v = applySample(v, prev, cur, READING);
        verdicts.push(reportVerdict(v, 70));
        prev = cur;
      }
      return v;
    };
    // 300 s to the credits and past them: 580 s of the story, short of the line.
    let v = steps(empty, 300, 900, 0);
    expect(verdicts.every((x) => x.kind === 'wait')).toBe(true);
    // From 150 s, the line is reached at 186 s: the sample at 195 s, 45 s into the sitting.
    v = steps(v, 150, 300, 700_000);
    expect(verdicts.find((x) => x.kind === 'report')).toEqual({
      kind: 'report',
      watchedAt: 745_000,
    });
    expect(verdicts.at(-1)).toEqual({ kind: 'report', watchedAt: 850_000 });
    expect(v.state).toBe('open');
  });

  test('a later reading keeps earlier fields it lacks; new values win; moment signals do not carry', () => {
    const first: MergedReading = {
      kind: 'episode',
      showTitle: 'Show',
      season: 1,
      episode: 2,
      episodeTitle: 'Pilot',
      showYear: 2010,
      ids: { tmdb: 5 },
      adPlaying: true,
      sources: ['json-ld'],
    };
    const episodic: Viewing = { ...empty, key: 'ep:show:1:2', reading: first };
    const v = applySample(episodic, null, sample({ at: 1, position: 0 }), {
      kind: 'episode',
      showTitle: 'Show',
      season: 1,
      episode: 2,
      episodeTitle: 'Pilot 2',
      sources: ['open-graph'],
    });
    expect(v.reading).toEqual({
      kind: 'episode',
      showTitle: 'Show',
      season: 1,
      episode: 2,
      episodeTitle: 'Pilot 2',
      showYear: 2010,
      ids: { tmdb: 5 },
      sources: ['json-ld', 'open-graph'],
    });
  });

  test('a reading that names another viewing is refused, never merged', () => {
    expect(() =>
      applySample(empty, null, sample({ at: 0, position: 0 }), {
        kind: 'movie',
        title: 'Film 2',
        sources: ['open-graph'],
      }),
    ).toThrow(new RangeError('applySample: the reading belongs to another viewing'));
  });

  test('readingJoins says beforehand what applySample would refuse', () => {
    expect(readingJoins(empty, READING)).toBe(true);
    // A reading that names nothing of its own carries the viewing's fields: it joins.
    expect(readingJoins(empty, { contentEnded: true, sources: [] })).toBe(true);
    expect(readingJoins(empty, { kind: 'movie', title: 'Film 2', sources: ['open-graph'] })).toBe(
      false,
    );
    // The same title gaining a year is another key, so another viewing.
    expect(
      readingJoins(
        { ...empty, key: 'mv:film:', reading: { kind: 'movie', title: 'Film', sources: [] } },
        READING,
      ),
    ).toBe(false);
    // A kind that contradicts the viewing does not join, even without a title of its own.
    expect(readingJoins(empty, { kind: 'episode', sources: [] })).toBe(false);
  });

  test.each([NaN, Infinity, 0])(
    'an element duration of %s never agrees into the duration',
    (bad) => {
      const s = [0, 1, 2].map((i) => sample({ at: i * 15_000, position: i * 15, duration: bad }));
      let v = empty;
      s.forEach((cur, i) => {
        v = applySample(v, s[i - 1] ?? null, cur, READING);
      });
      expect(v.durationSeconds).toBeNull();
      expect(v.elementDurationSeconds).toBeNull();
    },
  );

  test.each([NaN, Infinity, -5, 0])('a duration of %s is never recorded', (bad) => {
    const s = sample({ at: 0, position: 0, duration: null });
    const v = applySample(empty, null, s, { ...READING, contentDurationSeconds: bad });
    expect(v.durationSeconds).toBeNull();
  });

  test('contentEnded latches from the element or the reading', () => {
    // The element's `ended` counts only from media of the length the viewing knows (1000 s
    // here); `empty` knows none, so the element case starts from a viewing that does.
    const known = viewingWith({ ranges: [] });
    let v = applySample(known, null, sample({ at: 0, position: 0, ended: true }), READING);
    expect(v.contentEnded).toBe(true);
    v = applySample(v, null, sample({ at: 1, position: 0 }), READING);
    expect(v.contentEnded).toBe(true);
    v = applySample(empty, null, sample({ at: 0, position: 0 }), {
      ...READING,
      contentEnded: true,
    });
    expect(v.contentEnded).toBe(true);
  });

  test('a muted preview at 10 % of the viewport never engages and never reports; unmuting once engages it', () => {
    const preview = (at: number, position: number) =>
      sample({ at, position, muted: true, visibleArea: 0.1 });
    let v = empty;
    let prev: PlaybackSample | null = null;
    for (let i = 0; i < 70; i++) {
      const s: PlaybackSample = preview(i * 15_000, i * 15);
      v = applySample(v, prev, s, READING);
      prev = s;
    }
    expect(v.engaged).toBe(false);
    // The verdict takes the account's line (50 % here, the lowest it may be).
    expect(reportVerdict(v, 50).kind).not.toBe('report');
    const unmuted = sample({ at: 70 * 15_000, position: 1050, muted: false, visibleArea: 0.1 });
    v = applySample(v, prev, unmuted, READING);
    expect(v.engaged).toBe(true);
  });

  test('an enlarged muted player engages at a quarter of the viewport', () => {
    const v = applySample(
      empty,
      null,
      sample({ at: 0, position: 0, muted: true, visibleArea: 0.25 }),
      READING,
    );
    expect(v.engaged).toBe(true);
  });

  test('is pure: the input viewing is not mutated', () => {
    const before = JSON.stringify(empty);
    applySample(
      empty,
      sample({ at: 0, position: 0 }),
      sample({ at: 15_000, position: 15 }),
      READING,
    );
    expect(JSON.stringify(empty)).toBe(before);
  });
});

describe('newViewing', () => {
  test('an open, empty viewing keyed by its reading', () => {
    expect(
      newViewing({ id: 'v9', serviceId: null, reading: READING, at: 7_000, incognito: true }),
    ).toEqual({
      id: 'v9',
      key: 'mv:film:2000',
      serviceId: null,
      reading: READING,
      ranges: [],
      durationSeconds: null,
      statedDurationSeconds: null,
      elementDurationSeconds: null,
      lastElementDuration: null,
      contentEnded: false,
      firstSeenAt: 7_000,
      lastSampleAt: 7_000,
      incognito: true,
      engaged: false,
      state: 'open',
      reportedPlayId: null,
    });
  });

  test('a reading that identifies nothing starts no viewing', () => {
    expect(
      newViewing({ id: 'v9', serviceId: null, reading: { sources: [] }, at: 0, incognito: false }),
    ).toBeNull();
  });
});

describe('the same title, named more or less finely', () => {
  const film = (r: Partial<MergedReading>, serviceId: string | null = null): Viewing =>
    must(
      newViewing({
        id: 'v',
        serviceId,
        reading: { kind: 'movie', title: 'Film', sources: ['json-ld'], ...r },
        at: 0,
        incognito: false,
      }),
    );
  const episode = (r: Partial<MergedReading>, serviceId: string | null = 'netflix'): Viewing =>
    must(
      newViewing({
        id: 'v',
        serviceId,
        reading: {
          kind: 'episode',
          showTitle: 'Show',
          season: 1,
          episode: 2,
          sources: ['module'],
          ...r,
        },
        at: 0,
        incognito: false,
      }),
    );
  const read = (r: Partial<MergedReading>): MergedReading => ({ sources: ['json-ld'], ...r });
  const id81 = [{ level: 'title' as const, key: 'videoId', value: '81' }];
  const id82 = [{ level: 'title' as const, key: 'videoId', value: '82' }];
  const unknown: MediaLength = { stated: null, element: null };
  // A length the observation shows; the viewings here have none of their own, which agrees.
  const shown: MediaLength = { stated: null, element: 5400 };

  test('a year on one side only is the same film; two different years are two films', () => {
    const noYear = film({});
    expect(
      sameTitleRefinement(noYear, read({ kind: 'movie', title: 'FILM', year: 2000 }), null, shown),
    ).toBe(true);
    const withYear = film({ year: 2000 });
    expect(sameTitleRefinement(withYear, read({ kind: 'movie', title: 'Film' }), null, shown)).toBe(
      true,
    );
    expect(
      sameTitleRefinement(
        withYear,
        read({ kind: 'movie', title: 'Film', year: 2021 }),
        null,
        unknown,
      ),
    ).toBe(false);
    expect(
      sameTitleRefinement(
        noYear,
        read({ kind: 'movie', title: 'Other', year: 2000 }),
        null,
        unknown,
      ),
    ).toBe(false);
    expect(
      sameTitleRefinement(noYear, read({ kind: 'episode', title: 'Film' }), null, unknown),
    ).toBe(false);
  });

  test('a refinement is decided only on a length the observation shows: null until then', () => {
    const noYear = film({});
    const dated = read({ kind: 'movie', title: 'Film', year: 2000 });
    expect(sameTitleRefinement(noYear, dated, null, unknown)).toBeNull();
    expect(sameTitleRefinement(noYear, dated, null, shown)).toBe(true);
    // The names decide without a length: another title, or two years, is never null.
    expect(
      sameTitleRefinement(film({ year: 1984 }), dated, null, unknown),
      'two years that disagree',
    ).toBe(false);
    // The viewing's own key, or one of nothing, needs no length.
    expect(sameTitleRefinement(film({ year: 2000 }), dated, null, unknown)).toBe(true);
  });

  test('two show years that disagree are two shows, whatever the lengths', () => {
    const plain = episode({ showYear: 2004 });
    const withId = (showYear: number) =>
      read({
        kind: 'episode',
        showTitle: 'Show',
        season: 1,
        episode: 2,
        showYear,
        providerIds: id81,
      });
    expect(sameTitleRefinement(plain, withId(1978), 'netflix', shown)).toBe(false);
    expect(sameTitleRefinement(plain, withId(2004), 'netflix', shown)).toBe(true);
    expect(
      sameTitleRefinement(episode({}), withId(1978), 'netflix', shown),
      'one side states none',
    ).toBe(true);
  });

  test('a reading from another service never refines, with ids or without; a site without a module is a service of its own', () => {
    const same = read({ kind: 'episode', showTitle: 'Show', season: 1, episode: 2 });
    const zz = { ...same, providerIds: [{ level: 'title' as const, key: 'id', value: 'zz' }] };
    for (const bound of [episode({}), episode({ providerIds: id81 })]) {
      for (const [reading, serviceId] of [
        [zz, 'apple-tv'],
        [same, 'apple-tv'],
        [same, null],
        [zz, null],
      ] as const) {
        expect(sameTitleRefinement(bound, reading, serviceId, shown)).toBe(false);
        expect(sameTitleRefinement(bound, reading, serviceId, unknown)).toBe(false);
        expect(joinTarget(bound, reading, serviceId, shown)).toBeNull();
      }
    }
    // Nor does a reading of nothing (no kind, no key) seen on another service.
    expect(joinTarget(episode({}), read({ contentEnded: true }), 'apple-tv', shown)).toBeNull();
    // A generic site's viewing is never a module's.
    const generic = episode({}, null);
    expect(sameTitleRefinement(generic, same, 'netflix', shown)).toBe(false);
    // Two sites without a module are one service: they join on the title and the length.
    expect(sameTitleRefinement(generic, same, null, shown)).toBe(true);
    // Their ids name nothing, so two that disagree decide nothing.
    expect(sameTitleRefinement(episode({ providerIds: id81 }, null), zz, null, shown)).toBe(true);
  });

  test('an equal key answers true without asking the lengths: the key is the identity', () => {
    // A new sitting of an equal key joins whatever its media's length (ingest does the same);
    // a caller judges the media of a key that differs.
    const dated: Viewing = {
      ...film({ year: 2000 }),
      elementDurationSeconds: 1000,
      lastElementDuration: 1000,
      durationSeconds: 1000,
    };
    const same = read({ kind: 'movie', title: 'Film', year: 2000 });
    const longer: MediaLength = { stated: null, element: 9000 };
    expect(lengthsAgree(dated, longer)).toBe(false);
    expect(sameTitleRefinement(dated, same, null, longer)).toBe(true);
    expect(sameTitleRefinement(dated, same, null, unknown)).toBe(true);
    // The same title seen on a service is no equal key.
    expect(sameTitleRefinement(dated, same, 'netflix', unknown)).toBe(false);
  });

  test('the service’s own title id on one side only is the same title, for that service', () => {
    const plain = episode({});
    expect(plain.key).toBe('netflix/ep:show:1:2');
    expect(
      sameTitleRefinement(
        plain,
        read({ kind: 'episode', showTitle: 'Show', season: 1, episode: 2, providerIds: id81 }),
        'netflix',
        shown,
      ),
    ).toBe(true);
    const owned = episode({ providerIds: id81 });
    expect(owned.key).toBe('svc:netflix:81');
    expect(
      sameTitleRefinement(
        owned,
        read({ kind: 'episode', showTitle: 'Show', season: 1, episode: 2 }),
        'netflix',
        shown,
      ),
    ).toBe(true);
    // Two ids of the title disagree: two titles.
    expect(
      sameTitleRefinement(
        owned,
        read({ kind: 'episode', showTitle: 'Show', season: 1, episode: 2, providerIds: id82 }),
        'netflix',
        unknown,
      ),
    ).toBe(false);
    // Another service's id never refines this service's viewing.
    expect(
      sameTitleRefinement(
        plain,
        read({ kind: 'episode', showTitle: 'Show', season: 1, episode: 2, providerIds: id81 }),
        'apple-tv',
        unknown,
      ),
    ).toBe(false);
    // Another episode is another title.
    expect(
      sameTitleRefinement(
        plain,
        read({ kind: 'episode', showTitle: 'Show', season: 1, episode: 3 }),
        'netflix',
        unknown,
      ),
    ).toBe(false);
  });

  test('joinTarget: as is when the reading joins, re-keyed when it refines, null for another title', () => {
    const noYear = film({});
    const dated = read({ kind: 'movie', title: 'Film', year: 2000 });
    const finer = joinTarget(noYear, dated, null, shown);
    expect(finer).toEqual({ ...noYear, key: 'mv:film:2000' });
    const withYear = film({ year: 2000 });
    expect(joinTarget(withYear, read({ kind: 'movie', title: 'Film' }), null, shown)).toBe(
      withYear,
    );
    expect(
      joinTarget(withYear, read({ kind: 'movie', title: 'Film', year: 2021 }), null, shown),
    ).toBeNull();
    const plain = episode({});
    expect(
      joinTarget(
        plain,
        read({ kind: 'episode', showTitle: 'Show', season: 1, episode: 2, providerIds: id81 }),
        'netflix',
        shown,
      )?.key,
    ).toBe('svc:netflix:81');
    // Undecided (no length shown): neither way — no re-key, no join.
    expect(joinTarget(noYear, dated, null, unknown)).toBeNull();
    expect(joinTarget(withYear, read({ kind: 'movie', title: 'Film' }), null, unknown)).toBeNull();
  });

  test('joinTarget: the carry never puts one title’s id on a reading of another title', () => {
    // The carry would restore id 81 onto episode 3, which then "names" the viewing's key.
    const owned = episode({ providerIds: id81 });
    expect(
      joinTarget(
        owned,
        read({ kind: 'episode', showTitle: 'Show', season: 1, episode: 3 }),
        'netflix',
        unknown,
      ),
    ).toBeNull();
  });

  test('titleKey: what every refinement of one title shares', () => {
    expect(titleKey(read({ kind: 'movie', title: 'The Film', year: 2000 }))).toBe('mv:the film');
    expect(titleKey(read({ kind: 'movie', title: 'The Film', providerIds: id81 }))).toBe(
      'mv:the film',
    );
    expect(titleKey(read({ kind: 'episode', showTitle: 'Show', season: 1, episode: 2 }))).toBe(
      'ep:show:1:2',
    );
    expect(titleKey(read({ kind: 'episode', showTitle: 'Show', season: 1 }))).toBeNull();
    expect(titleKey(read({ kind: 'movie', providerIds: id81 }))).toBeNull();
  });
});

describe('a refinement joins only when the media lengths agree', () => {
  // Dune (1984) runs 137 minutes; Dune (2021) runs 155.
  const DUNE_1984 = 8220;
  const DUNE_2021 = 9300;
  const unknown: MediaLength = { stated: null, element: null };
  const element = (seconds: number): MediaLength => ({ stated: null, element: seconds });
  const stated = (seconds: number): MediaLength => ({ stated: seconds, element: null });
  const read = (r: Partial<MergedReading>): MergedReading => ({ sources: ['json-ld'], ...r });

  /** A film viewing with these lengths on record. */
  const filmWith = (o: {
    year?: number;
    stated?: number | null;
    element?: number | null;
  }): Viewing => {
    const base = must(
      newViewing({
        id: 'v',
        serviceId: null,
        reading: {
          kind: 'movie',
          title: 'Dune',
          sources: ['json-ld'],
          ...(o.year === undefined ? {} : { year: o.year }),
        },
        at: 0,
        incognito: false,
      }),
    );
    const s = o.stated ?? null;
    const e = o.element ?? null;
    return {
      ...base,
      statedDurationSeconds: s,
      elementDurationSeconds: e,
      lastElementDuration: e,
      durationSeconds: s ?? e,
    };
  };

  test('the constants: max(60 s, 2 % of the longer)', () => {
    expect(SAME_LENGTH_FLOOR_S).toBe(60);
    expect(SAME_LENGTH_SHARE).toBe(0.02);
  });

  test('lengthsAgree: within max(60 s, 2 % of the longer), either way; unknown is no verdict', () => {
    const short = filmWith({ element: 1000 });
    expect(lengthsAgree(short, element(1060))).toBe(true);
    expect(lengthsAgree(short, element(1061))).toBe(false);
    expect(lengthsAgree(short, element(940))).toBe(true);
    expect(lengthsAgree(short, element(939))).toBe(false);
    const long = filmWith({ element: 9000 });
    // 2 % of 9180 is 183.6: a 180 s difference agrees; 2 % of 9200 is 184 < 200.
    expect(lengthsAgree(long, element(9180))).toBe(true);
    expect(lengthsAgree(long, element(9200))).toBe(false);
    expect(lengthsAgree(filmWith({ element: 9180 }), element(9000))).toBe(true);
    expect(lengthsAgree(filmWith({ element: 9200 }), element(9000))).toBe(false);
    // The seen length unknown: no verdict. The bound one unknown: it agrees.
    expect(lengthsAgree(long, unknown)).toBeNull();
    expect(lengthsAgree(filmWith({}), unknown)).toBeNull();
    expect(lengthsAgree(filmWith({}), element(DUNE_2021))).toBe(true);
    expect(lengthsAgree(filmWith({}), stated(DUNE_2021))).toBe(true);
  });

  test('like with like: a statement against a statement, the element against the element', () => {
    // A stitched stream: the element is the content plus its ad breaks.
    const stitched = filmWith({ stated: 7200, element: 7680 });
    expect(lengthsAgree(stitched, element(7680))).toBe(true);
    expect(lengthsAgree(stitched, { stated: 7200, element: 7680 })).toBe(true);
    expect(lengthsAgree(stitched, { stated: 7210, element: 9300 })).toBe(true);
    expect(lengthsAgree(stitched, element(9300))).toBe(false);
    expect(lengthsAgree(stitched, stated(9300))).toBe(false);
    // Only a statement on one side and only the element on the other: those two.
    const statedOnly = filmWith({ stated: 7200 });
    expect(lengthsAgree(statedOnly, element(7230))).toBe(true);
    expect(lengthsAgree(statedOnly, element(9300))).toBe(false);
    expect(lengthsAgree(filmWith({ element: 7200 }), stated(9300))).toBe(false);
  });

  test('mediaLength: an ad’s length, a short clip’s and an unusable number are unknown', () => {
    const s = (o: Partial<PlaybackSample>): PlaybackSample =>
      sample({ at: 0, position: 0, duration: DUNE_2021, ...o });
    expect(mediaLength(s({}), read({}))).toEqual(element(DUNE_2021));
    expect(mediaLength(s({ adPlaying: true }), read({}))).toEqual(unknown);
    expect(mediaLength(s({}), read({ adPlaying: true }))).toEqual(unknown);
    // A statement is the content's even while an ad plays.
    expect(mediaLength(s({ adPlaying: true }), read({ contentDurationSeconds: 7200 }))).toEqual(
      stated(7200),
    );
    expect(mediaLength(s({ duration: 30 }), read({ contentDurationSeconds: 90 }))).toEqual(unknown);
    expect(mediaLength(s({ duration: MIN_CONTENT_SECONDS }), read({}))).toEqual(
      element(MIN_CONTENT_SECONDS),
    );
    expect(mediaLength(s({ duration: null }), read({}))).toEqual(unknown);
    for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      expect(mediaLength(s({ duration: odd }), read({ contentDurationSeconds: odd }))).toEqual(
        unknown,
      );
    }
  });

  test('a bound length that is an ad’s (a pre-roll agreed on twice) is no length to judge by', () => {
    const preRoll = filmWith({ element: 30 });
    expect(lengthsAgree(preRoll, element(DUNE_1984))).toBe(true);
  });

  test('a yearless film, then a remake with its year at another length: another film', () => {
    const yearless = filmWith({ element: DUNE_1984 });
    const remake = read({ kind: 'movie', title: 'Dune', year: 2021 });
    expect(sameTitleRefinement(yearless, remake, null, element(DUNE_2021))).toBe(false);
    expect(joinTarget(yearless, remake, null, element(DUNE_2021))).toBeNull();
    // The same length: the year appearing for the same film re-keys it.
    expect(sameTitleRefinement(yearless, remake, null, element(DUNE_1984 + 30))).toBe(true);
    expect(joinTarget(yearless, remake, null, element(DUNE_1984))?.key).toBe('mv:dune:2021');
    // Unknown: undecided — it neither joins nor re-keys.
    expect(sameTitleRefinement(yearless, remake, null, unknown)).toBeNull();
    expect(joinTarget(yearless, remake, null, unknown)).toBeNull();
  });

  test('a film with its year, then a yearless page at another length: another film', () => {
    const dated = filmWith({ year: 2021, element: DUNE_2021 });
    const older = read({ kind: 'movie', title: 'Dune' });
    expect(sameTitleRefinement(dated, older, null, element(DUNE_1984))).toBe(false);
    // The carry would restore the year and make it "join as it is".
    expect(joinTarget(dated, older, null, element(DUNE_1984))).toBeNull();
    expect(joinTarget(dated, older, null, element(DUNE_2021))).toBe(dated);
    // A coarser reading is undecided too while the length is unknown.
    expect(joinTarget(dated, older, null, unknown)).toBeNull();
  });

  test('a reading of the viewing’s own key, or of nothing, is never judged by its length', () => {
    const dated = filmWith({ year: 2021, element: DUNE_2021 });
    expect(
      joinTarget(dated, read({ kind: 'movie', title: 'Dune', year: 2021 }), null, element(5000)),
    ).toBe(dated);
    expect(joinTarget(dated, read({ contentEnded: true }), null, element(5000))).toBe(dated);
  });

  test('momentOf: the end, the ad and the stated length — nothing the reading names', () => {
    const remake = read({
      kind: 'movie',
      title: 'Dune',
      year: 2021,
      providerIds: [{ level: 'title', key: 'videoId', value: '81' }],
      contentEnded: true,
      adPlaying: false,
      contentDurationSeconds: DUNE_2021,
    });
    expect(momentOf(remake)).toEqual({
      contentEnded: true,
      adPlaying: false,
      contentDurationSeconds: DUNE_2021,
      sources: [],
    });
    expect(momentOf(read({ kind: 'movie', title: 'Dune', year: 2021 }))).toEqual({ sources: [] });
    // Applied to the yearless viewing, it keeps the viewing's key.
    expect(readingJoins(filmWith({ element: DUNE_2021 }), momentOf(remake))).toBe(true);
  });

  test('an episode whose service id appears at another length is another episode', () => {
    const plain = must(
      newViewing({
        id: 'v',
        serviceId: 'netflix',
        reading: { kind: 'episode', showTitle: 'Show', season: 1, episode: 1, sources: ['module'] },
        at: 0,
        incognito: false,
      }),
    );
    const timed: Viewing = { ...plain, elementDurationSeconds: 1320, durationSeconds: 1320 };
    const withId = read({
      kind: 'episode',
      showTitle: 'Show',
      season: 1,
      episode: 1,
      providerIds: [{ level: 'title', key: 'videoId', value: '81' }],
    });
    expect(sameTitleRefinement(timed, withId, 'netflix', element(1800))).toBe(false);
    expect(sameTitleRefinement(timed, withId, 'netflix', element(1330))).toBe(true);
  });
});
