/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *Pause tracking*: for 1 hour · until tomorrow (06:00 local) · until I turn it back
// on. While paused, the same place says until when and offers *Resume*. "Until I turn it back
// on" is `PAUSE_INDEFINITELY`, which is never formatted as a time (`isIndefinitePause`).

import { PAUSE_INDEFINITELY, isPaused } from '@mt/core';
import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';

import { t } from '../../i18n/t';
import type { UiResponse } from '../../messaging/protocol';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { inOneHour, nextMorning, pauseEnd, sameDay, timeOfDay } from '../format';
import type { UiAsk } from '../store';

export function PauseMenu({
  pausedUntil,
  now,
  send,
}: {
  readonly pausedUntil: number | null;
  readonly now: number;
  readonly send: (ask: UiAsk) => Promise<UiResponse>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  const pause = (until: number | null): void => {
    setBusy(true);
    setFailed(false);
    void send({ type: 'ui/pause', until }).then((response) => {
      setBusy(false);
      if (response.ok) setOpen(false);
      else setFailed(true);
    });
  };

  const paused = pausedUntil !== null && isPaused(pausedUntil, now);
  const failure = failed ? (
    <p role="alert" class="mt-1 px-2 text-caption text-muted-foreground">
      {t('popup.pause.failed')}
    </p>
  ) : null;

  if (paused) {
    return (
      <Paused
        end={pauseEnd(pausedUntil, now)}
        busy={busy}
        onResume={() => {
          pause(null);
        }}
      >
        {failure}
      </Paused>
    );
  }

  const choices = pauseChoices(now);
  return (
    <footer
      class="border-t border-border px-2 py-2"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          toggle.current?.focus();
        }
      }}
    >
      <button
        ref={toggle}
        type="button"
        aria-expanded={open}
        aria-controls="pause-choices"
        onClick={() => {
          setOpen(!open);
        }}
        class="flex w-full items-center justify-between gap-2 rounded-xl px-2 py-2 text-body-s font-medium transition-colors duration-state ease-app hover:bg-secondary"
      >
        <span class="flex items-center gap-2">
          <Icon name="pause" class="text-muted-foreground" />
          {t('popup.pause.toggle')}
        </span>
        <Icon
          name="chevron-down"
          class={`text-muted-foreground transition-transform duration-open ease-app ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? (
        <ul id="pause-choices" class="pb-1">
          {choices.map((choice) => (
            <li key={choice.key}>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  pause(choice.until());
                }}
                class="w-full rounded-xl py-2 ps-9 pe-2 text-start text-body-s transition-colors duration-state ease-app hover:bg-secondary disabled:opacity-50"
              >
                {choice.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {failure}
    </footer>
  );
}

/** The three ways to pause, in words, each with the moment it ends. */
function pauseChoices(now: number): readonly {
  readonly key: string;
  readonly label: string;
  readonly until: () => number;
}[] {
  const morning = nextMorning(now);
  const morningTime = timeOfDay(morning);
  return [
    { key: 'hour', label: t('popup.pause.hour'), until: () => inOneHour(Date.now()) },
    {
      key: 'morning',
      // After midnight the next 06:00 is this morning's: the words say which.
      label: sameDay(morning, now)
        ? t('popup.pause.morning_today', { time: morningTime })
        : t('popup.pause.morning', { time: morningTime }),
      // Computed again at the click: the menu may have stayed open across 06:00.
      until: () => nextMorning(Date.now()),
    },
    { key: 'indefinitely', label: t('popup.pause.indefinitely'), until: () => PAUSE_INDEFINITELY },
  ];
}

/** While paused: until when, and *Resume*. `end` is `null` for "until I turn it back on". */
function Paused({
  end,
  busy,
  onResume,
  children,
}: {
  readonly end: string | null;
  readonly busy: boolean;
  readonly onResume: () => void;
  readonly children: ComponentChildren;
}) {
  return (
    <footer class="border-t border-border px-4 py-3">
      <div class="flex items-center justify-between gap-3">
        <p class="flex min-w-0 items-center gap-2 text-body-s">
          <Icon name="pause" class="text-muted-foreground" />
          <span class="min-w-0">
            {end === null
              ? t('popup.pause.paused_indefinitely')
              : t('popup.pause.paused_until', { until: end })}
          </span>
        </p>
        <Button size="sm" variant="primary" disabled={busy} onClick={onResume}>
          <Icon name="play" size={14} />
          {t('popup.pause.resume')}
        </Button>
      </div>
      {children}
    </footer>
  );
}
