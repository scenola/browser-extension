/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// The copy rules over every rendered string: each page in each of its states, every word a
// person reads or hears — text, accessible names, titles, placeholders — has no "scrobble",
// "credential" or "DPoP", and "russia"/"russian" only in lower case. The JSON a play sent and its answer (*What was sent*, `<pre>`) are data shown verbatim,
// not copy, and are left out.

import 'fake-indexeddb/auto';

import { DEFAULT_SETTINGS, IGNORED_REASONS, PAUSE_INDEFINITELY, DEFAULT_RULE } from '@mt/core';
import type { ConnectResult, HistoryEntry, ReceiptState } from '@mt/core';
import { InMemoryConnectionRepo } from '@mt/core/testing';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import type { ComponentChild } from 'preact';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { NowPlaying, PopupState, UiResponse } from '../messaging/protocol';
import { Options } from './options/Options';
import { Popup } from './popup/Popup';
import type { UiAsk } from './store';
import { connectedState, fakeUi, rootUi } from './test-harness';
import { Welcome } from './welcome/Welcome';

const T0 = Date.UTC(2026, 9, 22, 19, 40);
const JARGON = /scrobbl|credential|dpop/iu;

/** Every string the document says, minus the verbatim JSON of *What was sent*. */
function spoken(): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement?.closest('pre') != null) continue;
    const text = node.textContent?.trim() ?? '';
    if (text !== '') out.push(text);
  }
  for (const element of document.body.querySelectorAll('*')) {
    for (const attribute of ['aria-label', 'title', 'placeholder', 'alt', 'aria-valuetext']) {
      const value = element.getAttribute(attribute);
      if (value !== null && value !== '') out.push(value);
    }
  }
  out.push(document.title);
  return out;
}

const seen: string[] = [];

function check(): void {
  const strings = spoken();
  seen.push(...strings);
  expect(strings.filter((s) => JARGON.test(s))).toEqual([]);
  expect(
    strings.filter((s) =>
      [...s.matchAll(/russia\p{L}*/giu)].some((m) => m[0] !== m[0].toLowerCase()),
    ),
  ).toEqual([]);
}

function show(view: ComponentChild): void {
  cleanup();
  render(view);
  check();
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('close', vi.fn());
  fakeBrowser.runtime.getManifest = vi.fn(() => ({
    manifest_version: 3 as const,
    name: 'x',
    version: '0.3.1',
  }));
  fakeBrowser.extension.isAllowedIncognitoAccess = vi.fn(() => Promise.resolve(false));
  fakeBrowser.action.getUserSettings = vi.fn(() => Promise.resolve({ isOnToolbar: false }));
  fakeBrowser.permissions.request = vi.fn(() => Promise.resolve(false));
  // About reads the build's fingerprint.json; no network in a unit test.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('{}'))),
  );
});

afterEach(() => {
  cleanup();
});

const PLAYING: NowPlaying = {
  tabId: 7,
  serviceName: 'Netflix',
  label: 'Breaking Bad · S1 E2',
  episodeTitle: "Cat's in the Bag...",
  progress: { position: 1872, duration: 2880 },
  state: 'tracking',
  viewingId: 'viewing-1',
  origin: null,
  reason: null,
  problem: null,
};

