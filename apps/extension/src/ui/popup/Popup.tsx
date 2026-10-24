/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The popup (360 × up to 560 px): the header — the product, the connection's state,
// the way to settings — then *Now playing*, *Waiting for you*, *Recently* and *Pause tracking*.
// Not connected, it shows only *Connect*, which opens the welcome page: the sign-in window
// belongs to a page that stays open, not to a popup that closes when the window takes focus.
// Everything it shows is the worker's latest `ui/state`, pushed over the `ui` port.

import { expiringSoon, isPaused } from '@mt/core';
import type { ConnectionState } from '@mt/core';
import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';

import { t } from '../../i18n/t';
import type { ConnectionCheckView, PopupState, UiResponse } from '../../messaging/protocol';
import { Button, IconButton } from '../components/Button';
import { CheckNotice } from '../components/CheckNotice';
import { Icon, Mark } from '../components/Icon';
import { isPersonalToken } from '../personal-token';
import { SETTINGS_ANCHORS, openSettingsAt } from '../settings-anchors';
import type { UiAsk, UiConnection } from '../store';
import { NowPlaying } from './NowPlaying';
import { PauseMenu } from './PauseMenu';
import { RecentList } from './RecentList';
import { SiteCard } from './SiteCard';
import { WaitingList } from './WaitingList';
import { WhatWasSent } from './WhatWasSent';

/** Opens the welcome page in a tab, and closes the popup behind it. */
function openWelcome(): void {
  // A path is the extension's own page (the worker opens it the same way on install).
  void browser.tabs.create({ url: '/welcome.html' }).finally(() => {
    window.close();
  });
}

/** Opens (or focuses) the settings page — where *Reconnect* is — and closes the popup. */
function openSettings(): void {
  void browser.runtime.openOptionsPage().finally(() => {
    window.close();
  });
}

export function Popup({ ui }: { readonly ui: UiConnection }) {
  const state = ui.state.value;
  const now = Date.now();
  const send = useCallback((ask: UiAsk) => ui.send(ask), [ui]);

  return (
    <div class="flex max-h-[560px] w-[360px] flex-col">
      <Header connection={state?.connection ?? null} />
      {state === null ? (
        <div class="min-h-32" aria-busy="true" />
      ) : state.connection.kind === 'none' ? (
        <Disconnected />
      ) : (
        <Connected state={state} now={now} send={send} />
      )}
    </div>
  );
}

function Header({ connection }: { readonly connection: ConnectionState | null }) {
  return (
    <header class="glass sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 ps-4 pe-2">
      <Mark size={20} />
      <span class="font-display text-display-s font-semibold tracking-[-0.01em]">
        {t('common.product')}
      </span>
      <span class="flex-1" />
      {connection === null || connection.kind === 'none' ? null : (
        <span class="flex items-center gap-1.5 text-caption text-foreground">
          <Icon name={connection.kind === 'connected' ? 'check' : 'alert'} size={14} />
          {connection.kind === 'connected'
            ? t('popup.header.connected')
            : t('popup.header.reconnect_needed')}
        </span>
      )}
      {connection === null || connection.kind === 'none' ? null : (
        <IconButton label={t('popup.header.settings')} onClick={openSettings}>
          <Icon name="settings" size={18} />
        </IconButton>
      )}
    </header>
  );
}

function Disconnected() {
  return (
    <main class="flex flex-col items-start gap-3 px-5 pt-6 pb-6">
      <h1 class="font-display text-display-m font-semibold tracking-[-0.01em]">
        {t('popup.disconnected.title')}
      </h1>
      <p class="text-body-s text-muted-foreground">{t('popup.disconnected.body')}</p>
      <Button variant="primary" size="md" class="mt-2 w-full" onClick={openWelcome}>
        {t('common.connect')}
      </Button>
    </main>
  );
}

