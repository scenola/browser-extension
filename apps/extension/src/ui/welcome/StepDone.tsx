/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Step 3, *Done*: "Watch something — it's added once you've watched enough of it." And a pointer to
// pin the icon, which an extension cannot do for itself — unless Chrome says it is pinned already.

import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';

import { t } from '../../i18n/t';
import { Button } from '../components/Button';
import { Icon, Mark } from '../components/Icon';

/** Whether the toolbar button is pinned; `null` when Chrome does not say. */
function usePinned(): boolean | null {
  const [pinned, setPinned] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    browser.action
      .getUserSettings()
      .then((settings) => {
        if (current) setPinned(settings.isOnToolbar);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  return pinned;
}

function closeTab(): void {
  void browser.tabs
    .getCurrent()
    .then(async (tab) => {
      if (tab?.id === undefined) window.close();
      else await browser.tabs.remove(tab.id);
    })
    .catch(() => {
      window.close();
    });
}

export function StepDone({ onBack }: { readonly onBack: () => void }) {
  const pinned = usePinned();
  // Pinned, the card says one line, centred on the mark; else a title and its steps, the mark
  // beside the title.
  const oneLine = pinned === true;
  return (
    <>
      <h1
        tabIndex={-1}
        class="font-display text-display-l font-semibold tracking-[-0.015em] text-balance"
      >
        {t('welcome.done.title')}
      </h1>
      <p class="mt-3 max-w-[32rem] text-body text-muted-foreground">{t('welcome.done.body')}</p>

      <div
        class={`mt-8 flex max-w-[32rem] gap-4 rounded-[20px] border border-border bg-card p-5 ${oneLine ? 'items-center' : 'items-start'}`}
      >
        <span
          class={`flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary ${oneLine ? '' : 'mt-0.5'}`}
        >
          <Mark size={20} />
        </span>
        <div class="min-w-0">
          <p class="text-body-s font-medium">
            {oneLine ? t('welcome.done.pinned') : t('welcome.done.pin_title')}
          </p>
          {oneLine ? null : (
            <p class="mt-1 text-body-s text-muted-foreground">{t('welcome.done.pin_body')}</p>
          )}
        </div>
      </div>

      <div class="mt-8 flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" onClick={closeTab}>
          <Icon name="check" />
          {t('welcome.done.close')}
        </Button>
        <Button
          variant="ghost"
          size="lg"
          onClick={() => {
            void browser.runtime.openOptionsPage();
          }}
        >
          {t('welcome.done.settings')}
        </Button>
        <Button variant="ghost" size="lg" onClick={onBack}>
          {t('welcome.back')}
        </Button>
      </div>
    </>
  );
}
