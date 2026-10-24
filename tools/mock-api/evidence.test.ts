/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import { isoformatUtc, parseDateTime } from './datetime.ts';
import { playEvidenceErrors, tokenFormErrors } from './evidence.ts';

/** The error types a body earns, sorted — `ok` when it passes. */
function verdict(body: unknown): string {
  const { errors, count } = playEvidenceErrors(body);
  return count === 0 ? 'ok' : [...new Set(errors.map((e) => e.type))].sort().join(',');
}

const provider = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ namespace: 'p', key: 'k', value: String(i) }));

describe('PlayEvidence, as the backend’s model judges it', () => {
  // Each expectation is the backend's own verdict on the body (2026-10-21): the sorted set of
  // its validation error types, or `ok`.
  test.each<[string, unknown, string]>([
    ['a title', { kind: 'movie', title: 'Dune' }, 'ok'],
    ['nothing that identifies', { kind: 'movie' }, 'value_error'],
    ['an empty title', { kind: 'movie', title: '' }, 'string_too_short'],
    ['200 characters', { kind: 'movie', title: 'x'.repeat(200) }, 'ok'],
    ['201 characters', { kind: 'movie', title: 'x'.repeat(201) }, 'string_too_long'],
    ['200 astral characters', { kind: 'movie', title: '😀'.repeat(200) }, 'ok'],
    ['201 astral characters', { kind: 'movie', title: '😀'.repeat(201) }, 'string_too_long'],
    ['an unknown field', { kind: 'movie', title: 'Dune', extra: 1 }, 'extra_forbidden'],
    ['a kind it does not know', { kind: 'show', title: 'Dune' }, 'literal_error'],
    ['tmdb 0', { kind: 'movie', ids: { tmdb: 0 } }, 'greater_than_equal'],
    ['tmdb 1', { kind: 'movie', ids: { tmdb: 1 } }, 'ok'],
    ['tmdb 5.0', { kind: 'movie', ids: { tmdb: 5.0 } }, 'ok'],
    ['tmdb 5.5', { kind: 'movie', ids: { tmdb: 5.5 } }, 'int_from_float'],
    ['empty ids', { kind: 'movie', ids: {} }, 'value_error'],
    ['no provider entries', { kind: 'movie', ids: { provider: [] } }, 'value_error'],
    ['a short imdb', { kind: 'movie', ids: { imdb: 'tt1234' } }, 'string_pattern_mismatch'],
    ['an imdb', { kind: 'movie', ids: { imdb: 'tt12345' } }, 'ok'],
    ['a long imdb', { kind: 'movie', ids: { imdb: 'tt12345678901' } }, 'string_too_long'],
    [
      'a provider entry',
      {
        kind: 'movie',
        ids: { provider: [{ namespace: 'provider.netflix', key: 'contentId', value: '812' }] },
      },
      'ok',
    ],
    [
      'an upper-case namespace',
      {
        kind: 'movie',
        ids: { provider: [{ namespace: 'Provider', key: 'contentId', value: '812' }] },
      },
      'string_pattern_mismatch',
    ],
    [
      'a quote in a value',
      { kind: 'movie', ids: { provider: [{ namespace: 'p', key: 'k', value: 'a"b' }] } },
      'string_pattern_mismatch',
    ],
    [
      'a space in a value',
      { kind: 'movie', ids: { provider: [{ namespace: 'p', key: 'k', value: 'a b' }] } },
      'ok',
    ],
    [
      'a newline in a value',
      { kind: 'movie', ids: { provider: [{ namespace: 'p', key: 'k', value: 'a\nb' }] } },
      'string_pattern_mismatch',
    ],
    [
      'a trailing newline',
      { kind: 'movie', ids: { provider: [{ namespace: 'p', key: 'k', value: 'x\n' }] } },
      'string_pattern_mismatch',
    ],
    ['nine provider entries', { kind: 'movie', ids: { provider: provider(9) } }, 'too_long'],
    [
      'an episode of a titled show',
      { kind: 'episode', show: { title: 'X' }, season_number: 1, episode_number: 2 },
      'ok',
    ],
    ['an empty show', { kind: 'episode', show: {} }, 'value_error'],
    ['a show with a tvdb id', { kind: 'episode', show: { ids: { tvdb: 3 } } }, 'ok'],
    ['year 1869', { kind: 'movie', title: 'D', year: 1869 }, 'greater_than_equal'],
    ['year 2200', { kind: 'movie', title: 'D', year: 2200 }, 'ok'],
    ['an offset', { kind: 'movie', title: 'D', watched_at: '2026-10-20T21:40:00+02:00' }, 'ok'],
    ['Z', { kind: 'movie', title: 'D', watched_at: '2026-10-20T21:40:00Z' }, 'ok'],
    ['no offset', { kind: 'movie', title: 'D', watched_at: '2026-10-20T21:40:00' }, 'value_error'],
    ['no seconds', { kind: 'movie', title: 'D', watched_at: '2026-10-20T21:40+02:00' }, 'ok'],
    ['a space', { kind: 'movie', title: 'D', watched_at: '2026-10-20 21:40:00+02:00' }, 'ok'],
    [
      'nine fraction digits',
      { kind: 'movie', title: 'D', watched_at: '2026-10-20T21:40:00.123456789+02:00' },
      'ok',
    ],
    [
      'February 30',
      { kind: 'movie', title: 'D', watched_at: '2026-02-30T21:40:00Z' },
      'datetime_from_date_parsing',
    ],
    [
      'hour 24',
      { kind: 'movie', title: 'D', watched_at: '2026-10-20T24:00:00Z' },
      'datetime_from_date_parsing',
    ],
    [
      'offset +2400',
      { kind: 'movie', title: 'D', watched_at: '2026-10-20T21:40:00+2400' },
      'datetime_from_date_parsing',
    ],
    ['offset +0200', { kind: 'movie', title: 'D', watched_at: '2026-10-20T21:40:00+0200' }, 'ok'],
    ['a date alone', { kind: 'movie', title: 'D', watched_at: '2026-10-20' }, 'value_error'],
    ['watched_at null', { kind: 'movie', title: 'D', watched_at: null }, 'ok'],
    ['duration 0', { kind: 'movie', title: 'D', duration_seconds: 0 }, 'greater_than_equal'],
    [
      'past a week',
      { kind: 'movie', title: 'D', furthest_position_seconds: 604_801 },
      'less_than_equal',
    ],
    ['season 10001', { kind: 'movie', title: 'D', season_number: 10_001 }, 'less_than_equal'],
    ['nulls', { kind: 'movie', ids: null, show: null, title: 'D' }, 'ok'],
  ])('%s', (_name, body, expected) => {
    expect(verdict(body)).toBe(expected);
  });

  test('__proto__ is a field like any other, and an extra one', () => {
    const body: unknown = JSON.parse('{"kind":"movie","title":"Dune","__proto__":{}}');
    expect(verdict(body)).toBe('extra_forbidden');
  });

  // Where Pydantic's lax mode accepts and the mock refuses: stricter is the safe direction (the
  // backend answered `ok` to each of these).
  test.each<[string, unknown]>([
    ['tmdb "5"', { kind: 'movie', ids: { tmdb: '5' } }],
    ['tmdb true', { kind: 'movie', ids: { tmdb: true } }],
    ['ended "true"', { kind: 'movie', title: 'D', ended: 'true' }],
    ['ended 1', { kind: 'movie', title: 'D', ended: 1 }],
    ['watched_at a number', { kind: 'movie', title: 'D', watched_at: 1_760_000_000 }],
  ])('stricter than the server: %s', (_name, body) => {
    expect(verdict(body)).not.toBe('ok');
  });

  test.each([[[]], ['x'], [null]])('a body that is not an object (%j) is model_type', (body) => {
    expect(verdict(body)).toBe('model_type');
  });

  test('a 422 lists at most 20 entries and counts them all', () => {
    const body: Record<string, unknown> = { kind: 'movie', title: 'D' };
    for (let i = 0; i < 50; i++) body[`extra${String(i)}`] = i;
    const { errors, count } = playEvidenceErrors(body);
    expect(errors).toHaveLength(20);
    expect(count).toBe(50);
  });
});

