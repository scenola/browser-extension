/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// *Counting* shows the account's two lines read-only, with one link to the app where they are
// changed (the extension cannot change them); Settings opened at an anchor starts there; and the
// capture screen says what a sample holds, what was removed and where it goes.

import { DEFAULT_RULE } from '@mt/core';
import type { AccountRule } from '@mt/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { PopupState } from '../../messaging/protocol';
import { axe, connectedState, fakeUi, rootUi } from '../test-harness';
import type { UiAsk } from '../store';
import { Options } from './Options';

const T0 = Date.UTC(2026, 9, 22, 19, 40);

function optionsState(rule: AccountRule): PopupState {
  return {
    connection: connectedState(T0),
    nowPlaying: null,
    waiting: [],
    recent: [],
    unsent: 0,
    pausedUntil: null,
    site: null,
    connectionCheck: null,
    accountRule: rule,
  };
}

const SETTINGS = {
  trackIncognito: false,
  allSites: false,
  diagnostics: false,
  disabledServices: [],
  excludedHosts: [],
  allowedHosts: [],
  pausedUntil: null,
};

/** A page whose worker answers settings reads, and captures with `capture`. */
function page(rule: AccountRule, capture?: (ask: UiAsk) => unknown) {
  return fakeUi(optionsState(rule), (ask) => {
    if (ask.type === 'ui/settings') return { ok: true, data: SETTINGS };
    if (ask.type === 'ui/capture' && capture !== undefined) return capture(ask) as never;
    return { ok: true };
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('no network'))),
  );
  fakeBrowser.runtime.getManifest = vi.fn(() => ({
    manifest_version: 3 as const,
    name: 'x',
    version: '0.3.1',
  }));
  fakeBrowser.extension.isAllowedIncognitoAccess = vi.fn(() => Promise.resolve(false));
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const counting = () => screen.getByRole('region', { name: 'Counting' });

