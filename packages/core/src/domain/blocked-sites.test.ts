/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';
import {
  BLOCKED_HOST_SUFFIXES,
  BLOCKED_TLD_FORMS,
  BLOCKED_TLDS,
  isBlockedHost,
} from './blocked-sites';

test('the blocked domains are exactly .ru and .рф', () => {
  expect(BLOCKED_TLDS).toEqual(['ru', 'рф']);
  expect(BLOCKED_TLD_FORMS).toEqual(['ru', 'рф', 'xn--p1ai']);
});

test.each([
  ['www.youtube.com', true],
  ['youtube.com', true],
  ['m.youtube.com', true],
  ['youtu.be', true],
  ['www.youtube-nocookie.com', true],
  ['evil-youtube.com', false],
  ['notyoutu.be', false],
  ['youtube.com.example.org', false],
  // russian domains: .ru and .рф by the last label only
  ['example.ru', true],
  ['www.kinopoisk.ru', true],
  ['пример.рф', true],
  // .рф as Chrome hands it over (punycode): the same domain
  ['xn--p1ai', true],
  ['example.xn--p1ai', true],
  // only .ru and .рф: other domains are not blocked
  ['example.su', false],
  ['example.moscow', false],
  ['example.xn--p1acf', false],
  // no list of named sites: a host outside those domains is not blocked by name
  ['okko.tv', false],
  ['vk.com', false],
  ['premier.one', false],
  ['netflix.com', false],
  ['www.netflix.com', false],
  ['tv.apple.com', false],
  ['ru.example.com', false],
  ['peru', false],
  ['', false],
])('isBlockedHost(%s) = %s', (host, expected) => {
  expect(isBlockedHost(host)).toBe(expected);
});

test('case and a trailing dot do not get around it', () => {
  expect(isBlockedHost('WWW.YouTube.COM')).toBe(true);
  expect(isBlockedHost('youtube.com.')).toBe(true);
  expect(isBlockedHost('Example.RU.')).toBe(true);
});

test('the data is lowercase, dotless-prefixed and unique', () => {
  const all = [...BLOCKED_HOST_SUFFIXES, ...BLOCKED_TLDS];
  for (const entry of all) {
    expect(entry).toBe(entry.toLowerCase());
    expect(entry.startsWith('.')).toBe(false);
  }
  expect(new Set(all).size).toBe(all.length);
});