describe('the token endpoint’s form', () => {
  const form = {
    grant_type: 'authorization_code',
    code: 'c'.repeat(43),
    code_verifier: 'v'.repeat(43),
    redirect_uri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
  };

  test('the four fields pass; another grant, a missing field, a 129-character code do not', () => {
    expect(tokenFormErrors(form).count).toBe(0);
    const typeOf = (over: Record<string, string>) => tokenFormErrors(over).errors[0]?.type;
    expect(typeOf({ ...form, grant_type: 'password' })).toBe('literal_error');
    const noCode: Record<string, string> = { ...form };
    delete noCode.code;
    expect(tokenFormErrors(noCode).errors[0]).toMatchObject({
      loc: ['body', 'code'],
      type: 'missing',
    });
    expect(typeOf({ ...form, code: 'c'.repeat(129) })).toBe('string_too_long');
  });
});

describe('datetimes', () => {
  test('an instant is exact to the microsecond, offsets applied', () => {
    expect(parseDateTime('1970-01-01T00:00:00Z')?.epochMicros).toBe(0n);
    expect(parseDateTime('1970-01-01T01:00:00+01:00')?.epochMicros).toBe(0n);
    expect(parseDateTime('2026-10-21T12:00:00.000001Z')?.epochMicros).toBe(
      BigInt(Date.parse('2026-10-21T12:00:00Z')) * 1000n + 1n,
    );
    expect(parseDateTime('0001-01-01T00:00:00Z')?.epochMicros).toBe(-62_135_596_800_000_000n);
    expect(parseDateTime('0000-01-01T00:00:00Z')).toBeNull();
    expect(parseDateTime(`2026-10-21T12:00:00.${'1'.repeat(60)}Z`)).toBeNull();
  });

  test('isoformat is Python’s for a UTC instant', () => {
    expect(isoformatUtc(Date.parse('2026-09-21T12:00:00Z'))).toBe('2026-09-21T12:00:00+00:00');
    expect(isoformatUtc(Date.parse('2026-09-21T12:00:00.5Z'))).toBe(
      '2026-09-21T12:00:00.500000+00:00',
    );
  });
});
