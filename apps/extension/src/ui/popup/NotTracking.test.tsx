/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// What the popup says when a video plays and the extension does not track it: the site, the
// reason in words, and the one action that helps. A viewing that is bound but cannot become a play
// says so in the same words and offers the same help. The page renders worker states it is handed;
// what the worker puts in them is tested with the worker.

import { DEFAULT_RULE, IGNORED_REASONS } from '@mt/core';
import type { IgnoredReason } from '@mt/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { NowPlaying, PopupState } from '../../messaging/protocol';
import { axe, connectedState, fakeUi } from '../test-harness';
import { Popup } from './Popup';

const NOT_TRACKING: NowPlaying = {
  tabId: 7,
  serviceName: 'Netflix',
  label: '',
  episodeTitle: null,
  progress: null,
  state: 'not_tracking',
  viewingId: null,
  origin: null,
  reason: 'page_silent',
  problem: null,
};

const TRACKING: NowPlaying = {
  ...NOT_TRACKING,
  label: 'Breaking Bad',
  progress: { position: 600, duration: 2880 },
  state: 'tracking',
  viewingId: 'viewing-1',
  reason: null,
};

function popupState(nowPlaying: NowPlaying | null, extra: Partial<PopupState> = {}): PopupState {
  return {
    connection: connectedState(Date.now()),
    nowPlaying,
    waiting: [],
    recent: [],
    unsent: 0,
    pausedUntil: null,
    site: null,
    connectionCheck: null,
    accountRule: DEFAULT_RULE,
    ...extra,
  };
}

const notTracking = (reason: IgnoredReason, serviceName = 'Netflix'): NowPlaying => ({
  ...NOT_TRACKING,
  serviceName,
  reason,
});

/** Everything *Now playing* says. */
function nowPlayingText(): string {
  const section = screen.getByRole('region', { name: /Netflix|films\.example|Now playing/u });
  return section.textContent;
}

const closeWindow = vi.fn();

