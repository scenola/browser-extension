/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *Recently*: the last ten plays with MediaTracker's verdict in words, and when. Each row opens
// *What was sent* — the exact body, the time and the answer — the transparency promise one tap
// away. The glyph repeats the verdict's tone; the words carry it.

import type { ReceiptView } from '@mt/core';

import { t } from '../../i18n/t';
import type { HistoryEntryView } from '../../messaging/protocol';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { shortMoment } from '../format';

const TONE_ICON: Readonly<Record<ReceiptView['tone'], IconName>> = {
  done: 'check',
  waiting: 'clock',
  attention: 'alert',
  neutral: 'circle',
};

const TONE_CLASS: Readonly<Record<ReceiptView['tone'], string>> = {
  done: 'text-foreground',
  waiting: 'text-muted-foreground',
  attention: 'text-lamp',
  neutral: 'text-muted-foreground',
};

export function RecentList({
  entries,
  now,
  onOpen,
}: {
  readonly entries: readonly HistoryEntryView[];
  readonly now: number;
  /** Opens *What was sent* for a play; the row is handed back so focus can return to it. */
  readonly onOpen: (playId: string, row: HTMLButtonElement) => void;
}) {
  return (
    <section aria-labelledby="recent-heading" class="border-t border-border px-2 py-3">
      <h2 id="recent-heading" class="px-2 text-micro font-semibold text-muted-foreground">
        {t('popup.recent.heading')}
      </h2>
      {entries.length === 0 ? (
        <p class="px-2 pt-1.5 pb-1 text-body-s text-muted-foreground">{t('popup.recent.empty')}</p>
      ) : (
        <ul class="mt-1">
          {entries.map((entry) => (
            <li key={entry.playId}>
              <button
                type="button"
                data-play-id={entry.playId}
                onClick={(event) => {
                  onOpen(entry.playId, event.currentTarget);
                }}
                class="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-start transition-colors duration-state ease-app hover:bg-secondary"
              >
                <Icon name={TONE_ICON[entry.view.tone]} class={TONE_CLASS[entry.view.tone]} />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-body-s">
                    {entry.label === '' ? t('popup.entry.untitled') : entry.label}
                  </span>
                  <span class="block truncate text-caption text-muted-foreground">
                    {/* A film begun is its own line, labelled so: it is not a viewing added. */}
                    {t(entry.start ? 'popup.recent.started' : 'popup.recent.verdict', {
                      verdict: t(entry.view.messageKey),
                      when: shortMoment(entry.sentAt, now),
                    })}
                  </span>
                </span>
                <Icon name="chevron-end" class="text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