/** A problem the person can fix from here: the connection must be made again, or soon. */
function ConnectionNotice({
  connection,
  check,
  now,
}: {
  readonly connection: ConnectionState;
  readonly check: ConnectionCheckView | null;
  readonly now: number;
}) {
  const broken = connection.kind === 'broken';
  // A window connection's expiry is our sliding estimate until the server answers, and its date
  // afterwards. A personal token's expiry is not ours to estimate (the person chose it), so it is
  // warned about only once the server has said the date; "no end" warns about nothing.
  const dated =
    connection.kind === 'connected' &&
    (check === null ? !isPersonalToken(connection.strategy) : check.expiresAt !== null);
  if (!broken && !(dated && expiringSoon(connection, now))) return null;
  return (
    <div role="note" class="mx-3 mt-3 flex items-start gap-3 rounded-2xl bg-secondary p-3">
      <Icon name="alert" class="mt-0.5 text-lamp" />
      <p class="min-w-0 flex-1 text-body-s">
        {connection.kind !== 'broken'
          ? t('status.connection_expiring')
          : connection.reason === 'credential_invalid'
            ? t('popup.notice.revoked')
            : t('status.connection_broken')}
      </p>
      <Button size="sm" variant="primary" onClick={openSettings}>
        {t('common.reconnect')}
      </Button>
    </div>
  );
}

function Connected({
  state,
  now,
  send,
}: {
  readonly state: PopupState;
  readonly now: number;
  readonly send: (ask: UiAsk) => Promise<UiResponse>;
}) {
  const [opened, setOpened] = useState<{ readonly playId: string; readonly label: string } | null>(
    null,
  );
  const returnTo = useRef<string | null>(null);
  const paused = state.pausedUntil !== null && isPaused(state.pausedUntil, now);

  // Back from *What was sent*: the focus returns to the row that opened it, as soon as the list
  // is in the document again (before the next paint).
  useLayoutEffect(() => {
    const id = returnTo.current;
    if (opened !== null || id === null) return;
    returnTo.current = null;
    document.querySelector<HTMLButtonElement>(`button[data-play-id="${CSS.escape(id)}"]`)?.focus();
  }, [opened]);

  if (opened !== null) {
    return (
      <main class="min-h-0 flex-1 overflow-y-auto">
        <WhatWasSent
          playId={opened.playId}
          label={opened.label}
          send={send}
          onBack={() => {
            setOpened(null);
          }}
        />
      </main>
    );
  }

  return (
    <>
      <main class="min-h-0 flex-1 overflow-y-auto">
        <ConnectionNotice connection={state.connection} check={state.connectionCheck} now={now} />
        <CheckNotice check={state.connectionCheck} class="mx-3 mt-3" />
        {state.nowPlaying === null ? (
          <section aria-labelledby="now-playing-heading" class="px-4 py-4">
            <h2 id="now-playing-heading" class="text-micro font-semibold text-muted-foreground">
              {t('popup.now.nothing_heading')}
            </h2>
            <p class="mt-1 text-body-s text-muted-foreground" aria-live="polite">
              {paused ? t('popup.now.state.paused') : t('popup.now.nothing')}
            </p>
          </section>
        ) : (
          <NowPlaying
            playing={state.nowPlaying}
            paused={paused}
            finishPercent={state.accountRule.finishThresholdPercent}
            send={send}
            onOpenSettings={openSettingsAt}
          />
        )}
        {/* A turned-off service is turned back on at its switch. */}
        <SiteCard
          site={state.site}
          send={send}
          onOpenSettings={() => {
            openSettingsAt(SETTINGS_ANCHORS.services);
          }}
        />
        <WaitingList rows={state.waiting} />
        <RecentList
          entries={state.recent}
          now={now}
          onOpen={(playId) => {
            const entry = state.recent.find((e) => e.playId === playId);
            returnTo.current = playId;
            setOpened({ playId, label: entry?.label ?? '' });
          }}
        />
      </main>
      <PauseMenu pausedUntil={state.pausedUntil} now={now} send={send} />
    </>
  );
}