function popupState(extra: Partial<PopupState>): PopupState {
  return {
    connection: connectedState(Date.now()),
    nowPlaying: null,
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

const RECEIPTS: readonly (readonly [ReceiptState, string | null])[] = [
  ['received', null],
  ['awaiting_catalog', null],
  ['needs_confirmation', 'text_only'],
  ['held', 'plus_lapsed'],
  ['held', 'braked'],
  ['held', 'dormant_return'],
  ['recorded', null],
  ['duplicate', null],
  ['ignored', 'not_completed'],
  ['ignored', 'unknown_id'],
  ['dismissed', 'user'],
  ['dismissed', 'revoked'],
  ['expired', null],
];

function history(): HistoryEntry[] {
  return RECEIPTS.map(([state, reason], i) => ({
    playId: `01929a4e-${String(i).padStart(4, '0')}-7000-8000-000000000000`,
    body: { kind: 'movie', title: `Film ${String(i)}`, watched_at: '2026-10-22T21:00:00+02:00' },
    label: `Film ${String(i)}`,
    scrobbleId: `01jb${String(i).padStart(2, '0')}hjkmnpqrstvwxyz0123`,
    sentAt: T0 - (i + 1) * 60_000,
    receipt: { state, reason, titleId: state === 'recorded' ? 'title-1' : null },
    receiptReadAt: T0,
    receiptGoneAt: null,
  }));
}

test('the popup, in every state', async () => {
  for (const state of ['tracking', 'added', 'skipped', 'not_tracked', 'blocked'] as const) {
    show(
      <Popup
        ui={
          fakeUi(popupState({ nowPlaying: { ...PLAYING, state, origin: 'https://a.example' } })).ui
        }
      />,
    );
  }
  // Each reason something plays and is not tracked, and a viewing that won't be added.
  for (const reason of IGNORED_REASONS) {
    const nowPlaying: NowPlaying = { ...PLAYING, state: 'not_tracking', label: '', reason };
    show(<Popup ui={fakeUi(popupState({ nowPlaying })).ui} />);
  }
  for (const problem of ['series_no_episode', 'no_title'] as const) {
    show(<Popup ui={fakeUi(popupState({ nowPlaying: { ...PLAYING, problem } })).ui} />);
  }
  show(<Popup ui={fakeUi(popupState({ connection: { kind: 'none' } })).ui} />);
  show(
    <Popup ui={fakeUi(popupState({ connection: { kind: 'broken', reason: 'key_missing' } })).ui} />,
  );
  show(<Popup ui={fakeUi(popupState({ pausedUntil: PAUSE_INDEFINITELY })).ui} />);
  show(<Popup ui={fakeUi(popupState({ pausedUntil: Date.now() + 3_600_000 })).ui} />);

  const page = await rootUi({ now: T0, history: history() });
  show(<Popup ui={page.ui} />);
  fireEvent.click(screen.getByRole('button', { name: /Pause tracking/u }));
  check();
  for (let i = 0; i < 10; i += 1) {
    cleanup();
    render(<Popup ui={page.ui} />);
    const rows = screen.getAllByRole('button').filter((b) => b.hasAttribute('data-play-id'));
    const row = rows[i];
    if (row === undefined) break;
    fireEvent.click(row);
    await screen.findByLabelText('What was sent');
    check();
  }
});

test('the welcome page, in every step and every connect answer', async () => {
  const answers: readonly ConnectResult['kind'][] = [
    'cancelled',
    'code_invalid',
    'proof_invalid',
    'forbidden',
    'limit_reached',
    'feature_closed',
    'unavailable',
  ];
  for (const kind of answers) {
    const page = fakeUi(popupState({ connection: { kind: 'none' } }), () => ({
      ok: true,
      data: { result: { kind } },
    }));
    show(<Welcome ui={page.ui} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Scenola' }));
    await screen.findByRole('alert');
    check();
  }
  const ok = fakeUi(popupState({ connection: { kind: 'none' } }), (ask: UiAsk): UiResponse =>
    ask.type === 'ui/connect'
      ? { ok: true, data: { result: { kind: 'connected', state: connectedState(Date.now()) } } }
      : { ok: true, data: DEFAULT_SETTINGS },
  );
  show(<Welcome ui={ok.ui} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect Scenola' }));
  await screen.findByRole('heading', { name: 'Where to track' });
  check();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Done' });
  check();
});

test('the settings page, connected and not', async () => {
  const page = await rootUi({ now: T0 });
  show(<Options ui={page.ui} />);
  fireEvent.click(screen.getByRole('button', { name: 'Clear history…' }));
  check();
  fireEvent.click(screen.getByRole('button', { name: 'Clear…' }));
  check();
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect from this browser' }));
  check();

  const none = await rootUi({ now: T0, connection: new InMemoryConnectionRepo() });
  show(<Options ui={none.ui} />);
});

test('the walk read the pages (a check that saw nothing proves nothing)', () => {
  // The test order is the file's: the three above ran first.
  expect(seen.some((s) => s.includes('Added at 70 %'))).toBe(true);
  expect(seen.some((s) => s.includes('Where to track'))).toBe(true);
  expect(seen.some((s) => s.includes('Clear all local data'))).toBe(true);
});
