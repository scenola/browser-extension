/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A film's or a show's title, as a page writes it: a trailing ` (YYYY)` is the year and not part
// of the name (four digits, within 1870 to 2200); two names joined by exactly one spaced slash
// give the first, the page’s own language’s. An episode’s own title is kept as written. A series
// page names the show, never an episode, and an entry verdict tells a page that plays a film from
// one that names a series without an episode from one that names nothing.

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { entryVerdict } from '../entry-rule';
import { buildPlay } from '../play';
import { mergeReadings } from '../reading';
import { newViewing } from '../viewing';
import { readAddress } from './address';
import { readDocumentTitle } from './document-title';
import { snapshot } from './fixtures';
import { readGeneric } from './index';
import { findSubject, readJsonLd } from './json-ld';
import { readMediaSession } from './media-session';
import { readOpenGraph } from './open-graph';
import { workTitle } from './shared';

const SEED = 20_261_023;

const value = (r: object | null, key: string): unknown =>
  (r as Record<string, { value: unknown } | undefined> | null)?.[key]?.value;

describe('a trailing year', () => {
  test.each([
    ['Name (2020)', 'Name', 2020],
    ['Name   (2020)', 'Name', 2020],
    ['  Name (2020)  ', 'Name', 2020],
    ['A Name (With Words) (1999)', 'A Name (With Words)', 1999],
    ['Name (1870)', 'Name', 1870],
    ['Name (2200)', 'Name', 2200],
  ])('%j is %j, year %i', (raw, name, year) => {
    expect(workTitle(raw)).toEqual({ name, year });
  });

  test.each([
    ['Name (1869)', 'the year before the bounds'],
    ['Name (2201)', 'the year after the bounds'],
    ['Name (0999)', 'a year with a leading zero'],
    ['Name (202)', 'three digits'],
    ['Name (20200)', 'five digits'],
    ['Name(2020)', 'no space before it'],
    ['Name (2020)!', 'text after it'],
    ['Name (2020', 'no closing bracket'],
    ['Name [2020]', 'square brackets'],
    ['Name 2020', 'no brackets'],
    ['(2020)', 'a year alone'],
    ['Name (abcd)', 'not digits'],
  ])('%j keeps the whole text as the name: %s', (raw) => {
    expect(workTitle(raw)).toEqual({ name: raw.trim() });
  });

  test('a year is stripped exactly when it is within the bounds', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1000, max: 9999 }), (year) => {
        const read = workTitle(`Some Name (${String(year)})`);
        if (year >= 1870 && year <= 2200) {
          expect(read).toEqual({ name: 'Some Name', year });
        } else {
          expect(read).toEqual({ name: `Some Name (${String(year)})` });
        }
      }),
      { seed: SEED },
    );
  });
});

describe('two names joined by a spaced slash', () => {
  test.each([
    ['Local name / Original name', 'Local name'],
    ['Киллер с ножницами / Киллер Севен', 'Киллер с ножницами'],
    ['A  /  B', 'A'],
  ])('%j gives the first name, %j', (raw, name) => {
    expect(workTitle(raw)).toEqual({ name });
  });

  test.each([
    ['Fate/Zero'],
    ['Face/Off'],
    ['AC/DC: Let There Be Rock'],
    ['A / B / C'],
    ['A / B / C / D'],
    ['A /B'],
    ['A/ B'],
  ])('%j is kept whole', (raw) => {
    expect(workTitle(raw)).toEqual({ name: raw });
  });

  test('an unspaced slash inside a name is kept when the name is one of two', () => {
    expect(workTitle('Fate/Zero / Fate Zero')).toEqual({ name: 'Fate/Zero' });
  });

  test('the year is read first, then the slash: the first name loses the year', () => {
    expect(workTitle('Local / Original (2020)')).toEqual({ name: 'Local', year: 2020 });
    expect(workTitle('Киллер с ножницами / Киллер Севен (2020)')).toEqual({
      name: 'Киллер с ножницами',
      year: 2020,
    });
  });

  test('a year on the first name is read off it too, as one year', () => {
    expect(workTitle('Local (2020) / Original (2020)')).toEqual({ name: 'Local', year: 2020 });
    expect(workTitle('Local (2020) / Original')).toEqual({ name: 'Local', year: 2020 });
    expect(workTitle('Fate/Zero (2011) / Fate Zero')).toEqual({ name: 'Fate/Zero', year: 2011 });
  });

  test('two different years are no year: neither can be told for the work’s', () => {
    expect(workTitle('Local (2019) / Original (2020)')).toEqual({ name: 'Local' });
  });

  test('a year on a name among more than two is part of the whole name', () => {
    expect(workTitle('A (2020) / B / C')).toEqual({ name: 'A (2020) / B / C' });
  });

  test('a slash with nothing on one side is not two names', () => {
    expect(workTitle('/ B')?.name).toBe('/ B');
    expect(workTitle('A /')?.name).toBe('A /');
  });

  test('a title that is blank, or not text, is nothing', () => {
    for (const x of [undefined, null, '', '   ', 5, {}, []]) expect(workTitle(x)).toBeUndefined();
  });

  test('the name is cut to the 200 code points the wire takes', () => {
    const long = 'é'.repeat(300);
    expect(Array.from(workTitle(`${long} (2020)`)?.name ?? '')).toHaveLength(200);
    expect(Array.from(workTitle(`${long} / Other`)?.name ?? '')).toHaveLength(200);
  });
});

