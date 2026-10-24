/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The numbers an address holds that are no season and episode: years, ids, resolutions, codecs,
// audio channels, dates, file types, a show's own id, one half of a pair alone. Each is read as
// nothing. And any address built of letters and digits in which no word of `ADDRESS_FORMS`
// stands on its own names nothing, whatever the numbers.

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { ADDRESS_FORMS, addressNumbers } from './address';

const SEED = 20_261_023;

const at = (over: { pathname?: string; query?: Record<string, string>; hash?: string }) => ({
  hostname: 'series.example',
  pathname: '/',
  query: {},
  hash: '',
  ...over,
});

const NEVER: Readonly<Record<string, readonly string[]>> = {
  years: ['/show-2025-latest', '/2019-2025/', '/films/2025', '/watch/name-2020', '/s/2025'],
  ids: [
    '/80823-temnyy-demon',
    '/80823-temnyy-demon-2025-latest/56-dublyazh/',
    '/watch/221',
    '/title/tt0903747',
    '/v/12-ozvuchka/3-studio',
    '#t:221',
  ],
  resolutions: [
    '/1080p',
    '/720p',
    '/2160p',
    '/4k',
    '/8K',
    '/1920x1080',
    '/1280x720',
    '/640x480',
    '/3840x2160',
    '/full-hd-1080p-x265',
  ],
  codecs: ['/h264', '/h265', '/x264', '/x265', '/hevc', '/av1', '/vp9', '/web-dl-x264-aac'],
  audio: ['/5.1', '/7.1', '/2.0', '/ddp5.1', '/aac2.0', '/dts-hd-7.1', '/atmos-5.1.2'],
  'tests and buckets': ['/e2e', '/s3', '/s3/bucket/e2e', '/tests/e2e/s3', '/assets/s3-e2e'],
  files: ['/video.mp4', '/mp4', '/audio.mp3', '/stream.m3u8', '/360p.mp4', '/h264.mkv'],
  dates: ['/2025-10-23', '/23.10.2025', '/2025/10/23', '#2025-10-23T12:00'],
  'the show itself': ['/series/123/episode/4', '/serie/123', '/show/123/ep/4', '/title/5/e/1'],
  'words without numbers': ['/season-pass', '/episode-guide', '/season/finale/episode/pilot'],
  // An episode alone is not read: on a site without a module, an episode's key needs its season.
  'one half alone': [
    '/season-5',
    '/episode-1',
    '/s5',
    '/ep12',
    '/watch/show-episode-12',
    '/1-season',
    '/12-seriya',
    '#episode=3',
  ],
  'a letter glued on': ['/s1e2b', '/as1e2', '/class5e1', '/1s5e1', '/1-seasons/2-episodes'],
  times: ['#t=120', '#t=1h2m', '/watch?v=x#at=95'],
  versions: ['/v1.2.3', '/v2/e1', '/api/v1/s/2'],
};

describe.each(Object.entries(NEVER))('never a pair: %s', (_kind, addresses) => {
  test.each(addresses)('%s names nothing', (address) => {
    const [pathname = '/', hash = ''] = address.startsWith('#') ? ['/', address] : [address];
    expect(addressNumbers(at({ pathname, hash }))).toBeNull();
  });
});

test.each([
  { s: 'breaking bad' },
  { s: '5', e: 'x' },
  { ep: '12' },
  { season: '2025-26', episode: '1' },
  { e: '1', page: '5' },
])('a parameter that is not a pair, or not digits, names nothing: %j', (query) => {
  expect(addressNumbers(at({ query }))).toBeNull();
});

describe('letters and digits with no word on their own', () => {
  // Every word a form reads, and the `x` between `1x02`'s numbers.
  const WORDS = new Set([
    'x',
    ...ADDRESS_FORMS.flatMap((f) =>
      'pattern' in f
        ? []
        : [...f.season, ...f.episode, ...(f.seasonShort ?? []), ...(f.episodeShort ?? [])],
    ),
  ]);
  const LETTERS = Array.from('abcdefghijklmnopqrstuvwxyzSEXPAéöüісезонрія');
  const letters = fc
    .string({ unit: fc.constantFrom(...LETTERS), minLength: 1, maxLength: 8 })
    .filter((run) => !WORDS.has(run.toLowerCase()));
  const digits = fc.stringMatching(/^\d{1,7}$/u);
  // Letters and digits in turn, so every run of letters is a whole word of the address.
  const segment = (separators: readonly string[]) =>
    fc
      .tuple(
        fc.boolean(),
        fc.array(fc.tuple(letters, fc.constantFrom(...separators), digits), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.constantFrom(...separators),
      )
      .map(([digitsFirst, runs, join]) =>
        runs.map(([l, sep, d]) => (digitsFirst ? `${d}${sep}${l}` : `${l}${sep}${d}`)).join(join),
      );

  test('never make a pair, in the path, the query or the hash', () => {
    fc.assert(
      fc.property(
        fc.array(segment(['', '-', '_', '.', ':', '=']), { minLength: 1, maxLength: 5 }),
        segment(['', '-', '_', '.', ':', '=', '&', '?', ';', '/']),
        fc.dictionary(letters, digits, { maxKeys: 4 }),
        (segments, hash, query) => {
          const pathname = `/${segments.join('/')}`;
          expect(addressNumbers(at({ pathname, hash: `#${hash}`, query })), pathname).toBeNull();
        },
      ),
      { seed: SEED, numRuns: 1000 },
    );
  });
});
