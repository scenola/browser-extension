/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import { IDENTITY_FIELDS, identityOf, mergeReadings, titleProviderId, viewingKey } from './reading';
import type { MergedReading, ServiceReading } from './reading';

const field = <T>(
  value: T,
  confidence: number,
  source: 'module' | 'json-ld' | 'media-session' | 'open-graph' | 'document-title',
) => ({
  value,
  confidence,
  source,
});

describe('mergeReadings', () => {
  test('the module value wins over a more confident generic one', () => {
    const module: ServiceReading = { title: field('Module Title', 0.2, 'module') };
    const generic: ServiceReading[] = [{ title: field('Generic Title', 0.99, 'json-ld') }];
    const merged = mergeReadings(module, generic);
    expect(merged.title).toBe('Module Title');
    expect(merged.sources).toEqual(['module']);
  });

  test('without a module the higher confidence wins', () => {
    const merged = mergeReadings(null, [
      { title: field('Low', 0.3, 'json-ld') },
      { title: field('High', 0.8, 'open-graph') },
    ]);
    expect(merged.title).toBe('High');
    expect(merged.sources).toEqual(['open-graph']);
  });

  test('ties are broken by the source order', () => {
    const merged = mergeReadings(null, [
      { title: field('From OG', 0.5, 'open-graph') },
      { title: field('From JSON-LD', 0.5, 'json-ld') },
      { title: field('From title', 0.5, 'document-title') },
    ]);
    expect(merged.title).toBe('From JSON-LD');
  });

  // A module that answered decides the identity: the generic readers do not fill the identity
  // fields it leaves out. A page's leftover JSON-LD would otherwise name the previous item.
  test('a module that answered fills its identity gaps from no generic reader', () => {
    const merged = mergeReadings({ season: field(2, 0.9, 'module') }, [
      { kind: field('episode', 0.7, 'json-ld'), showTitle: field('Show', 0.7, 'json-ld') },
      { episode: field(5, 0.6, 'media-session') },
    ]);
    expect(merged).toEqual({ season: 2, sources: ['module'] });
  });

  test('plain fields come from the module, else the first generic that has them', () => {
    const merged = mergeReadings({ contentDurationSeconds: 3000 }, [
      { contentDurationSeconds: 10, contentEnded: true },
    ]);
    expect(merged.contentDurationSeconds).toBe(3000);
    expect(merged.contentEnded).toBe(true);
  });

  test('an empty merge has no fields and no sources', () => {
    expect(mergeReadings(null, [])).toEqual({ sources: [] });
  });
});

const merged = (r: Partial<MergedReading>): MergedReading => ({ sources: [], ...r });

describe('viewingKey', () => {
  test('prefers the title-level provider id, then show+numbers, then title+year', () => {
    const base = {
      kind: 'episode' as const,
      showTitle: 'The Show!',
      season: 2,
      episode: 3,
      title: 'Film',
      year: 1999,
    };
    expect(
      viewingKey(
        'netflix',
        merged({
          ...base,
          providerIds: [
            { level: 'show', key: 'id', value: 'S1' },
            { level: 'title', key: 'id', value: 'E9' },
          ],
        }),
      ),
    ).toBe('svc:netflix:E9');
    expect(viewingKey('netflix', merged(base))).toBe('netflix/ep:the show:2:3');
    expect(viewingKey(null, merged({ ...base, kind: 'movie' }))).toBe('mv:film:1999');
    expect(viewingKey(null, merged({ kind: 'movie', title: 'Film' }))).toBe('mv:film:');
  });

  test('names the service: one title on two services, or on a site without a module, is three keys', () => {
    const episode = merged({ kind: 'episode', showTitle: 'Show', season: 1, episode: 2 });
    const film = merged({ kind: 'movie', title: 'Film', year: 2000 });
    const keys = [
      viewingKey('netflix', episode),
      viewingKey('apple-tv', episode),
      viewingKey(null, episode),
    ];
    expect(keys).toEqual(['netflix/ep:show:1:2', 'apple-tv/ep:show:1:2', 'ep:show:1:2']);
    expect(viewingKey('netflix', film)).toBe('netflix/mv:film:2000');
    expect(viewingKey(null, film)).toBe('mv:film:2000');
  });

  test('a provider id without a service falls through to the descriptive key', () => {
    const r = merged({
      kind: 'movie',
      title: 'Film',
      providerIds: [{ level: 'title', key: 'id', value: 'X' }],
    });
    expect(viewingKey(null, r)).toBe('mv:film:');
  });

  test('null without a kind or without any identifier', () => {
    expect(viewingKey('s', merged({ title: 'Film' }))).toBeNull();
    expect(viewingKey('s', merged({ kind: 'movie' }))).toBeNull();
    expect(viewingKey('s', merged({ kind: 'episode', showTitle: 'Show' }))).toBeNull();
    expect(viewingKey('s', merged({ kind: 'episode', season: 1, episode: 1 }))).toBeNull();
  });

  // Identity is the key's equality, and an unidentified reading has no key.
  test('two spellings of one title share a key, two years do not, and nothing identified has none', () => {
    const a = merged({ kind: 'movie', title: 'Film', year: 2000 });
    expect(viewingKey(null, a)).toBe(
      viewingKey(null, merged({ kind: 'movie', title: 'FILM', year: 2000 })),
    );
    expect(viewingKey(null, a)).not.toBe(
      viewingKey(null, merged({ kind: 'movie', title: 'Film', year: 2001 })),
    );
    expect(viewingKey(null, merged({}))).toBeNull();
  });
});

describe('the identity fields are one list', () => {
  const f = <T>(value: T) => field(value, 0.9, 'module');
  const full: ServiceReading = {
    kind: f('episode'),
    title: f('Title'),
    showTitle: f('Show'),
    episodeTitle: f('Pilot'),
    season: f(1),
    episode: f(2),
    year: f(2000),
    showYear: f(1999),
    ids: f({ imdb: 'tt0000001' }),
    showIds: f({ tmdb: 5 }),
    providerIds: [{ level: 'title', key: 'videoId', value: '1' }],
    contentEnded: true,
    adPlaying: false,
    contentDurationSeconds: 3000,
    creditsStartSeconds: 2900,
    introEndSeconds: 60,
  };

  test('identityOf keeps every identity field and nothing that is about the moment', () => {
    expect(identityOf(full)).toEqual({
      kind: f('episode'),
      title: f('Title'),
      showTitle: f('Show'),
      episodeTitle: f('Pilot'),
      season: f(1),
      episode: f(2),
      year: f(2000),
      showYear: f(1999),
      ids: f({ imdb: 'tt0000001' }),
      showIds: f({ tmdb: 5 }),
    });
    expect(identityOf({ contentEnded: true })).toEqual({});
  });

  test('a module that answered decides every field on the list: the generic readers fill none of them', () => {
    const generic = Object.fromEntries(
      IDENTITY_FIELDS.map((key) => [key, full[key] && { ...full[key], source: 'json-ld' }]),
    ) as ServiceReading;
    const r = mergeReadings({ contentEnded: false }, [generic]);
    for (const key of IDENTITY_FIELDS) expect(r[key]).toBeUndefined();
  });

  test("titleProviderId reads a module's own reading as it reads a merged one", () => {
    expect(titleProviderId(full)).toBe('1');
    expect(titleProviderId(mergeReadings(full, []))).toBe('1');
  });
});
