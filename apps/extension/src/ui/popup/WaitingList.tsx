/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *Waiting for you*: the questions MediaTracker is asking the person, one row each however many
// plays one answer settles, with one link to Up Next in the web app. It is the popup's one
// signal, so its glyph is the lamp; the words beside it say the same. It disappears when every
// play is answered.

import { t } from '../../i18n/t';
import type { WaitingRow } from '../../messaging/protocol';
import { Icon } from '../components/Icon';
import { Link } from '../components/Link';

function words(row: WaitingRow): string {
  const label = row.label === '' ? t('popup.entry.untitled') : row.label;
  return row.more > 0 ? t('popup.waiting.more', { label, count: row.more }) : label;
}

export function WaitingList({ rows }: { readonly rows: readonly WaitingRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="waiting-heading" class="border-t border-border px-4 py-3">
      <h2 id="waiting-heading" class="text-micro font-semibold text-muted-foreground">
        {t('popup.waiting.heading')}
      </h2>
      <ul class="mt-1">
        {rows.map((row) => (
          <li key={row.id} class="flex min-h-10 items-center gap-2.5 py-1">
            <Icon name="clock" class="text-lamp" />
            <span class="min-w-0 flex-1 truncate text-body-s">{words(row)}</span>
            {row.count > 1 ? (
              <span class="shrink-0 text-caption text-muted-foreground">
                {t('popup.waiting.count', { count: row.count })}
              </span>
            ) : null}
            <Link href={row.href} class="shrink-0 text-caption">
              {t('receipt.needs_confirmation')}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
