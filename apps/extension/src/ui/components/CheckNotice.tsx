/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the server last said about the connection, when it is not "all well": `braked` — paused
// for the person to review, plays held — and `suspended` — the account is being deleted, so new
// plays are not kept. A polite status (it appears when a check answers), with a glyph and words,
// never a colour alone. `active`, or no answer yet, renders nothing.

import { WEB_APP_BASE_URL } from '../../config';
import { t } from '../../i18n/t';
import type { ConnectionCheckView } from '../../messaging/protocol';
import { WEB_ROUTES } from '../../web-routes';
import { Icon } from './Icon';
import { Link } from './Link';

const CONNECTIONS_URL = `${WEB_APP_BASE_URL}${WEB_ROUTES.connections}`;

export function CheckNotice({
  check,
  class: className = '',
}: {
  readonly check: ConnectionCheckView | null;
  readonly class?: string;
}) {
  if (check === null || check.status === 'active') return null;
  return (
    <div role="status" class={`flex items-start gap-3 rounded-2xl bg-secondary p-3 ${className}`}>
      <Icon name="alert" class="mt-0.5 shrink-0 text-lamp" />
      <div class="min-w-0 flex-1 text-body-s">
        <p>{check.status === 'braked' ? t('status.check.braked') : t('status.check.suspended')}</p>
        <Link href={CONNECTIONS_URL} class="mt-1.5">
          {t('connect.link.connections')}
        </Link>
      </div>
    </div>
  );
}