beforeEach(() => {
  closeWindow.mockReset();
  vi.stubGlobal('close', closeWindow);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a video that plays and is not tracked', () => {
  test('names the site, and gives the reason in words', () => {
    render(<Popup ui={fakeUi(popupState(notTracking('page_silent'))).ui} />);
    expect(screen.getByRole('heading', { name: 'Netflix' })).toBeTruthy();
    expect(nowPlayingText()).toContain("This page doesn't say what's playing");
  });

  test('every reason has words of its own, none of them a message key', () => {
    const seen = new Map<string, IgnoredReason>();
    for (const reason of IGNORED_REASONS) {
      const { unmount } = render(<Popup ui={fakeUi(popupState(notTracking(reason))).ui} />);
      const words = nowPlayingText();
      expect(words.trim().length, reason).toBeGreaterThan(0);
      expect(words, reason).not.toMatch(/popup\.|\{|\}|undefined/u);
      const other = seen.get(words);
      expect(other, `${reason} reads like ${String(other)}`).toBeUndefined();
      seen.set(words, reason);
      unmount();
    }
  });

  test('settling is brief and says the page is being read', () => {
    render(<Popup ui={fakeUi(popupState(notTracking('settling'))).ui} />);
    expect(nowPlayingText()).toContain('Reading the page…');
  });

  test('a paused tab says tracking is paused', () => {
    render(<Popup ui={fakeUi(popupState(notTracking('tracking_paused'))).ui} />);
    expect(nowPlayingText()).toContain('Tracking is paused');
  });

  test('a short video says why it was set aside, and names the 2-minute floor', () => {
    render(<Popup ui={fakeUi(popupState(notTracking('short'))).ui} />);
    expect(nowPlayingText()).toMatch(/2 minutes/u);
  });

  test('a player the extension cannot reach says the sound comes from where it cannot see', () => {
    render(<Popup ui={fakeUi(popupState(notTracking('player_unreachable'))).ui} />);
    expect(nowPlayingText()).toMatch(/can't see it/u);
    expect(nowPlayingText()).toMatch(/embedded from another site/u);
  });

  test('the state line is in a polite live region, so a change is heard', () => {
    render(<Popup ui={fakeUi(popupState(notTracking('page_silent'))).ui} />);
    const line = screen.getByText("This page doesn't say what's playing");
    expect(line.closest('[aria-live="polite"]')).not.toBeNull();
  });
});

describe('the one action that helps', () => {
  test.each<[IgnoredReason, string, string]>([
    ['page_silent', 'Send a page sample', '/options.html#capture'],
    ['series_no_episode', 'Send a page sample', '/options.html#capture'],
    ['service_off', 'Open settings', '/options.html#services'],
  ])(
    '%s: "%s" opens Settings at %s, in a tab of its own, and closes the popup',
    async (reason, name, url) => {
      const create = vi.spyOn(fakeBrowser.tabs, 'create');
      render(<Popup ui={fakeUi(popupState(notTracking(reason))).ui} />);
      fireEvent.click(screen.getByRole('button', { name }));
      expect(create).toHaveBeenCalledWith({ url });
      // The popup closes once the tab is made.
      await waitFor(() => {
        expect(closeWindow).toHaveBeenCalled();
      });
    },
  );

  test.each(
    IGNORED_REASONS.filter((r) => !['page_silent', 'series_no_episode', 'service_off'].includes(r)),
  )('%s offers nothing to press', (reason) => {
    render(<Popup ui={fakeUi(popupState(notTracking(reason))).ui} />);
    const section = screen.getByRole('region', { name: /Netflix/u });
    expect(section.querySelectorAll('button')).toHaveLength(0);
  });

  test('a reason is never beside Skip: there is nothing to skip', () => {
    render(<Popup ui={fakeUi(popupState(notTracking('page_silent'))).ui} />);
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
  });
});

describe('a bound viewing that will not be added', () => {
  test('stays a tracking viewing, says it will not be added, and gives the reason', () => {
    const playing: NowPlaying = { ...TRACKING, problem: 'series_no_episode' };
    render(<Popup ui={fakeUi(popupState(playing)).ui} />);
    // Still the viewing: its title and how far it has got.
    expect(screen.getByText('Breaking Bad')).toBeTruthy();
    expect(screen.getByText(/10 of 48 min/u)).toBeTruthy();
    // In the same words: it will not be added, and why.
    expect(nowPlayingText()).toMatch(/won't be added/iu);
    expect(nowPlayingText()).toContain("This page doesn't say which episode is playing");
    expect(nowPlayingText()).not.toContain('Added at 70 %');
  });

  test('an episode with no numbers offers a page sample in place of Skip', () => {
    const playing: NowPlaying = { ...TRACKING, problem: 'series_no_episode' };
    render(<Popup ui={fakeUi(popupState(playing)).ui} />);
    expect(screen.getByRole('button', { name: 'Send a page sample' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
  });

  test('a viewing with no title offers nothing, and no Skip either', () => {
    const playing: NowPlaying = { ...TRACKING, problem: 'no_title' };
    render(<Popup ui={fakeUi(popupState(playing)).ui} />);
    expect(nowPlayingText()).toContain("This page doesn't name what's playing");
    const section = screen.getByRole('region', { name: /Now playing on Netflix/u });
    expect(section.querySelectorAll('button')).toHaveLength(0);
  });

  test('a viewing that will be added keeps Skip, and says so', () => {
    render(<Popup ui={fakeUi(popupState(TRACKING)).ui} />);
    expect(nowPlayingText()).toContain('Added at 70 %');
    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy();
  });
});

describe('the states a site already has keep their lines', () => {
  test('a site that is not tracked offers Track this site, not a reason', () => {
    const playing: NowPlaying = {
      ...NOT_TRACKING,
      serviceName: 'films.example',
      state: 'not_tracked',
      reason: null,
      origin: 'https://films.example',
    };
    render(<Popup ui={fakeUi(popupState(playing)).ui} />);
    expect(screen.getByText('Not tracked on this site')).toBeTruthy();
    expect(nowPlayingText()).not.toMatch(/doesn't say/u);
  });

  test('a blocked site keeps today’s line', () => {
    const playing: NowPlaying = {
      ...NOT_TRACKING,
      serviceName: 'www.youtube.com',
      state: 'blocked',
      reason: null,
    };
    render(<Popup ui={fakeUi(popupState(playing)).ui} />);
    expect(screen.getByText("Scenola doesn't track this site")).toBeTruthy();
  });
});

describe('accessibility (WCAG 2.2 AA)', () => {
  test.each<[string, NowPlaying]>([
    ['not tracking, with its action', notTracking('page_silent')],
    ['not tracking, with detail', notTracking('player_unreachable')],
    ['a viewing that will not be added', { ...TRACKING, problem: 'series_no_episode' }],
  ])('%s: no axe violations', async (_name, playing) => {
    const { container } = render(<Popup ui={fakeUi(popupState(playing)).ui} />);
    const results = await axe(container);
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