describe('every generic reader reads a work’s title the same way', () => {
  const RAW = 'Local name / Original name (2020)';

  test('JSON-LD: a Movie’s name, a series’ name', () => {
    const movie = readJsonLd(snapshot({ jsonLd: [{ '@type': 'Movie', name: RAW }] }));
    expect([value(movie, 'title'), value(movie, 'year')]).toEqual(['Local name', 2020]);
    const series = readJsonLd(snapshot({ jsonLd: [{ '@type': 'TVSeries', name: RAW }] }));
    expect([value(series, 'showTitle'), value(series, 'showYear')]).toEqual(['Local name', 2020]);
    const episode = readJsonLd(
      snapshot({ jsonLd: [{ '@type': 'TVEpisode', name: 'E', partOfSeries: { name: RAW } }] }),
    );
    expect([value(episode, 'showTitle'), value(episode, 'showYear')]).toEqual(['Local name', 2020]);
  });

  test('Open Graph: a film’s title, a series page’s title, the episode’s series', () => {
    const movie = readOpenGraph(
      snapshot({ openGraph: { 'og:type': 'video.movie', 'og:title': RAW } }),
    );
    expect([value(movie, 'title'), value(movie, 'year')]).toEqual(['Local name', 2020]);
    for (const type of ['video.tv_series', 'video.tv_show']) {
      const series = readOpenGraph(snapshot({ openGraph: { 'og:type': type, 'og:title': RAW } }));
      expect([value(series, 'showTitle'), value(series, 'showYear')]).toEqual(['Local name', 2020]);
      expect(value(series, 'title')).toBeUndefined();
    }
    const episode = readOpenGraph(
      snapshot({ openGraph: { 'og:type': 'video.episode', 'video:series': RAW } }),
    );
    expect([value(episode, 'showTitle'), value(episode, 'showYear')]).toEqual(['Local name', 2020]);
  });

  test('the document title: the show before an episode label', () => {
    const read = readDocumentTitle(snapshot({ documentTitle: `${RAW} - S1E2` }));
    expect([value(read, 'showTitle'), value(read, 'showYear'), value(read, 'season')]).toEqual([
      'Local name',
      2020,
      1,
    ]);
  });

  test('the Media Session: a title with no label is a work’s; with a label it is the episode’s', () => {
    const plain = readMediaSession(snapshot({ mediaSession: { title: RAW } }));
    expect([value(plain, 'title'), value(plain, 'year')]).toEqual(['Local name', 2020]);
    const labelled = readMediaSession(
      snapshot({ mediaSession: { title: 'S1:E2 A / B (2020)', album: RAW } }),
    );
    // The label's title is the episode's own: kept as written.
    expect(value(labelled, 'title')).toBe('S1:E2 A / B (2020)');
    expect([value(labelled, 'showTitle'), value(labelled, 'showYear')]).toEqual([
      'Local name',
      2020,
    ]);
  });
});

