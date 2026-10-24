/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *Counting*: the account's two lines, read-only — when a film or an episode is added, and when a
// film begun is saved in progress — with one way to the app where both are changed. The extension
// cannot change them: a leaked extension credential must never change the account's settings, so
// writing them needs a person signed in to the app.

import type { AccountRule } from '@mt/core';

import { WEB_APP_BASE_URL } from '../../config';
import { t } from '../../i18n/t';
import { WEB_ROUTES } from '../../web-routes';
import { Card, Row } from '../components/Card';
import { Link } from '../components/Link';
import { Section } from './Section';

/** The account's start line in words: the line it draws, or off. */
function startWords(rule: AccountRule): string {
  const percent = rule.startThresholdPercent;
  if (percent === null) return t('options.counting.start_off');
  if (rule.startFloorSeconds === 0) return t('options.counting.start_on_any', { percent });
  return t('options.counting.start_on', { percent, minutes: rule.startFloorSeconds / 60 });
}

export function CountingSection({
  rule,
}: {
  /** The account's rule as the worker last read it; `null` while the page waits for it. */
  readonly rule: AccountRule | null;
}) {
  return (
    <Section id="counting" title={t('options.counting.title')} lead={t('options.counting.lead')}>
      <Card>
        {rule === null ? (
          <Row title={t('options.loading')} />
        ) : (
          <>
            <Row
              title={t('options.counting.finish', { percent: rule.finishThresholdPercent })}
              detail={t('options.counting.finish_detail')}
            />
            {rule.startThresholdPercent === null ? (
              <Row
                title={t('options.counting.start_title')}
                detail={t('options.counting.start_detail')}
                control={<span class="text-body-s text-muted-foreground">{startWords(rule)}</span>}
              />
            ) : (
              <Row title={startWords(rule)} detail={t('options.counting.start_detail')} />
            )}
          </>
        )}
        <div class="border-t border-border px-5 py-4">
          <p class="text-caption text-muted-foreground">{t('options.counting.where')}</p>
          <p class="mt-2 text-body-s">
            <Link href={`${WEB_APP_BASE_URL}${WEB_ROUTES.connections}`}>
              {t('options.counting.start_change')}
            </Link>
          </p>
        </div>
      </Card>
    </Section>
  );
}
