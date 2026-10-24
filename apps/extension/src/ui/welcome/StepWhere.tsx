/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Step 2, *Where to track*: the seven built-in services are already on — their access came with
// the install. The step asks for nothing: another site is allowed one at a time from the popup,
// and *All sites* is an advanced setting on the settings page.

import { t } from '../../i18n/t';
import { SITES } from '../../sites';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';

export function StepWhere({
  onDone,
  onBack,
}: {
  readonly onDone: () => void;
  readonly onBack: () => void;
}) {
  return (
    <>
      <h1
        tabIndex={-1}
        class="font-display text-display-l font-semibold tracking-[-0.015em] text-balance"
      >
        {t('welcome.where.title')}
      </h1>
      <p class="mt-3 max-w-[32rem] text-body text-muted-foreground">{t('welcome.where.body')}</p>

      <ul
        class="mt-6 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2"
        aria-label={t('welcome.where.services')}
      >
        {SITES.sites.map((site) => (
          <li key={site.id} class="flex items-center gap-2 text-body">
            <Icon name="check" class="text-muted-foreground" />
            {site.name}
          </li>
        ))}
      </ul>

      <p class="mt-6 max-w-[32rem] text-body-s text-muted-foreground">{t('welcome.where.later')}</p>

      <div class="mt-8 flex items-center gap-3">
        <Button variant="primary" size="lg" onClick={onDone}>
          {t('welcome.continue')}
        </Button>
        <Button variant="ghost" size="lg" onClick={onBack}>
          {t('welcome.back')}
        </Button>
      </div>
    </>
  );
}
