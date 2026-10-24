/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The all-sites switch, the settings page's Advanced setting. Turning it on asks Chrome for every
// site — and the request is the click's first act, before any `await`, because Chrome shows a
// permission prompt only for the person's own gesture. The worker then mirrors the grant into the
// settings and registers the bootstrap on it. Turning it off gives the access back.

import { useState } from 'preact/hooks';
import { browser } from 'wxt/browser';

import { ALL_SITES_PATTERNS } from '../host-patterns';
import { t } from '../i18n/t';
import type { SettingsPatch, UiResponse } from '../messaging/protocol';

export type AllSitesNote = 'declined' | 'failed' | null;

export function useAllSites(on: boolean, patch: (p: SettingsPatch) => Promise<UiResponse>) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<AllSitesNote>(null);

  const toggle = (): void => {
    if (on) {
      setBusy(true);
      setNote(null);
      void patch({ allSites: false })
        .then((response) => {
          if (!response.ok) setNote('failed');
        })
        .finally(() => {
          setBusy(false);
        });
      return;
    }
    // Nothing may run before this line in the click: it spends the gesture.
    const asked = browser.permissions.request({ origins: [...ALL_SITES_PATTERNS] });
    setBusy(true);
    setNote(null);
    void asked
      .then(async (granted) => {
        if (!granted) {
          setNote('declined');
          return;
        }
        const response = await patch({ allSites: true });
        if (!response.ok) setNote('failed');
      })
      .catch(() => {
        setNote('failed');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return { busy, note, toggle };
}

export function AllSitesError({ note }: { readonly note: AllSitesNote }) {
  if (note === null) return null;
  return (
    <p role="alert" class="mt-2 text-caption text-muted-foreground">
      {note === 'declined' ? t('sites.all.declined') : t('sites.all.failed')}
    </p>
  );
}
