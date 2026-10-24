/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// *Connection* in the settings page, with what the server last said about it: the real expiry
// date in place of the estimate, and `braked` / `suspended` in words. And *Disconnect from this
// browser*: what it says it removes, and the choice it offers while plays wait.

import type { ConnectionState } from '@mt/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, test } from 'vitest';

import type { ConnectionCheckView, UiResponse } from '../../messaging/protocol';
import { day } from '../format';
import type { UiAsk } from '../store';
import { axe, connectedState } from '../test-harness';
import { ConnectionSection } from './ConnectionSection';

afterEach(cleanup);

const send = () => Promise.resolve({ ok: true } as const);
const NOW = Date.UTC(2026, 9, 22, 12);
const DAY_MS = 86_400_000;
const REAL = Date.UTC(2027, 2, 14, 12);
const CONNECTIONS = 'http://localhost:3000/settings?tab=connections';

function check(extra: Partial<ConnectionCheckView> = {}): ConnectionCheckView {
  return { status: 'active', expiresAt: REAL, checkedAt: NOW, ...extra };
}

describe('the expiry date', () => {
  test("after a check, the server's date is shown as the date the connection ends", () => {
    const connection = { ...connectedState(NOW), expiresAt: REAL };
    render(<ConnectionSection connection={connection} check={check()} unsent={0} send={send} />);

    expect(screen.getByText('Connection ends')).toBeTruthy();
    expect(screen.getByText(day(REAL))).toBeTruthy();
    expect(screen.queryByText('Reconnect needed by')).toBeNull();
  });

  test('the server says there is no end: that is said, not a date', () => {
    render(
      <ConnectionSection
        connection={connectedState(NOW)}
        check={check({ expiresAt: null })}
        unsent={0}
        send={send}
      />,
    );
    expect(screen.getByText('Connection ends')).toBeTruthy();
    expect(screen.getByText('No end date')).toBeTruthy();
  });

  test('a personal token has a real date once the server has said it', () => {
    const connection = { ...connectedState(NOW), strategy: 'personal_token' as const };
    render(<ConnectionSection connection={connection} check={check()} unsent={0} send={send} />);
    expect(screen.getByText('Connection ends')).toBeTruthy();
    expect(screen.getByText(day(REAL))).toBeTruthy();
  });

  test('before any check: the estimate for a window sign-in, nothing for a token', () => {
    const { unmount } = render(
      <ConnectionSection connection={connectedState(NOW)} check={null} unsent={0} send={send} />,
    );
    expect(screen.getByText('Reconnect needed by')).toBeTruthy();
    unmount();

    const token = { ...connectedState(NOW), strategy: 'personal_token' as const };
    render(<ConnectionSection connection={token} check={null} unsent={0} send={send} />);
    expect(screen.queryByText('Reconnect needed by')).toBeNull();
    expect(screen.queryByText('Connection ends')).toBeNull();
  });
});

