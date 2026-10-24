/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *This site*: the site of the tab the popup opened over, when it is one the extension does not
// track yet. *Track this site* asks Chrome for that one origin — the request is the click's
// first act, before any `await`, because Chrome shows a permission prompt only for the person's
// own gesture — and then tells the worker. A built-in service the person turned off is not
// offered the button (it would not turn it back on): it points to settings.

import { useState } from 'preact/hooks';
import { browser } from 'wxt/browser';

import { t } from '../../i18n/t';
import type { ActiveSite, UiResponse } from '../../messaging/protocol';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import type { UiAsk } from '../store';

type Note = 'declined' | 'failed' | null;

export function SiteCard({
  site,
  send,
  onOpenSettings,
}: {
  readonly site: ActiveSite | null;
  readonly send: (ask: UiAsk) => Promise<UiResponse>;
  readonly onOpenSettings: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  if (site === null || (site.tracking !== 'trackable' && site.tracking !== 'turned_off')) {
    return null;
  }

  const track = (pattern: string, origin: string): void => {
    // Nothing may run before this line in the click: it spends the gesture. The pattern is the
    // worker's (`ActiveSite.pattern`): an origin with a port is not a match pattern.
    const asked = browser.permissions.request({ origins: [pattern] });
    setBusy(true);
    setNote(null);
    void asked
      .then(async (granted) => {
        if (!granted) {
          setNote('declined');
          return;
        }
        const response = await send({ type: 'ui/track-site', origin });
        if (!response.ok) setNote('failed');
      })
      .catch(() => {
        setNote('failed');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section aria-labelledby="this-site-heading" class="border-t border-border px-4 py-3">
      <h2 id="this-site-heading" class="text-micro font-semibold text-muted-foreground">
        {t('popup.site.heading')}
      </h2>
      <div class="mt-1.5 flex min-h-8 items-center justify-between gap-3">
        <p class="flex min-w-0 items-center gap-2 text-body-s">
          <Icon name="circle" class="shrink-0 text-muted-foreground" />
          <span class="[overflow-wrap:anywhere]">
            {site.tracking === 'trackable'
              ? t('popup.site.not_tracked', { site: site.name })
              : t('popup.site.turned_off', { site: site.name })}
          </span>
        </p>
        {site.tracking === 'trackable' && site.pattern !== null ? (
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => {
              if (site.pattern !== null) track(site.pattern, site.origin);
            }}
          >
            {t('popup.now.track_site')}
          </Button>
        ) : site.tracking === 'turned_off' ? (
          <Button size="sm" variant="secondary" onClick={onOpenSettings}>
            {t('popup.site.open_settings')}
          </Button>
        ) : null}
      </div>
      {note === null ? null : (
        <p role="alert" class="mt-2 text-caption text-muted-foreground">
          {note === 'declined' ? t('popup.now.track_declined') : t('popup.now.track_failed')}
        </p>
      )}
    </section>
  );
}