describe('an episode’s own title is kept as the page writes it', () => {
  test('Open Graph’s title on an episode’s page, and on a page of no kind', () => {
    const episode = readOpenGraph(
      snapshot({ openGraph: { 'og:type': 'video.episode', 'og:title': 'Pilot / Pilote (2008)' } }),
    );
    expect(value(episode, 'title')).toBe('Pilot / Pilote (2008)');
    expect(value(episode, 'year')).toBeUndefined();
    const other = readOpenGraph(
      snapshot({ openGraph: { 'og:type': 'video.other', 'og:title': 'Pilot / Pilote (2008)' } }),
    );
    expect(value(other, 'title')).toBe('Pilot / Pilote (2008)');
  });

  test('JSON-LD’s TVEpisode name', () => {
    const read = readJsonLd(
      snapshot({ jsonLd: [{ '@type': 'TVEpisode', name: 'Pilot / Pilote (2008)' }] }),
    );
    expect(value(read, 'episodeTitle')).toBe('Pilot / Pilote (2008)');
    expect(value(read, 'showTitle')).toBeUndefined();
  });
});

describe('the year a page states wins over the one in the title', () => {
  test('JSON-LD’s datePublished, then dateCreated, then the title’s', () => {
    const year = (node: object) =>
      value(
        readJsonLd(snapshot({ jsonLd: [{ '@type': 'Movie', name: 'Name (2000)', ...node }] })),
        'year',
      );
    expect(year({ datePublished: '2010-05-01', dateCreated: '2005' })).toBe(2010);
    expect(year({ dateCreated: '2005-01-01' })).toBe(2005);
    expect(year({})).toBe(2000);
    // A stated date outside the bounds is no year: the title's stands.
    expect(year({ datePublished: '1066-01-01' })).toBe(2000);
  });

  test('a stated year does not put the title’s back into the name', () => {
    const read = readJsonLd(
      snapshot({ jsonLd: [{ '@type': 'Movie', name: 'Name (2000)', datePublished: '2010' }] }),
    );
    expect(value(read, 'title')).toBe('Name');
  });

  test('a series’ startDate', () => {
    const read = readJsonLd(
      snapshot({ jsonLd: [{ '@type': 'TVSeries', name: 'Show (2000)', startDate: '2012-09-01' }] }),
    );
    expect(value(read, 'showYear')).toBe(2012);
  });

  test('Open Graph’s video:release_date for a film', () => {
    const read = readOpenGraph(
      snapshot({
        openGraph: {
          'og:type': 'video.movie',
          'og:title': 'Name (2000)',
          'video:release_date': '2010-05-01',
        },
      }),
    );
    expect([value(read, 'title'), value(read, 'year')]).toEqual(['Name', 2010]);
  });

  test('an episode’s release date is when it aired, not the work’s year', () => {
    const read = readOpenGraph(
      snapshot({
        openGraph: { 'og:type': 'video.episode', 'video:release_date': '2010-05-01' },
      }),
    );
    expect(value(read, 'year')).toBeUndefined();
  });
});

