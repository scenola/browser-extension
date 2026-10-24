/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The settings page, seen rarely: Connection, Sites, Counting, Privacy, Diagnostics, About — one
// column of grouped rows, with the sections' names beside it on a wide window. Every value it
// shows comes from the worker, and every change goes through it (`ui/settings`). Opened at an
// anchor (`SETTINGS_ANCHORS`, or a section's id), it starts there.

import { useCallback, useEffect } from 'preact/hooks';

import { t } from '../../i18n/t';
import type { AppMessageKey } from '../../i18n/t';
import { Mark } from '../components/Icon';
import { useSettings } from '../data';
import { followAnchor } from '../settings-anchors';
import type { UiAsk, UiConnection } from '../store';
import { AboutSection } from './AboutSection';
import { ConnectionSection } from './ConnectionSection';
import { CountingSection } from './CountingSection';
import { DiagnosticsSection } from './DiagnosticsSection';
import { PrivacySection } from './PrivacySection';
import { SitesSection } from './SitesSection';

const SECTIONS: readonly (readonly [string, AppMessageKey])[] = [
  ['connection', 'options.connection.title'],
  ['sites', 'options.sites.title'],
  ['counting', 'options.counting.title'],
  ['privacy', 'options.privacy.title'],
  ['diagnostics', 'options.diagnostics.title'],
  ['about', 'options.about.title'],
];

export function Options({ ui }: { readonly ui: UiConnection }) {
  const send = useCallback((ask: UiAsk) => ui.send(ask), [ui]);
  const { settings, patch } = useSettings(ui);
  const connection = ui.state.value?.connection ?? null;
  // Opened at a section (`options.html#capture`): there, its heading focused.
  useEffect(followAnchor, []);

  return (
    <div class="min-h-dvh bg-background">
      <header class="glass sticky top-0 z-10">
        <div class="mx-auto flex h-16 max-w-[64rem] items-center gap-2.5 px-6">
          <Mark size={22} />
          <span class="font-display text-display-s font-semibold tracking-[-0.01em]">
            {t('common.extension')}
          </span>
          <span class="text-display-s text-muted-foreground" aria-hidden="true">
            /
          </span>
          <h1 class="text-display-s font-medium text-foreground">{t('options.heading')}</h1>
        </div>
      </header>

      <div class="mx-auto grid max-w-[64rem] gap-10 px-6 pt-10 pb-20 lg:grid-cols-[11rem_1fr]">
        <nav aria-label={t('options.nav_label')} class="hidden lg:block">
          <ul class="sticky top-24 flex flex-col gap-0.5">
            {SECTIONS.map(([id, key]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  class="block rounded-full px-3 py-1.5 text-body-s text-muted-foreground transition-colors duration-state ease-app hover:bg-secondary hover:text-foreground"
                >
                  {t(key)}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <main class="flex min-w-0 max-w-[46rem] flex-col gap-14">
          <ConnectionSection
            connection={connection}
            check={ui.state.value?.connectionCheck ?? null}
            unsent={ui.state.value?.unsent ?? 0}
            send={send}
          />
          <SitesSection settings={settings} patch={patch} />
          <CountingSection rule={ui.state.value?.accountRule ?? null} />
          <PrivacySection settings={settings} patch={patch} send={send} />
          <DiagnosticsSection settings={settings} patch={patch} send={send} />
          <AboutSection />
        </main>
      </div>
    </div>
  );
}
