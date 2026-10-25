/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// The settings page. It talks to the worker's real composition root over in-memory ports
// (test-harness.ts) — and, for the export, over the IndexedDB connection store holding a real
// credential and its non-extractable key, so "never the credential or the key" is checked
// against a store that has both.

import 'fake-indexeddb/auto';

import { generateDpopKey } from '@mt/api';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { IdbConnectionRepo } from '../../platform/connection-store';
import { IdbAccountData, openDatabase } from '../../platform/idb';
import { axe, connectedState, rootUi } from '../test-harness';
import { Options } from './Options';

const T0 = Date.UTC(2026, 9, 22, 19, 40);
/** A credential minted with the API's checksum. */
const ACCESS_TOKEN = 'mts_ext_ka7RCcRX83UbUVjedTTl7QxIK0rr56HqGWpj9MbfFw00RgoX0';
const FINGERPRINT = 'a3f1c2d4e5b6978877665544332211ffeeddccbbaa99887766554433221100ff';

let blobs: Blob[] = [];

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  blobs = [];
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        blobs.push(blob);
        return 'blob:test';
      },
      revokeObjectURL: () => undefined,
    }),
  );
  fakeBrowser.runtime.getManifest = vi.fn(() => ({
    manifest_version: 3 as const,
    name: 'x',
    version: '0.3.1',
  }));
  fakeBrowser.extension.isAllowedIncognitoAccess = vi.fn(() => Promise.resolve(false));
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) =>
      (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).endsWith(
        'fingerprint.json',
      )
        ? Promise.resolve(
            new Response(JSON.stringify({ fingerprint: FINGERPRINT, algorithm: 'sha256' }), {
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        : Promise.reject(new TypeError('no network in this test')),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A stored connection with its credential and key, as a sign-in leaves it, and what it left. */
async function storedConnection() {
  const db = await openDatabase();
  const connection = new IdbConnectionRepo(() => Promise.resolve(db));
  await connection.saveCredential(connectedState(T0), ACCESS_TOKEN, await generateDpopKey());
  return { connection, account: new IdbAccountData(() => Promise.resolve(db)) };
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

describe('the sections of the settings page', () => {
  test('Connection, Sites, Privacy, Diagnostics and About', async () => {
    const page = await rootUi({ now: T0 });
    render(<Options ui={page.ui} />);
    for (const name of ['Connection', 'Sites', 'Privacy', 'Diagnostics', 'About']) {
      expect(screen.getByRole('heading', { name, level: 2 })).toBeTruthy();
    }
  });

  test('incognito tracking and diagnostics are off on a fresh install', async () => {
    const page = await rootUi({ now: T0 });
    render(<Options ui={page.ui} />);
    const incognito = within(region('Privacy')).getByRole('switch', { name: /incognito/iu });
    const diagnostics = within(region('Diagnostics')).getByRole('switch', { name: /log/iu });
    await waitFor(() => {
      expect((incognito as HTMLButtonElement).disabled).toBe(false);
    });
    expect(incognito.getAttribute('aria-checked')).toBe('false');
    expect(diagnostics.getAttribute('aria-checked')).toBe('false');
  });

  test("All sites is an Advanced switch, off by default, with Chrome's wording explained", async () => {
    const page = await rootUi({ now: T0 });
    render(<Options ui={page.ui} />);
    const sites = region('Sites');
    expect(within(sites).getByText('Advanced')).toBeTruthy();
    const toggle = within(sites).getByRole('switch', {
      name: 'Also track films and episodes on other sites',
    });
    await waitFor(() => {
      expect((toggle as HTMLButtonElement).disabled).toBe(false);
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(within(sites).getByText(/read and change all your data on all websites/u)).toBeTruthy();
  });

  test('turning All sites on asks Chrome for every site inside the click itself', async () => {
    const request = vi.fn(() => Promise.resolve(true));
    fakeBrowser.permissions.request = request;
    const page = await rootUi({ now: T0 });
    render(<Options ui={page.ui} />);
    const toggle = within(region('Sites')).getByRole('switch', {
      name: 'Also track films and episodes on other sites',
    });
    await waitFor(() => {
      expect((toggle as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(toggle);

    // Synchronously: no await between the click and the request (Chrome's gesture rule).
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ origins: ['https://*/*', 'http://*/*'] });
  });

  test('a refusal leaves All sites off and says so', async () => {
    fakeBrowser.permissions.request = vi.fn(() => Promise.resolve(false));
    const page = await rootUi({ now: T0 });
    render(<Options ui={page.ui} />);
    const sites = region('Sites');
    const toggle = within(sites).getByRole('switch', {
      name: 'Also track films and episodes on other sites',
    });
    await waitFor(() => {
      expect((toggle as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(toggle);

    await within(sites).findByRole('alert');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  test('each built-in service has a switch; turning Netflix off writes disabledServices', async () => {
    const page = await rootUi({ now: T0 });
    render(<Options ui={page.ui} />);
    const sites = region('Sites');
    for (const name of [
      'Netflix',
      'Apple TV',
      'Prime Video',
      'Disney+',
      'HBO Max',
      'Crunchyroll',
      'Paramount+',
    ]) {
      expect(
        within(sites).getByRole('switch', {
          name: new RegExp(`^${name.replace('+', '\\+')}`, 'u'),
        }),
      ).toBeTruthy();
    }
    const netflix = within(sites).getByRole('switch', { name: /^Netflix/u });
    await waitFor(() => {
      expect((netflix as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(netflix);

    await waitFor(async () => {
      expect((await page.deps.settings.get()).disabledServices).toEqual(['netflix']);
    });
  });
});

describe('Keep history for', () => {
  async function opened() {
    const page = await rootUi({ now: T0 });
    render(<Options ui={page.ui} />);
    const privacy = region('Privacy');
    const group = within(privacy).getByRole('radiogroup', { name: 'Keep history for' });
    const choice = (name: string) => within(group).getByRole('radio', { name });
    await waitFor(() => {
      expect((choice('7 days') as HTMLButtonElement).disabled).toBe(false);
    });
    return { page, privacy, group, choice };
  }

  test('offers 1, 7 or 30 days, 7 chosen on a fresh install', async () => {
    const { group } = await opened();
    const choices = within(group).getAllByRole('radio');
    expect(choices.map((choice) => choice.textContent)).toEqual(['1 day', '7 days', '30 days']);
    expect(choices.map((choice) => choice.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    // One tab stop for the group: the choice made.
    expect(choices.map((choice) => choice.tabIndex)).toEqual([-1, 0, -1]);
  });

  test('a choice is sent as the setting, and the page says the new length', async () => {
    const { page, privacy, choice } = await opened();
    fireEvent.click(choice('30 days'));
    await waitFor(() => {
      expect(choice('30 days').getAttribute('aria-checked')).toBe('true');
    });
    expect(page.sent).toContainEqual({ type: 'ui/settings', patch: { historyDays: 30 } });
    expect(within(privacy).getByText(/kept for 30 days in this browser/u)).toBeTruthy();
  });

  test('the arrow keys move the choice, and the focus with it', async () => {
    const { page, choice } = await opened();
    fireEvent.keyDown(choice('7 days'), { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(choice('1 day').getAttribute('aria-checked')).toBe('true');
    });
    expect(document.activeElement).toBe(choice('1 day'));
    expect(page.sent).toContainEqual({ type: 'ui/settings', patch: { historyDays: 1 } });
  });
});

describe('Clear history', () => {
  test('asks first, and sends ui/clear-history only once confirmed', async () => {
    const page = await rootUi({ now: T0 });
    render(<Options ui={page.ui} />);
    const privacy = region('Privacy');
    const cleared = () => page.sent.filter((ask) => ask.type === 'ui/clear-history');

    fireEvent.click(within(privacy).getByRole('button', { name: 'Clear history…' }));

    expect(cleared()).toEqual([]);
    expect(within(privacy).getByText(/Your diary in .+ isn't touched/u)).toBeTruthy();
    fireEvent.click(within(privacy).getByRole('button', { name: 'Clear history' }));

    await waitFor(() => {
      expect(cleared()).toEqual([{ type: 'ui/clear-history' }]);
    });
    expect(await within(privacy).findByText('History cleared.')).toBeTruthy();
    expect(page.sent.filter((ask) => ask.type === 'ui/clear')).toEqual([]);
  });

  test('Cancel sends nothing', async () => {
    const page = await rootUi({ now: T0 });
    render(<Options ui={page.ui} />);
    const privacy = region('Privacy');

    fireEvent.click(within(privacy).getByRole('button', { name: 'Clear history…' }));
    fireEvent.click(within(privacy).getByRole('button', { name: 'Cancel' }));

    expect(page.sent.filter((ask) => ask.type === 'ui/clear-history')).toEqual([]);
    expect(within(privacy).queryByRole('button', { name: 'Clear history' })).toBeNull();
  });
});

describe('Clear all local data', () => {
  test('asks first, and sends ui/clear only once confirmed', async () => {
    const page = await rootUi({ now: T0 });
    render(<Options ui={page.ui} />);
    const privacy = region('Privacy');

    fireEvent.click(within(privacy).getByRole('button', { name: 'Clear…' }));

    expect(page.sent.filter((ask) => ask.type === 'ui/clear')).toEqual([]);
    const confirm = within(privacy).getByRole('button', { name: 'Clear all local data' });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(page.sent.filter((ask) => ask.type === 'ui/clear')).toEqual([{ type: 'ui/clear' }]);
    });
  });

  test('Cancel sends nothing', async () => {
    const page = await rootUi({ now: T0 });
    render(<Options ui={page.ui} />);
    const privacy = region('Privacy');

    fireEvent.click(within(privacy).getByRole('button', { name: 'Clear…' }));
    fireEvent.click(within(privacy).getByRole('button', { name: 'Cancel' }));

    expect(page.sent.filter((ask) => ask.type === 'ui/clear')).toEqual([]);
    expect(within(privacy).queryByRole('button', { name: 'Clear all local data' })).toBeNull();
  });
});

describe('Export my extension data', () => {
  const SECRETS = [
    'accessToken',
    'access_token',
    'keyPair',
    'privateKey',
    ACCESS_TOKEN,
    'mts_ext_',
  ];

  test("the worker's export holds neither the credential nor the key", async () => {
    const page = await rootUi({ now: T0, ...(await storedConnection()) });

    const answer = await page.root.onUiRequest({ v: 1, id: 1, type: 'ui/export' });

    expect(answer?.response.ok).toBe(true);
    const text = JSON.stringify(answer?.response);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });

  test('the file the page saves holds neither', async () => {
    const page = await rootUi({ now: T0, ...(await storedConnection()) });
    render(<Options ui={page.ui} />);

    fireEvent.click(within(region('Privacy')).getByRole('button', { name: 'Export' }));

    await waitFor(() => {
      expect(blobs).toHaveLength(1);
    });
    const text = await blobs[0]?.text();
    expect(text).toBeDefined();
    expect(JSON.parse(text ?? 'null')).toBeTypeOf('object');
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });
});

describe('Disconnect', () => {
  test("sends ui/disconnect and links to the web app's Connected services", async () => {
    const page = await rootUi({ now: T0, ...(await storedConnection()) });
    render(<Options ui={page.ui} />);
    const connection = region('Connection');

    fireEvent.click(
      within(connection).getByRole('button', { name: 'Disconnect from this browser' }),
    );
    // The page may ask again first; if it does, the act's button carries the act's name.
    const again = within(connection).queryAllByRole('button', {
      name: 'Disconnect from this browser',
    });
    const last = again.at(-1);
    if (last !== undefined) fireEvent.click(last);

    await waitFor(() => {
      expect(page.sent).toContainEqual({ type: 'ui/disconnect', sendFirst: false });
    });
    await within(connection).findByText(/^Disconnected\./u);
    const link = await within(connection).findByRole('link', { name: /Connected services/u });
    expect(link.getAttribute('href')).toBe('http://localhost:3000/settings?tab=connections');
    // The stored credential, its key and the mark of the disconnect are all gone.
    const db = await openDatabase();
    expect(await db.getAllKeys('connection')).toEqual([]);
  });
});

describe('About', () => {
  test('shows the version and the build fingerprint', async () => {
    const page = await rootUi({ now: T0 });
    render(<Options ui={page.ui} />);
    const about = region('About');

    expect(within(about).getByText('0.3.1')).toBeTruthy();
    expect(await within(about).findByText(FINGERPRINT)).toBeTruthy();
  });

  // Readings, settings and receipts never leave; the finished viewing and the credential go to
  // Scenola; the diagnostics log only if the person attaches it. Two more rows: a film's
  // start, which leaves like a play, and the account's start rule, which does not. And which
  // account the connection acts for, which comes from Scenola and never leaves.
  test('the data inventory: nine kinds of data, four that can leave the browser', async () => {
    const page = await rootUi({ now: T0 });
    render(<Options ui={page.ui} />);
    const table = within(region('About')).getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(9);
    const leaving = rows.filter(
      (row) => !/^No\b/u.test(row.querySelectorAll('td')[1]?.textContent ?? ''),
    );
    expect(leaving).toHaveLength(4);
  });

  test('the licence is MPL-2.0', async () => {
    const page = await rootUi({ now: T0 });
    render(<Options ui={page.ui} />);
    const link = within(region('About')).getByRole('link', { name: /Mozilla Public License/u });
    expect(link.getAttribute('href')).toBe('https://mozilla.org/MPL/2.0/');
  });
});

describe('accessibility', () => {
  test('the page, connected and with Clear confirming: no axe violations', async () => {
    const page = await rootUi({ now: T0 });
    const { container } = render(<Options ui={page.ui} />);
    await within(region('About')).findByText(FINGERPRINT);
    expect((await axe(container)).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    fireEvent.click(within(region('Privacy')).getByRole('button', { name: 'Clear…' }));
    expect((await axe(container)).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test('not connected: no axe violations', async () => {
    const page = await rootUi({
      now: T0,
      connection: new IdbConnectionRepo(openDatabase),
      account: new IdbAccountData(openDatabase),
    });
    const { container } = render(<Options ui={page.ui} />);
    expect((await axe(container)).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
