/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// How the collector follows a frame's address: once per new address, at once after a quiet
// second, and never faster than once a second whatever the page does — the last address always
// reported. A frame with the Navigation API, faked: an event target and an address the test moves.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { watchNavigation } from './navigation';

interface Page {
  readonly view: Window;
  /** The page moves to `href` the way `history.pushState` does: one `currententrychange`. */
  readonly go: (href: string) => void;
}

function page(): Page {
  const location = { href: 'https://www.example.com/watch/0' };
  const navigation = new EventTarget();
  return {
    view: { location, navigation } as unknown as Window,
    go: (href) => {
      location.href = href;
      navigation.dispatchEvent(new Event('currententrychange'));
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

test('a new address is reported at once, and the same address is not reported again', () => {
  const { view, go } = page();
  const seen: string[] = [];
  watchNavigation(view, () => seen.push(view.location.href), new AbortController().signal);

  go('https://www.example.com/watch/1');
  go('https://www.example.com/watch/1');
  expect(seen).toEqual(['https://www.example.com/watch/1']);

  vi.advanceTimersByTime(5_000);
  go('https://www.example.com/watch/2');
  expect(seen).toEqual(['https://www.example.com/watch/1', 'https://www.example.com/watch/2']);
});

test('a page that changes its address in a loop is followed once a second, its last address included', () => {
  const { view, go } = page();
  const seen: string[] = [];
  watchNavigation(view, () => seen.push(view.location.href), new AbortController().signal);

  for (let i = 1; i <= 500; i += 1) go(`https://www.example.com/watch/${String(i)}`);
  expect(seen).toEqual(['https://www.example.com/watch/1']);

  vi.advanceTimersByTime(1_000);
  expect(seen).toEqual(['https://www.example.com/watch/1', 'https://www.example.com/watch/500']);

  vi.advanceTimersByTime(10_000);
  expect(seen).toHaveLength(2);
});

test('nothing is reported once the collector stopped, a change it was holding back included', () => {
  const { view, go } = page();
  const seen: string[] = [];
  const controller = new AbortController();
  watchNavigation(view, () => seen.push(view.location.href), controller.signal);

  go('https://www.example.com/watch/1');
  go('https://www.example.com/watch/2');
  controller.abort();
  vi.advanceTimersByTime(5_000);
  go('https://www.example.com/watch/3');

  expect(seen).toEqual(['https://www.example.com/watch/1']);
});
