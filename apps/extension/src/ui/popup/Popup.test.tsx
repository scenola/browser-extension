/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// The popup. The now-playing states render from fixture `PopupState`s; the waiting link,
// *Recently* and *What was sent* render from the worker's real composition root over stored plays
// (test-harness.ts), so a link or a body is the one the root builds, not one a fixture hands the
// page.

import { PAUSE_INDEFINITELY, DEFAULT_RULE } from '@mt/core';
import type { HistoryEntry, PlayBody, ReceiptState } from '@mt/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { ActiveSite, NowPlaying, PopupState } from '../../messaging/protocol';
import { axe, connectedState, fakeUi, rootUi } from '../test-harness';
import { Popup } from './Popup';

const T0 = Date.UTC(2026, 9, 22, 19, 40);
const DAY_MS = 86_400_000;

/** A Netflix episode, 31 minutes into its 48. */
const TRACKING: NowPlaying = {
  tabId: 7,
  serviceName: 'Netflix',
  label: 'Breaking Bad · S1 E2',
  episodeTitle: "Cat's in the Bag...",
  progress: { position: 31 * 60 + 12, duration: 48 * 60 },
  state: 'tracking',
  viewingId: 'viewing-1',
  origin: null,
  reason: null,
  problem: null,
};

function state(nowPlaying: NowPlaying | null, extra: Partial<PopupState> = {}): PopupState {
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

/** The now-playing states, each with its state line. */
const NOW_PLAYING: readonly (readonly [string, NowPlaying, RegExp])[] = [
  ['tracking', TRACKING, /Added at 70 %/u],
  ['added', { ...TRACKING, state: 'added', progress: null }, /^Added$/u],
  ['skipped', { ...TRACKING, state: 'skipped' }, /Skipped/u],
  [
    'not_tracked',
    {
      tabId: 7,
      serviceName: 'films.example',
      label: '',
      episodeTitle: null,
      progress: null,
      state: 'not_tracked',
      viewingId: null,
      origin: 'https://films.example',
      reason: null,
      problem: null,
    },
    /Not tracked on this site/u,
  ],
  [
    'blocked',
    {
      tabId: 7,
      serviceName: 'www.youtube.com',
      label: '',
      episodeTitle: null,
      progress: null,
      state: 'blocked',
      viewingId: null,
      origin: null,
      reason: null,
      problem: null,
    },
    /MediaTracker doesn't track this site/u,
  ],
];

beforeEach(() => {
  vi.stubGlobal('close', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The element carrying a state line, and the polite live region around it. */
function liveRegionOf(text: RegExp): HTMLElement | null {
  return screen.getByText(text).closest<HTMLElement>('[aria-live="polite"]');
}

describe('now playing', () => {
  test.each(NOW_PLAYING)('%s: its state line, in a polite live region', (_name, playing, line) => {
    render(<Popup ui={fakeUi(state(playing)).ui} />);

    expect(screen.getByText(line)).toBeTruthy();
    expect(liveRegionOf(line)).not.toBeNull();
  });

  test('tracking: the service, what the page says, "31 of 48 min" and Skip', () => {
    render(<Popup ui={fakeUi(state(TRACKING)).ui} />);

    expect(screen.getByText(/Netflix/u)).toBeTruthy();
    expect(screen.getByText('Breaking Bad')).toBeTruthy();
    expect(screen.getByText(/S1 E2/u)).toBeTruthy();
    expect(screen.getByText(/31 of 48 min/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy();
  });

  test('tracking: the line it is added at is the account’s', () => {
    const rule = { ...DEFAULT_RULE, finishThresholdPercent: 50 };
    render(<Popup ui={fakeUi(state(TRACKING, { accountRule: rule })).ui} />);

    expect(screen.getByText('Added at 50 %')).toBeTruthy();
    expect(screen.queryByText(/70 %/u)).toBeNull();
  });

  test("an episode: the numbers and the episode's own title", () => {
    render(<Popup ui={fakeUi(state(TRACKING)).ui} />);

    expect(screen.getByText("S1 E2 · Cat's in the Bag...")).toBeTruthy();
  });

  test('the header says "Connected" in primary ink: glass carries nothing muted (K1)', () => {
    render(<Popup ui={fakeUi(state(null)).ui} />);

    const word = screen.getByText('Connected');
    expect(word.className).toContain('text-foreground');
    expect(word.className).not.toContain('muted');
  });

  test('a personal-token connection near its estimated end gets no expiry warning', () => {
    const near = { ...connectedState(Date.now()), expiresAt: Date.now() + DAY_MS };
    const token = { ...near, strategy: 'personal_token' as const };
    render(<Popup ui={fakeUi(state(null, { connection: token })).ui} />);
    expect(screen.queryByRole('note')).toBeNull();
    cleanup();

    // The same nearness on a window connection still warns: its expiry is ours to estimate.
    render(<Popup ui={fakeUi(state(null, { connection: near })).ui} />);
    expect(screen.getByRole('note')).toBeTruthy();
  });

  test('a film, or an episode the page does not title, shows no empty separator', () => {
    render(<Popup ui={fakeUi(state({ ...TRACKING, episodeTitle: null })).ui} />);

    expect(screen.getByText('S1 E2')).toBeTruthy();
    expect(screen.queryByText(/·\s*$/u)).toBeNull();
  });

  test('Skip sends ui/skip with the viewing id', () => {
    const page = fakeUi(state(TRACKING));
    render(<Popup ui={page.ui} />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));

    expect(page.sent).toEqual([{ type: 'ui/skip', viewingId: 'viewing-1' }]);
  });

  test.each(['added', 'skipped', 'not_tracked', 'blocked'] as const)(
    '%s: no Skip (Skip is for a viewing still being tracked)',
    (name) => {
      const playing = NOW_PLAYING.find(([n]) => n === name)?.[1] ?? null;
      render(<Popup ui={fakeUi(state(playing)).ui} />);
      expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    },
  );

  const TRACKABLE: ActiveSite = {
    origin: 'https://films.example',
    name: 'films.example',
    tracking: 'trackable',
    pattern: 'https://films.example/*',
  };

  test("a trackable site: Track this site asks Chrome inside the click, for the site's pattern", () => {
    const request = vi.fn(() => Promise.resolve(true));
    fakeBrowser.permissions.request = request;
    render(<Popup ui={fakeUi(state(null, { site: TRACKABLE })).ui} />);

    fireEvent.click(screen.getByRole('button', { name: 'Track this site' }));

    // Synchronously: no await happened between the click and the request.
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ origins: ['https://films.example/*'] });
  });

  test("the pattern is the worker's, never the origin spelled with /* (a port is no match pattern)", () => {
    const request = vi.fn(() => Promise.resolve(true));
    fakeBrowser.permissions.request = request;
    const site = {
      ...TRACKABLE,
      origin: 'http://127.0.0.1:8080',
      pattern: 'http://127.0.0.1/*',
    };
    render(<Popup ui={fakeUi(state(null, { site })).ui} />);

    fireEvent.click(screen.getByRole('button', { name: 'Track this site' }));

    expect(request).toHaveBeenCalledWith({ origins: ['http://127.0.0.1/*'] });
  });

  test('once Chrome grants it, the worker is told (ui/track-site)', async () => {
    fakeBrowser.permissions.request = vi.fn(() => Promise.resolve(true));
    const page = fakeUi(state(null, { site: TRACKABLE }));
    render(<Popup ui={page.ui} />);

    fireEvent.click(screen.getByRole('button', { name: 'Track this site' }));

    await waitFor(() => {
      expect(page.sent).toEqual([{ type: 'ui/track-site', origin: 'https://films.example' }]);
    });
  });

  test('a refusal says so and tells the worker nothing', async () => {
    fakeBrowser.permissions.request = vi.fn(() => Promise.resolve(false));
    const page = fakeUi(state(null, { site: TRACKABLE }));
    render(<Popup ui={page.ui} />);

    fireEvent.click(screen.getByRole('button', { name: 'Track this site' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/Chrome didn't allow it/u);
    expect(page.sent).toEqual([]);
  });

  test("beside a not-tracked play, the one button is the site card's", () => {
    const playing = NOW_PLAYING.find(([n]) => n === 'not_tracked')?.[1] ?? null;
    render(<Popup ui={fakeUi(state(playing, { site: TRACKABLE })).ui} />);
    expect(screen.getAllByRole('button', { name: 'Track this site' })).toHaveLength(1);
  });

  test('a built-in service turned off: no button, a way to settings (it would not turn it back on)', () => {
    const site: ActiveSite = {
      origin: 'https://www.netflix.com',
      name: 'Netflix',
      tracking: 'turned_off',
      pattern: null,
    };
    render(<Popup ui={fakeUi(state(null, { site })).ui} />);

    expect(screen.queryByRole('button', { name: 'Track this site' })).toBeNull();
    expect(screen.getByText(/Netflix is turned off in settings/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy();
  });

  test.each(['tracked', 'blocked'] as const)('%s: the site card offers nothing', (tracking) => {
    const site: ActiveSite = { ...TRACKABLE, tracking, pattern: null };
    render(<Popup ui={fakeUi(state(null, { site })).ui} />);
    expect(screen.queryByRole('button', { name: 'Track this site' })).toBeNull();
  });

  test('blocked: no way to track it, whatever the person allowed', () => {
    const playing = NOW_PLAYING.find(([n]) => n === 'blocked')?.[1] ?? null;
    render(<Popup ui={fakeUi(state(playing)).ui} />);
    expect(screen.queryByRole('button', { name: /track this site/iu })).toBeNull();
  });
});

describe('the connection check', () => {
  const check = (status: 'active' | 'braked' | 'suspended'): PopupState['connectionCheck'] => ({
    status,
    expiresAt: Date.now() + 200 * DAY_MS,
    checkedAt: Date.now(),
  });

  test('revoked: the server refused the connection, so the popup says so and offers Reconnect', () => {
    const connection = { kind: 'broken', reason: 'credential_invalid' } as const;
    render(<Popup ui={fakeUi(state(null, { connection })).ui} />);

    const note = screen.getByRole('note');
    expect(note.textContent).toMatch(/ended or has run out/u);
    expect(within(note).getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });

  test('a personal token is warned about once the server has given its date, and not if it has none', () => {
    const soon = Date.now() + DAY_MS;
    const token = {
      ...connectedState(Date.now()),
      strategy: 'personal_token' as const,
      expiresAt: soon,
    };
    const checked = { status: 'active', expiresAt: soon, checkedAt: Date.now() } as const;
    render(<Popup ui={fakeUi(state(null, { connection: token, connectionCheck: checked })).ui} />);
    expect(screen.getByRole('note').textContent).toMatch(/Reconnect MediaTracker soon/u);
    cleanup();

    render(
      <Popup
        ui={
          fakeUi(
            state(null, { connection: token, connectionCheck: { ...checked, expiresAt: null } }),
          ).ui
        }
      />,
    );
    expect(screen.queryByRole('note')).toBeNull();
  });

  test('a lost key keeps its own words', () => {
    const connection = { kind: 'broken', reason: 'key_missing' } as const;
    render(<Popup ui={fakeUi(state(null, { connection })).ui} />);
    expect(screen.getByRole('note').textContent).toMatch(/Reconnect MediaTracker to keep adding/u);
  });

  test('braked: said in words, plays held, with the way to review it', () => {
    render(<Popup ui={fakeUi(state(null, { connectionCheck: check('braked') })).ui} />);

    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/paused this connection/u);
    expect(status.textContent).toMatch(/held/u);
    expect(within(status).getByRole('link', { name: /Connected services/u })).toBeTruthy();
  });

  test('suspended: the account is being deleted, and new plays are not kept', () => {
    render(<Popup ui={fakeUi(state(null, { connectionCheck: check('suspended') })).ui} />);

    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/account is being deleted/u);
    expect(status.textContent).toMatch(/isn't keeping new plays/u);
  });

  test('active: nothing to say', () => {
    render(<Popup ui={fakeUi(state(null, { connectionCheck: check('active') })).ui} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('not connected', () => {
  test('shows only Connect, which opens the welcome page', async () => {
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    render(<Popup ui={fakeUi(state(TRACKING, { connection: { kind: 'none' } })).ui} />);

    const controls = [...document.querySelectorAll('button, a[href], input, select, textarea')];
    expect(controls).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Connect MediaTracker' })).toBe(controls[0]);
    expect(screen.queryByText(/Will be added/u)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Connect MediaTracker' }));
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringMatching(/welcome\.html$/u) as string }),
      );
    });
  });
});

// ── what the root builds from stored plays ────────────────────────────────────────────────────

const EPISODE: PlayBody = {
  kind: 'episode',
  title: 'Who Is Alive?',
  show: {
    title: 'Severance',
    ids: {
      provider: [
        { namespace: 'provider.apple_tv', key: 'show', value: 'umc.cmc.1srk2goyh2q2zdxcx605w8vtx' },
      ],
    },
  },
  season_number: 2,
  episode_number: 3,
  watched_at: '2026-10-22T21:10:00+02:00',
  duration_seconds: 3120,
  furthest_position_seconds: 3080,
  ended: true,
};

let nextId = 0;

interface Answer {
  readonly state: ReceiptState;
  readonly reason: string | null;
  readonly titleId?: string | null;
}

const WAITS: Answer = { state: 'needs_confirmation', reason: 'text_only' };
const ADDED: Answer = { state: 'recorded', reason: null, titleId: 't1' };

function sentPlay(label: string, receipt: Answer, sentAt: number, body = EPISODE): HistoryEntry {
  nextId += 1;
  const n = String(nextId).padStart(2, '0');
  return {
    playId: `01929a4e-${n}00-7000-8000-0000000000${n}`,
    body,
    label,
    scrobbleId: `01jb${n}hjkmnpqrstvwxyz012345`.slice(0, 26),
    sentAt,
    receipt: { state: receipt.state, reason: receipt.reason, titleId: receipt.titleId ?? null },
    receiptReadAt: sentAt + 10_000,
    receiptGoneAt: null,
  };
}

describe('waiting for you', () => {
  test('a play waiting for confirmation links to Up Next in the web app', async () => {
    const waiting = sentPlay('Severance · S2 E3', WAITS, T0 - 60_000);
    const page = await rootUi({ now: T0, history: [waiting] });
    render(<Popup ui={page.ui} />);

    const section = screen.getByRole('region', { name: 'Waiting for you' });
    const link = within(section).getByRole('link', { name: /Confirm in MediaTracker/u });
    // The development build's web app is localhost:3000.
    expect(link.getAttribute('href')).toBe('http://localhost:3000/today');
    expect(within(section).getByText(/Severance/u)).toBeTruthy();
  });

  test('plays sharing a question are one row with their count', async () => {
    const withKey = (n: number): HistoryEntry => {
      const play = sentPlay(`Severance · S2 E${String(n)}`, WAITS, T0 - n * 60_000, {
        ...EPISODE,
        episode_number: n,
      });
      return {
        ...play,
        receipt: play.receipt === null ? null : { ...play.receipt, questionKey: 'q1:a' },
      };
    };
    const page = await rootUi({ now: T0, history: [withKey(1), withKey(2), withKey(3)] });
    render(<Popup ui={page.ui} />);

    const section = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(section).getAllByRole('link')).toHaveLength(1);
    expect(within(section).getByRole('link').getAttribute('href')).toBe(
      'http://localhost:3000/today?question=q1%3Aa',
    );
    expect(within(section).getByText('Severance · S2 E1–E3')).toBeTruthy();
    expect(within(section).getByText('3 viewings')).toBeTruthy();
  });

  test('a section that disappears when nothing waits', async () => {
    const recorded = sentPlay('Severance · S2 E3', ADDED, T0 - 60_000);
    const page = await rootUi({ now: T0, history: [recorded] });
    render(<Popup ui={page.ui} />);

    expect(screen.queryByRole('region', { name: 'Waiting for you' })).toBeNull();
  });
});

describe('recently', () => {
  /** Each answer and the words it is shown by. */
  const VERDICTS: readonly (readonly [ReceiptState, string | null, RegExp])[] = [
    ['recorded', null, /Added/u],
    ['duplicate', null, /Already in your diary/u],
    ['needs_confirmation', 'text_only', /Confirm in MediaTracker/u],
    ['needs_confirmation', 'numbering_unconfirmed', /Confirm in MediaTracker/u],
    ['held', 'plus_lapsed', /Held — MediaTracker Plus ended; kept 30 days/u],
    ['held', 'braked', /MediaTracker paused this connection — review in the app/u],
    ['ignored', 'not_completed', /Not enough watched — not added/u],
    ['ignored', 'unknown_id', /Not something MediaTracker tracks/u],
    ['ignored', 'not_served', /Not something MediaTracker tracks/u],
    ['ignored', 'medium_not_served', /Not something MediaTracker tracks/u],
  ];

  test.each(VERDICTS)('%s / %s reads %s', async (receiptState, reason, words) => {
    const answer: Answer = { state: receiptState, reason, titleId: 't1' };
    const play = sentPlay('Severance · S2 E3', answer, T0 - 60_000);
    const page = await rootUi({ now: T0, history: [play] });
    render(<Popup ui={page.ui} />);

    const section = screen.getByRole('region', { name: 'Recently' });
    expect(within(section).getByText(words)).toBeTruthy();
  });

  test('lists the last ten plays, newest first', async () => {
    const plays = Array.from({ length: 12 }, (_, i) =>
      sentPlay(`Severance · S2 E${String(i + 1)}`, ADDED, T0 - (12 - i) * 60_000, {
        ...EPISODE,
        episode_number: i + 1,
      }),
    );
    const page = await rootUi({ now: T0, history: plays });
    render(<Popup ui={page.ui} />);

    const section = screen.getByRole('region', { name: 'Recently' });
    const rows = within(section).getAllByRole('button');
    expect(rows).toHaveLength(10);
    expect(rows[0]?.textContent).toContain('S2 E12');
    expect(rows[9]?.textContent).toContain('S2 E3');
  });

  test('What was sent shows the exact body, the answer, and the recorded title in the web app', async () => {
    const play = sentPlay('Severance · S2 E3', { ...ADDED, titleId: 'title-42' }, T0 - 60_000);
    const page = await rootUi({ now: T0, history: [play] });
    render(<Popup ui={page.ui} />);

    fireEvent.click(within(screen.getByRole('region', { name: 'Recently' })).getByRole('button'));

    const body = await screen.findByLabelText('What was sent');
    expect(JSON.parse(body.textContent)).toEqual(EPISODE);
    expect(page.sent).toContainEqual({ type: 'ui/what-was-sent', playId: play.playId });
    expect(screen.getAllByText(/Added/u).length).toBeGreaterThan(0);
    // A recorded play links to the title in the web app (WEB_ROUTES.title).
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toContain('http://localhost:3000/title/title-42');
  });

  test('What was sent for a play not sent yet shows its body too ("Couldn\'t send", with What was sent)', async () => {
    const queued = {
      playId: '01929a4e-9900-7000-8000-000000000099',
      viewingId: 'viewing-9',
      body: EPISODE,
      createdAt: T0 - 30_000,
      watchedAt: T0 - 30_000,
      attempts: 1,
      nextAttemptAt: T0 + 60_000,
      state: 'dead' as const,
      lastError: 'http_422',
    };
    const page = await rootUi({ now: T0, outbox: [queued] });
    render(<Popup ui={page.ui} />);

    const section = screen.getByRole('region', { name: 'Recently' });
    expect(within(section).getByText(/Couldn't send/u)).toBeTruthy();
    fireEvent.click(within(section).getByRole('button'));
    const body = await screen.findByLabelText('What was sent');
    expect(JSON.parse(body.textContent)).toEqual(EPISODE);
  });
});

describe('pause tracking', () => {
  const TZ = process.env.TZ;

  afterEach(() => {
    if (TZ === undefined) delete process.env.TZ;
    else process.env.TZ = TZ;
  });

  async function choose(label: RegExp, at: number): Promise<number | null> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    const page = fakeUi(state(null));
    render(<Popup ui={page.ui} />);
    fireEvent.click(screen.getByRole('button', { name: /Pause tracking/u }));
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => {
      expect(page.sent).toHaveLength(1);
    });
    const ask = page.sent[0];
    if (ask?.type !== 'ui/pause') throw new Error(`sent ${JSON.stringify(ask)}`);
    return ask.until;
  }

  test('for 1 hour: an hour from now', async () => {
    expect(await choose(/1 hour/u, T0)).toBe(T0 + 3_600_000);
  });

  test('until I turn it back on: PAUSE_INDEFINITELY', async () => {
    expect(await choose(/turn it back on/iu, T0)).toBe(PAUSE_INDEFINITELY);
  });

  // EU summer time ends on the last Sunday of October at 01:00 UTC: 2026-10-25.
  test('until tomorrow, across the autumn change: 06:00 CET, Berlin', async () => {
    process.env.TZ = 'Europe/Berlin';
    // Saturday 24 October, 23:00 CEST (21:00 UTC).
    expect(await choose(/tomorrow|morning/iu, Date.UTC(2026, 9, 24, 21, 0))).toBe(
      Date.UTC(2026, 9, 25, 5, 0),
    );
  });

  // And begins on the last Sunday of March at 01:00 UTC: 2027-03-28.
  test('until tomorrow, across the spring change: 06:00 CEST, Berlin', async () => {
    process.env.TZ = 'Europe/Berlin';
    // Saturday 27 March, 23:00 CET (22:00 UTC).
    expect(await choose(/tomorrow|morning/iu, Date.UTC(2027, 2, 27, 22, 0))).toBe(
      Date.UTC(2027, 2, 28, 4, 0),
    );
  });

  // The US changes on its own dates: the first Sunday of November, 2026-11-01, at 06:00 UTC.
  test('until tomorrow, across the US change: 06:00 EST, New York', async () => {
    process.env.TZ = 'America/New_York';
    // Saturday 31 October, 22:00 EDT (02:00 UTC on the 1st).
    expect(await choose(/tomorrow|morning/iu, Date.UTC(2026, 10, 1, 2, 0))).toBe(
      Date.UTC(2026, 10, 1, 11, 0),
    );
  });

  test('paused indefinitely: no time is shown for it (never formatted)', () => {
    render(<Popup ui={fakeUi(state(null, { pausedUntil: PAUSE_INDEFINITELY })).ui} />);
    const resume = screen.getByRole('button', { name: /Resume/u });
    const footer = resume.closest('footer');
    expect(footer?.textContent).not.toMatch(/\d/u);
    expect(footer?.textContent).not.toMatch(/Invalid/u);
  });

  test('Resume ends the pause (ui/pause with no end)', async () => {
    const page = fakeUi(state(null, { pausedUntil: Date.now() + 3_600_000 }));
    render(<Popup ui={page.ui} />);
    fireEvent.click(screen.getByRole('button', { name: /Resume/u }));
    await waitFor(() => {
      expect(page.sent).toEqual([{ type: 'ui/pause', until: null }]);
    });
  });
});

describe('accessibility (WCAG 2.2 AA)', () => {
  const STATES: readonly (readonly [string, PopupState])[] = [
    ['disconnected', state(null, { connection: { kind: 'none' } })],
    ['nothing playing', state(null)],
    ...NOW_PLAYING.map(([name, playing]) => [name, state(playing)] as const),
    [
      'broken connection',
      state(null, { connection: { kind: 'broken', reason: 'credential_invalid' } }),
    ],
    ['paused', state(TRACKING, { pausedUntil: PAUSE_INDEFINITELY })],
  ];

  test.each(STATES)('%s: no axe violations', async (_name, popupState) => {
    const { container } = render(<Popup ui={fakeUi(popupState).ui} />);
    const results = await axe(container);
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test('waiting, recently and the open pause menu: no axe violations', async () => {
    const waiting = sentPlay('Severance · S2 E3', WAITS, T0 - 60_000);
    const recorded = sentPlay('Severance · S2 E2', ADDED, T0 - 120_000);
    const page = await rootUi({ now: T0, history: [waiting, recorded] });
    const { container } = render(<Popup ui={page.ui} />);
    fireEvent.click(screen.getByRole('button', { name: /Pause tracking/u }));

    const results = await axe(container);
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test('What was sent: no axe violations', async () => {
    const recorded = sentPlay('Severance · S2 E2', ADDED, T0 - 120_000);
    const page = await rootUi({ now: T0, history: [recorded] });
    const { container } = render(<Popup ui={page.ui} />);
    fireEvent.click(within(screen.getByRole('region', { name: 'Recently' })).getByRole('button'));
    await screen.findByLabelText('What was sent');

    const results = await axe(container);
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