describe('a series page', () => {
  const series = [
    [
      'Open Graph video.tv_series',
      { openGraph: { 'og:type': 'video.tv_series', 'og:title': 'Show' } },
    ],
    ['Open Graph video.tv_show', { openGraph: { 'og:type': 'video.tv_show', 'og:title': 'Show' } }],
    ['JSON-LD TVSeries', { jsonLd: [{ '@type': 'TVSeries', name: 'Show' }] }],
    ['a TVSeries in a graph', { jsonLd: [{ '@graph': [{ '@type': 'TVSeries', name: 'Show' }] }] }],
    [
      'a TVSeries among several types',
      { jsonLd: [{ '@type': ['Thing', 'TVSeries'], name: 'Show' }] },
    ],
  ] as const;

  test.each(series)('%s names the show, and no episode', (_n, over) => {
    const readings = readGeneric(snapshot(over));
    expect(readings).toHaveLength(1);
    const reading = readings[0] ?? {};
    expect(value(reading, 'showTitle')).toBe('Show');
    expect(value(reading, 'title')).toBeUndefined();
    expect(value(reading, 'episodeTitle')).toBeUndefined();
    expect(value(reading, 'kind')).toBeUndefined();
  });

  test.each(series)('%s opens an episode when the address names exactly one', (_n, over) => {
    const page = snapshot({
      ...over,
      url: { hostname: 'series.example', pathname: '/w', query: {}, hash: '#s:5-e:1' },
    });
    expect(entryVerdict(page)).toBe('passes');
    expect(mergeReadings(null, readGeneric(page))).toMatchObject({
      kind: 'episode',
      showTitle: 'Show',
      season: 5,
      episode: 1,
    });
  });

  test.each(series)(
    '%s with no pair in its address is a series page with no episode',
    (_n, over) => {
      expect(entryVerdict(snapshot(over))).toBe('series');
    },
  );

  test.each(series)(
    '%s with two different pairs in its address is a series page with no episode',
    (_n, over) => {
      const page = snapshot({
        ...over,
        url: { hostname: 'series.example', pathname: '/s1e1', query: {}, hash: '#s2e2' },
      });
      expect(entryVerdict(page)).toBe('series');
    },
  );

  test('the subject finder prefers a TVEpisode or a Movie to a TVSeries, in either order', () => {
    const tvSeries = { '@type': 'TVSeries', name: 'Show' };
    const tvEpisode = { '@type': 'TVEpisode', name: 'Pilot' };
    const movie = { '@type': 'Movie', name: 'Film' };
    expect(findSubject([tvSeries, tvEpisode])?.kind).toBe('episode');
    expect(findSubject([tvEpisode, tvSeries])?.kind).toBe('episode');
    expect(findSubject([tvSeries, movie])?.kind).toBe('movie');
    expect(findSubject([movie, tvSeries])?.kind).toBe('movie');
    expect(findSubject([{ '@graph': [tvSeries, tvEpisode] }])?.kind).toBe('episode');
    expect(findSubject([tvSeries])?.kind).toBe('series');
    expect(findSubject([{ '@type': 'Article' }])).toBeNull();
  });

  test('a series beside an episode: the page is an episode page', () => {
    const page = snapshot({
      jsonLd: [
        { '@type': 'TVSeries', name: 'Show' },
        { '@type': 'TVEpisode', name: 'Pilot' },
      ],
    });
    expect(entryVerdict(page)).toBe('passes');
    expect(value(readJsonLd(page), 'kind')).toBe('episode');
  });
});

describe('the entry verdict', () => {
  const url = (hash: string) => ({ hostname: 'x.example', pathname: '/', query: {}, hash });

  test('passes for a film or an episode the page names, whatever its address holds', () => {
    expect(entryVerdict(snapshot({ jsonLd: [{ '@type': 'Movie' }] }))).toBe('passes');
    expect(entryVerdict(snapshot({ openGraph: { 'og:type': 'video.movie' } }))).toBe('passes');
    expect(entryVerdict(snapshot({ documentTitle: 'Dark S1E2' }))).toBe('passes');
    expect(entryVerdict(snapshot({ mediaSession: { title: 'S1E2' } }))).toBe('passes');
  });

  test('is silent for a page that names no film, episode or series, even with numbers in its address', () => {
    expect(entryVerdict(snapshot())).toBe('silent');
    expect(entryVerdict(snapshot({ url: url('#s5e1') }))).toBe('silent');
    expect(
      entryVerdict(snapshot({ openGraph: { 'og:type': 'video.other' }, url: url('#s5e1') })),
    ).toBe('silent');
    expect(entryVerdict(snapshot({ openGraph: { 'og:type': 'article' }, url: url('#s5e1') }))).toBe(
      'silent',
    );
  });

  test('is "series" for a series page whose address names no single episode', () => {
    const og = { openGraph: { 'og:type': 'video.tv_series' } };
    expect(entryVerdict(snapshot({ ...og, url: url('') }))).toBe('series');
    expect(entryVerdict(snapshot({ ...og, url: url('#s1e1&s1e2') }))).toBe('series');
    expect(entryVerdict(snapshot({ ...og, url: url('#s1e0') }))).toBe('series');
    expect(entryVerdict(snapshot({ ...og, url: url('#s10001e1') }))).toBe('series');
  });

  test('is "passes" for a series page whose address names exactly one episode, including season 0', () => {
    const og = { openGraph: { 'og:type': 'video.tv_series' } };
    expect(entryVerdict(snapshot({ ...og, url: url('#s0e3') }))).toBe('passes');
    expect(entryVerdict(snapshot({ ...og, url: url('#season=5&episode=1') }))).toBe('passes');
  });
});