describe('Counting: the account’s two lines, read-only', () => {
  test('both lines in words, and one link to the app', () => {
    const rule: AccountRule = {
      startThresholdPercent: 10,
      startFloorSeconds: 300,
      finishThresholdPercent: 70,
    };
    render(<Options ui={page(rule).ui} />);
    const section = within(counting());
    expect(
      section.getByText("A film or an episode is added when you've played 70 % of its story"),
    ).toBeTruthy();
    expect(
      section.getByText('Films you start are saved in progress after 10 % (at least 5 min)'),
    ).toBeTruthy();
    const links = section.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('http://localhost:3000/settings?tab=connections');
  });

  test('nothing in it can be changed here', () => {
    render(<Options ui={page(DEFAULT_RULE).ui} />);
    const section = counting();
    expect(
      section.querySelectorAll('input, select, textarea, [role="switch"], button'),
    ).toHaveLength(0);
  });

  test('starts off: the start line says Off', () => {
    render(<Options ui={page(DEFAULT_RULE).ui} />);
    const section = within(counting());
    expect(section.getByText('Films you start')).toBeTruthy();
    expect(section.getByText('Off')).toBeTruthy();
    expect(section.queryByText(/saved in progress after/u)).toBeNull();
  });

  test('a rule never read, as the worker states it, says 70 % and Off', async () => {
    const worker = await rootUi({ now: T0 });
    render(<Options ui={worker.ui} />);
    const section = within(counting());
    expect(
      section.getByText("A film or an episode is added when you've played 70 % of its story"),
    ).toBeTruthy();
    expect(section.getByText('Off')).toBeTruthy();
  });

  test.each<[string, number, string]>([
    ['a floor in whole minutes', 300, '(at least 5 min)'],
    ['a floor of a minute and a half, unrounded', 90, '(at least 1.5 min)'],
    ['a floor of 45 seconds, unrounded', 45, '(at least 0.75 min)'],
  ])('%s', (_name, floor, tail) => {
    const rule: AccountRule = {
      startThresholdPercent: 5,
      startFloorSeconds: floor,
      finishThresholdPercent: 90,
    };
    render(<Options ui={page(rule).ui} />);
    expect(
      within(counting()).getByText(`Films you start are saved in progress after 5 % ${tail}`),
    ).toBeTruthy();
  });

  test('a floor of 0 drops the "at least" part', () => {
    const rule: AccountRule = {
      startThresholdPercent: 20,
      startFloorSeconds: 0,
      finishThresholdPercent: 90,
    };
    render(<Options ui={page(rule).ui} />);
    const section = within(counting());
    expect(section.getByText('Films you start are saved in progress after 20 %')).toBeTruthy();
    expect(section.queryByText(/at least/u)).toBeNull();
  });

  test.each<50 | 70 | 90>([50, 70, 90])(
    'the finish line of %i %% is said as the account has it',
    (percent) => {
      render(<Options ui={page({ ...DEFAULT_RULE, finishThresholdPercent: percent }).ui} />);
      expect(
        within(counting()).getByText(
          `A film or an episode is added when you've played ${String(percent)} % of its story`,
        ),
      ).toBeTruthy();
    },
  );

  test('there is no threshold setting of its own to choose from', () => {
    render(<Options ui={page(DEFAULT_RULE).ui} />);
    const counting = within(screen.getByRole('region', { name: 'Counting' }));
    expect(counting.queryByRole('radio')).toBeNull();
    expect(counting.queryByRole('combobox')).toBeNull();
    expect(counting.queryByRole('slider')).toBeNull();
  });

  test('no axe violations', async () => {
    const { container } = render(<Options ui={page(DEFAULT_RULE).ui} />);
    const results = await axe(container);
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe('Settings opened at an anchor', () => {
  test('#capture: the capture row’s title is focused', async () => {
    window.location.hash = '#capture';
    render(<Options ui={page(DEFAULT_RULE).ui} />);
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Capture page sample');
    });
  });

  test('#services: the built-in services’ heading is focused', async () => {
    window.location.hash = '#services';
    render(<Options ui={page(DEFAULT_RULE).ui} />);
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Built-in services');
    });
  });

  test('a section’s own anchor is followed the same way, its heading focused', async () => {
    window.location.hash = '#counting';
    render(<Options ui={page(DEFAULT_RULE).ui} />);
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Counting');
    });
    expect(document.activeElement?.tagName).toBe('H2');
  });

  test('an anchor that changes later is followed too', async () => {
    render(<Options ui={page(DEFAULT_RULE).ui} />);
    expect(document.activeElement).toBe(document.body);
    window.location.hash = '#privacy';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Privacy');
    });
  });

  test('an anchor that names nothing changes nothing', () => {
    window.location.hash = '#nowhere';
    render(<Options ui={page(DEFAULT_RULE).ui} />);
    expect(document.activeElement).toBe(document.body);
  });

  test('no anchor: the page opens at the top, focus where it was', () => {
    render(<Options ui={page(DEFAULT_RULE).ui} />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('the capture screen says what a sample holds', () => {
  const sample = (removed: Record<string, number>, used: string[]) => () => ({
    ok: true,
    data: {
      filename: 'netflix-2026-10-23.snapshot.json',
      fixture: { synthetic: false, snapshot: { documentTitle: 'x' }, removed },
      used,
    },
  });

  async function capture(ui: ReturnType<typeof page>['ui']) {
    render(<Options ui={ui} />);
    const row = screen.getByText('Capture page sample').closest('div[id="capture"]');
    expect(row).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    return await screen.findByText('What the sample holds');
  }

  test('one line per part, in plain words', async () => {
    const heading = await capture(page(DEFAULT_RULE, sample({}, [])).ui);
    const items = Array.from(heading.parentElement?.querySelectorAll('li') ?? []).map(
      (li) => li.textContent,
    );
    expect(items).toHaveLength(7);
    for (const [i, name] of [
      'Address',
      'Page title',
      'Open Graph',
      'Structured data',
      'Media Session',
      'Page data',
      'Signals',
    ].entries()) {
      expect(items[i]).toContain(name);
    }
    // What each part holds, where it needs a word.
    expect(items[0]).toContain("the site and the page's path, with query values removed");
    expect(items[2]).toContain('the tags that say what the page is');
    expect(items[5]).toContain("only what the site's module declared");
    expect(items[6]).toContain('whether an ad or the end is showing');
  });

  test('the address line says the part after # is kept as the page wrote it', async () => {
    // The sanitiser keeps the hash unless it looks personal, so the line must not imply it is gone.
    const heading = await capture(page(DEFAULT_RULE, sample({}, [])).ui);
    const address = heading.parentElement?.querySelector('li')?.textContent ?? '';
    expect(address).toContain('the part after # as the page wrote it');
  });

  test('a part a reader took something from is marked used, and no other', async () => {
    const heading = await capture(
      page(DEFAULT_RULE, sample({}, ['address', 'structured_data'])).ui,
    );
    const items = Array.from(heading.parentElement?.querySelectorAll('li') ?? []);
    const marked = items
      .filter((li) => Array.from(li.querySelectorAll('span')).some((s) => s.textContent === 'used'))
      .map((li) => li.textContent);
    expect(marked).toHaveLength(2);
    expect(marked[0]).toContain('Address');
    expect(marked[1]).toContain('Structured data');
  });

  test('nothing removed says so', async () => {
    const heading = await capture(page(DEFAULT_RULE, sample({}, [])).ui);
    expect(heading.parentElement?.textContent).toContain('Nothing was removed.');
  });

  test('what was removed is counted by kind', async () => {
    const heading = await capture(
      page(
        DEFAULT_RULE,
        sample(
          {
            query_values: 3,
            named_entries: 1,
            emails: 2,
            tokens: 1,
            links_with_query: 4,
            overlong: 1,
          },
          [],
        ),
      ).ui,
    );
    const text = heading.parentElement?.textContent ?? '';
    for (const words of [
      '3 query values',
      '1 entry named for an account or a profile',
      '2 e-mail addresses',
      '1 token',
      '4 links with a query',
      '1 overlong string',
    ]) {
      expect(text, words).toContain(words);
    }
    expect(text).not.toContain('Nothing was removed.');
  });

  test('a kind that removed nothing is not listed', async () => {
    const heading = await capture(page(DEFAULT_RULE, sample({ tokens: 2, emails: 0 }, [])).ui);
    const text = heading.parentElement?.textContent ?? '';
    expect(text).toContain('2 tokens');
    expect(text).not.toMatch(/e-mail/u);
  });

  test('says where it goes: nowhere until saved, and public on an issue', async () => {
    const heading = await capture(page(DEFAULT_RULE, sample({}, [])).ui);
    expect(heading.parentElement?.textContent).toContain(
      'Nothing is sent. The file is saved only when you press Save sample. If you attach it to a GitHub issue, anyone can read it.',
    );
  });

  test('the summary comes above the sample itself', async () => {
    const heading = await capture(page(DEFAULT_RULE, sample({}, [])).ui);
    const preview = screen.getByLabelText('The captured sample');
    expect(
      heading.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('no axe violations with a sample open', async () => {
    await capture(page(DEFAULT_RULE, sample({ tokens: 1 }, ['address'])).ui);
    const results = await axe(document.body);
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
