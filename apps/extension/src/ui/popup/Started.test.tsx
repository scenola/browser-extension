/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// *Recently* for a film begun: a start is a line of its own, labelled *Started*, whose words are
// the server's answer to the start — saved in progress, already in the library, could not tell
// which film — or, when the account's rule did not take it, that it was not saved. The lines come
// from the worker's real composition root over stored plays.

import type { HistoryEntry, OutboxEntry, PlayBody, ReceiptState } from '@mt/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { axe, rootUi } from '../test-harness';
import { Popup } from './Popup';

const T0 = Date.UTC(2026, 9, 22, 19, 40);

const START: PlayBody = {
  report: 'start',
  kind: 'movie',
  title: 'Arrival',
  year: 2016,
  duration_seconds: 6_960,
  furthest_position_seconds: 1_020,
  story_seconds: 6_120,
  played_seconds: 1_000,
};

const VIEWING: PlayBody = {
  kind: 'movie',
  title: 'Arrival',
  year: 2016,
  watched_at: '2026-10-22T20:40:00+02:00',
  duration_seconds: 6_960,
  furthest_position_seconds: 6_500,
  ended: false,
};

let n = 0;

function answered(
  body: PlayBody,
  state: ReceiptState,
  reason: string | null,
  titleId: string | null,
  sentAt = T0 - 5 * 60_000,
): HistoryEntry {
  n += 1;
  const id = String(n).padStart(2, '0');
  return {
    playId: `0192f1a2-${id}00-7000-8000-0000000000${id}`,
    body,
    label: 'Arrival',
    scrobbleId: `01jb${id}hjkmnpqrstvwxyz012345`.slice(0, 26),
    sentAt,
    receipt: { state, reason, titleId },
    receiptReadAt: sentAt + 10_000,
    receiptGoneAt: null,
  };
}

beforeEach(() => {
  vi.stubGlobal('close', vi.fn());
});

afterEach(() => {
  cleanup();
});

const recently = () => screen.getByRole('region', { name: 'Recently' });

describe('Recently: a film begun', () => {
  // What the server's answer means for a start, in the person's words.
  test.each<[string, ReceiptState, string | null, RegExp]>([
    ['started', 'started', null, /^Started · Saved in progress · /iu],
    [
      'already in the library',
      'ignored',
      'status_stands',
      /^Started · Already in your library · /iu,
    ],
    [
      'could not tell which film',
      'ignored',
      'not_placed',
      /^Started · Couldn.t tell which film · /iu,
    ],
  ])(
    '%s: the second line reads "Started · <the answer> · <when>"',
    async (_n, state, reason, words) => {
      const page = await rootUi({ now: T0, history: [answered(START, state, reason, 'title-1')] });
      render(<Popup ui={page.ui} />);
      const row = within(recently()).getByRole('button');
      const lines = Array.from(row.querySelectorAll('span.block')).map((el) => el.textContent);
      expect(lines[0]).toBe('Arrival');
      expect(lines[1]).toMatch(words);
    },
  );

  test('a start the account’s rule did not take reads "Not saved in progress"', async () => {
    const entry = answered(START, 'ignored', 'not_completed', null);
    const page = await rootUi({ now: T0, history: [{ ...entry, scrobbleId: null }] });
    render(<Popup ui={page.ui} />);
    const row = within(recently()).getByRole('button');
    expect(row.textContent).toMatch(/Started · Not saved in progress · /u);
  });

  test('the same answer for a viewing keeps the viewing’s own words and no label', async () => {
    const page = await rootUi({
      now: T0,
      history: [answered(VIEWING, 'ignored', 'not_completed', null)],
    });
    render(<Popup ui={page.ui} />);
    const row = within(recently()).getByRole('button');
    expect(row.textContent).toContain('Not enough watched — not added');
    expect(row.textContent).not.toContain('Started');
  });

  test('a start and its viewing are two lines, the start labelled and the viewing not', async () => {
    const page = await rootUi({
      now: T0,
      history: [
        answered(START, 'started', null, 'title-1', T0 - 20 * 60_000),
        answered(VIEWING, 'recorded', null, 'title-1', T0 - 2 * 60_000),
      ],
    });
    render(<Popup ui={page.ui} />);
    const rows = within(recently()).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).not.toContain('Started');
    expect(rows[1]?.textContent).toContain('Started · ');
  });

  test('a start waiting to be sent is labelled Started too', async () => {
    const queued: OutboxEntry = {
      playId: '0192f1a2-9900-7000-8000-000000000099',
      viewingId: 'v-1',
      body: START,
      createdAt: T0 - 60_000,
      watchedAt: T0 - 60_000,
      attempts: 0,
      nextAttemptAt: T0 + 60_000,
      state: 'pending',
      lastError: null,
    };
    const page = await rootUi({ now: T0, outbox: [queued] });
    render(<Popup ui={page.ui} />);
    const row = within(recently()).getByRole('button');
    expect(row.textContent).toMatch(/Arrival/u);
    expect(row.textContent).toMatch(/Started · /u);
  });

  test('started and already-in-the-library link to the title; could-not-tell links nowhere', async () => {
    const page = await rootUi({
      now: T0,
      history: [
        answered(START, 'started', null, 'title-1', T0 - 60_000),
        answered(START, 'ignored', 'status_stands', 'title-2', T0 - 120_000),
        answered(START, 'ignored', 'not_placed', null, T0 - 180_000),
      ],
    });
    render(<Popup ui={page.ui} />);
    // Each row opens *What was sent*, which carries the link beside the exact body.
    const links: (string | null)[] = [];
    for (let i = 0; i < 3; i += 1) {
      const row = within(recently()).getAllByRole('button')[i];
      if (row === undefined) throw new Error(`no row ${String(i)}`);
      fireEvent.click(row);
      await screen.findByText('Answer');
      links.push(screen.queryByRole('link')?.getAttribute('href') ?? null);
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      await waitFor(() => {
        expect(screen.queryByRole('region', { name: 'Recently' })).not.toBeNull();
      });
    }
    expect(links).toEqual([
      'http://localhost:3000/title/title-1',
      'http://localhost:3000/title/title-2',
      null,
    ]);
  });

  test('What was sent shows the start exactly as sent: the report, the four numbers, no time', async () => {
    const page = await rootUi({
      now: T0,
      history: [answered(START, 'started', null, 'title-1')],
    });
    render(<Popup ui={page.ui} />);
    fireEvent.click(within(recently()).getByRole('button'));
    const body = await screen.findByText(/"report": "start"/u);
    const text = body.textContent;
    expect(JSON.parse(text)).toEqual(START);
    expect(text).not.toContain('watched_at');
    expect(text).not.toContain('ended');
  });

  test('no axe violations', async () => {
    const page = await rootUi({
      now: T0,
      history: [
        answered(START, 'started', null, 'title-1', T0 - 60_000),
        answered(START, 'ignored', 'not_placed', null, T0 - 120_000),
      ],
    });
    const { container } = render(<Popup ui={page.ui} />);
    const results = await axe(container);
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