describe('what a video’s length does to a reading', () => {
  test('Open Graph’s duration tags are not read: the element’s length decides', () => {
    const page = snapshot({
      openGraph: {
        'og:type': 'video.tv_series',
        'og:title': 'Show',
        'og:duration': '900',
        'video:duration': '900',
      },
      url: { hostname: 'x.example', pathname: '/', query: {}, hash: '#s5e1' },
    });
    for (const reading of readGeneric(page)) {
      expect(reading).not.toHaveProperty('contentDurationSeconds');
      expect(JSON.stringify(reading)).not.toContain('900');
    }
    expect(mergeReadings(null, readGeneric(page))).not.toHaveProperty('contentDurationSeconds');
  });
});

describe('the field capture, read end to end', () => {
  test('a series page that names the episode only in its address is an episode of the show', () => {
    const page = snapshot({
      url: { hostname: 'series.example', pathname: '/w/221', query: {}, hash: '#t:221-s:5-e:1' },
      openGraph: {
        'og:type': 'video.tv_series',
        'og:title': 'Киллер с ножницами / Киллер Севен (2020)',
        'og:duration': '900',
      },
    });
    expect(entryVerdict(page)).toBe('passes');
    expect(readAddress(page)).not.toBeNull();
    expect(mergeReadings(null, readGeneric(page))).toEqual({
      kind: 'episode',
      showTitle: 'Киллер с ножницами',
      showYear: 2020,
      season: 5,
      episode: 1,
      sources: ['open-graph', 'address'],
    });
  });

  test('a Media Session title with a year beside it is the show’s year, never the episode’s', () => {
    const page = snapshot({
      url: { hostname: 'series.example', pathname: '/w/221', query: {}, hash: '#t:221-s:5-e:1' },
      openGraph: {
        'og:type': 'video.tv_series',
        'og:title': 'Киллер с ножницами / Киллер Севен (2020)',
      },
      mediaSession: { title: 'Киллер с ножницами (2020)' },
    });
    const reading = mergeReadings(null, readGeneric(page));
    const v = newViewing({ id: 'v', serviceId: null, reading, at: 0, incognito: false });
    if (v === null) throw new Error('the page names an episode');
    const body = buildPlay({ ...v, durationSeconds: 2400, ranges: [[0, 2400]] }, 0, 0);
    expect(body).toMatchObject({
      kind: 'episode',
      show: { title: 'Киллер с ножницами', year: 2020 },
      season_number: 5,
      episode_number: 1,
    });
    expect(body).not.toHaveProperty('year');
  });

  test('a year only the Media Session’s title states is the show’s, sent on the show', () => {
    const page = snapshot({
      url: { hostname: 'series.example', pathname: '/w/221', query: {}, hash: '#t:221-s:5-e:1' },
      openGraph: { 'og:type': 'video.tv_series', 'og:title': 'Киллер с ножницами' },
      mediaSession: { title: 'Киллер с ножницами (2020)' },
    });
    const reading = mergeReadings(null, readGeneric(page));
    expect(reading).toMatchObject({ kind: 'episode', year: 2020 });
    expect(reading).not.toHaveProperty('showYear');
    const v = newViewing({ id: 'v', serviceId: null, reading, at: 0, incognito: false });
    if (v === null) throw new Error('the page names an episode');
    const body = buildPlay({ ...v, durationSeconds: 2400, ranges: [[0, 2400]] }, 0, 0);
    expect(body?.show).toEqual({ title: 'Киллер с ножницами', year: 2020 });
    expect(body).not.toHaveProperty('year');
  });
});
