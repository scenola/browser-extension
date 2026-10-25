/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// The welcome page. The page talks to a fake worker that answers `ui/connect` with each
// `ConnectResult` and `ui/settings` with the fresh install's settings.

import { DEFAULT_SETTINGS, DEFAULT_RULE } from '@mt/core';
import type { ConnectResult } from '@mt/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { PopupState, UiResponse } from '../../messaging/protocol';
import type { UiAsk } from '../store';
import { axe, connectedState, fakeUi } from '../test-harness';
import { Welcome } from './Welcome';

const NOT_CONNECTED: PopupState = {
  connection: { kind: 'none' },
  nowPlaying: null,
  waiting: [],
  recent: [],
  unsent: 0,
  pausedUntil: null,
  site: null,
  connectionCheck: null,
  accountRule: DEFAULT_RULE,
};

/** A worker whose sign-in ends with `result`. */
function worker(result: ConnectResult) {
  return fakeUi(NOT_CONNECTED, (ask: UiAsk): UiResponse => {
    if (ask.type === 'ui/connect') return { ok: true, data: { result } };
    if (ask.type === 'ui/settings') {
      return {
        ok: true,
        data: {
          ...DEFAULT_SETTINGS,
          ...(ask.patch.allSites === undefined ? {} : { allSites: ask.patch.allSites }),
        },
      };
    }
    return { ok: true };
  });
}

const connected: ConnectResult = { kind: 'connected', state: connectedState(Date.now()) };

beforeEach(() => {
  vi.stubGlobal('close', vi.fn());
  fakeBrowser.action.getUserSettings = vi.fn(() => Promise.resolve({ isOnToolbar: false }));
});

afterEach(() => {
  cleanup();
});

describe('step 1: Connect', () => {
  test('says what it does and what it cannot do', () => {
    render(<Welcome ui={worker(connected).ui} />);
    expect(
      screen.getByText(
        "Adds what you watch to your diary. It can't read your library or anything else.",
      ),
    ).toBeTruthy();
  });

  test('before the Connect button, says what it reads and sends, and links to the inventory', () => {
    render(<Welcome ui={worker(connected).ui} />);
    const data = screen.getByText(
      "While a film or an episode plays on a streaming site, MediaTracker for Chrome reads what the page says it is and how far you've got, and keeps that in this browser. Once you connect, it sends MediaTracker what you watched: its titles, years, season and episode, when you watched it and how far. Never the page's address or anything else you browse.",
    );
    const button = screen.getByRole('button', { name: 'Connect MediaTracker' });
    // Read before the choice it informs: earlier in the page, and the button's description.
    expect(data.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.getAttribute('aria-describedby')?.split(' ')).toContain(data.id);

    const link = screen.getByRole('link', { name: 'Everything it keeps and sends' });
    expect(link.getAttribute('href')).toBe('/options.html#data');
  });

  test('a connect that succeeds advances to step 2, "Where to track"', async () => {
    const page = worker(connected);
    render(<Welcome ui={page.ui} />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect MediaTracker' }));

    expect(await screen.findByRole('heading', { name: 'Where to track' })).toBeTruthy();
    // The development build's strategy is the approval window.
    expect(page.sent).toContainEqual({ type: 'ui/connect', strategy: 'pkce_dpop' });
  });

  test('a cancelled connect stays on step 1 and names MediaTracker Plus', async () => {
    render(<Welcome ui={worker({ kind: 'cancelled' }).ui} />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect MediaTracker' }));

    expect(await screen.findByText(/MediaTracker Plus/u)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Where to track' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect MediaTracker' })).toBeTruthy();
  });

  /** The token endpoint's answers, and the words each is shown by. */
  const ANSWERS: readonly (readonly [ConnectResult['kind'], RegExp, string | null])[] = [
    ['code_invalid', /That took too long — connect again/u, null],
    ['proof_invalid', /connect again/iu, null],
    ['forbidden', /Plus/u, 'http://localhost:3000'],
    [
      'limit_reached',
      /You have ten connected services — remove one in MediaTracker/u,
      'http://localhost:3000/settings?tab=connections',
    ],
    ['unavailable', /MediaTracker didn't answer — try again/u, null],
    ['feature_closed', /available/u, null],
  ];

  test.each(ANSWERS)('%s is said in words', async (kind, words, link) => {
    render(<Welcome ui={worker({ kind } as ConnectResult).ui} />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect MediaTracker' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(words);
    const hrefs = [...alert.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    if (link !== null) expect(hrefs).toContain(link);
  });
});

describe('step 2: Where to track', () => {
  async function stepTwo(page = worker(connected)) {
    render(<Welcome ui={page.ui} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect MediaTracker' }));
    await screen.findByRole('heading', { name: 'Where to track' });
    return { page };
  }

  test('the seven built-in services are listed as already on', async () => {
    await stepTwo();
    for (const name of [
      'Netflix',
      'Apple TV',
      'Prime Video',
      'Disney+',
      'HBO Max',
      'Crunchyroll',
      'Paramount+',
    ]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  test('the step asks for no permission: no all-sites switch, and nothing requested', async () => {
    const request = vi.fn(() => Promise.resolve(true));
    fakeBrowser.permissions.request = request;
    const { page } = await stepTwo();

    expect(screen.queryByRole('switch')).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(page.sent).not.toContainEqual({ type: 'ui/settings', patch: { allSites: true } });
    // It still says how another site is allowed later.
    expect(screen.getByText(/allow that single site later/u)).toBeTruthy();
  });

  test('step 3, Done: "Watch something — it\'s added once you\'ve watched enough of it."', async () => {
    await stepTwo();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByText("Watch something — it's added once you've watched enough of it."),
    ).toBeTruthy();
  });
});

describe('accessibility', () => {
  test('each step: no axe violations', async () => {
    const page = worker({ kind: 'cancelled' });
    const { container } = render(<Welcome ui={page.ui} />);
    expect((await axe(container)).violations.map((v) => v.id)).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Connect MediaTracker' }));
    await screen.findByRole('alert');
    expect((await axe(container)).violations.map((v) => v.id)).toEqual([]);

    cleanup();
    const ok = worker(connected);
    const second = render(<Welcome ui={ok.ui} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect MediaTracker' }));
    await screen.findByRole('heading', { name: 'Where to track' });
    expect((await axe(second.container)).violations.map((v) => v.id)).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText("Watch something — it's added once you've watched enough of it.");
    expect((await axe(second.container)).violations.map((v) => v.id)).toEqual([]);
  });
});