describe('braked and suspended', () => {
  test('braked: paused, plays held, and the link to review it', () => {
    render(
      <ConnectionSection
        connection={connectedState(NOW)}
        check={check({ status: 'braked' })}
        unsent={0}
        send={send}
      />,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/paused this connection/u);
    expect(within(status).getByRole('link', { name: /Connected services/u })).toBeTruthy();
  });

  test('suspended: the account is being deleted', () => {
    render(
      <ConnectionSection
        connection={connectedState(NOW)}
        check={check({ status: 'suspended', expiresAt: NOW + DAY_MS })}
        unsent={0}
        send={send}
      />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/account is being deleted/u);
  });

  test('active: no status', () => {
    render(
      <ConnectionSection connection={connectedState(NOW)} check={check()} unsent={0} send={send} />,
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('has no accessibility violations while braked', async () => {
    const { container } = render(
      <ConnectionSection
        connection={connectedState(NOW)}
        check={check({ status: 'braked' })}
        unsent={0}
        send={send}
      />,
    );
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('Disconnect from this browser', () => {
  /** The section, its *Disconnect* pressed once: the confirmation is open. */
  function confirming(
    connection: ConnectionState,
    unsent: number,
    answer: UiResponse = { ok: true, data: { sent: 0, deleted: 0 } },
  ) {
    const sent: UiAsk[] = [];
    const recorded = (ask: UiAsk): Promise<UiResponse> => {
      sent.push(ask);
      return Promise.resolve(answer);
    };
    const view = render(
      <ConnectionSection connection={connection} check={null} unsent={unsent} send={recorded} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect from this browser' }));
    return { sent, view, group: screen.getByRole('group') };
  }

  test('it says what goes, what stays, and where the sent plays are removed', () => {
    const { group } = confirming(connectedState(NOW), 0);
    expect(group.textContent).toMatch(/forgets its connection and its key/u);
    expect(group.textContent).toMatch(/history under Recently/u);
    expect(group.textContent).toMatch(/what you're watching now/u);
    expect(group.textContent).toMatch(/plays not sent yet/u);
    expect(group.textContent).toMatch(/Your settings and sites stay/u);
    expect(group.textContent).toMatch(/Plays already sent stay in your MediaTracker account/u);
    expect(
      within(group)
        .getByRole('link', { name: /Connected services/u })
        .getAttribute('href'),
    ).toBe(CONNECTIONS);
  });

  test('connected, nothing waiting: one act, which deletes', async () => {
    const { sent, group } = confirming(connectedState(NOW), 0);
    expect(within(group).queryByRole('button', { name: /first/u })).toBeNull();

    fireEvent.click(within(group).getByRole('button', { name: 'Disconnect from this browser' }));

    await waitFor(() => {
      expect(sent).toEqual([{ type: 'ui/disconnect', sendFirst: false }]);
    });
  });

  test('connected, two waiting: send first is offered first, and is what it does', async () => {
    const { sent, group } = confirming(connectedState(NOW), 2, {
      ok: true,
      data: { sent: 1, deleted: 1 },
    });
    expect(group.textContent).toMatch(/2 plays haven't been sent yet/u);
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Send 2 first, then disconnect',
      'Disconnect and delete them',
      'Cancel',
    ]);

    fireEvent.click(within(group).getByRole('button', { name: 'Send 2 first, then disconnect' }));

    await waitFor(() => {
      expect(sent).toEqual([{ type: 'ui/disconnect', sendFirst: true }]);
    });
    // What happened is said: what went, and what did not and was deleted.
    const status = await screen.findByText(/^Disconnected\./u);
    const said = status.parentElement?.textContent ?? '';
    expect(said).toMatch(/1 play was sent first/u);
    expect(said).toMatch(/1 play couldn't be sent and was deleted/u);
  });

  test('connected, two waiting: delete them is the other answer', async () => {
    const { sent, group } = confirming(connectedState(NOW), 2);

    fireEvent.click(within(group).getByRole('button', { name: 'Disconnect and delete them' }));

    await waitFor(() => {
      expect(sent).toEqual([{ type: 'ui/disconnect', sendFirst: false }]);
    });
  });

  test('broken: nothing can be sent, so only Disconnect and delete, and it says why', async () => {
    const { sent, group } = confirming({ kind: 'broken', reason: 'credential_invalid' }, 1);
    expect(group.textContent).toMatch(/Without a working connection it can't be sent/u);
    expect(within(group).queryByRole('button', { name: /first/u })).toBeNull();

    fireEvent.click(within(group).getByRole('button', { name: 'Disconnect and delete it' }));

    await waitFor(() => {
      expect(sent).toEqual([{ type: 'ui/disconnect', sendFirst: false }]);
    });
  });

  test('Connect waits while the confirmation is open', () => {
    confirming(connectedState(NOW), 2);
    const reconnect = screen.queryByRole('button', { name: 'Reconnect' });
    if (reconnect !== null) expect((reconnect as HTMLButtonElement).disabled).toBe(true);
  });

  test('the confirmation, in both connection states, has no accessibility violations', async () => {
    const { view } = confirming(connectedState(NOW), 2);
    expect((await axe(view.container)).violations).toEqual([]);
    cleanup();
    const broken = confirming({ kind: 'broken', reason: 'key_missing' }, 2);
    expect((await axe(broken.view.container)).violations).toEqual([]);
  });
});
