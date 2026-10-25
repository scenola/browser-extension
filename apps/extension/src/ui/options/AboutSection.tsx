/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *About*: the version, the build fingerprint — read from the build's own `fingerprint.json`,
// which cannot be bundled because the fingerprint hashes the bundles — the source, the licence
// and the third-party notices, and the data inventory in plain words: what is kept, where, whether it leaves the
// browser, and for how long.

import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';

import { WEB_APP_BASE_URL } from '../../config';
import { t } from '../../i18n/t';
import type { AppMessageKey } from '../../i18n/t';
import { WEB_ROUTES } from '../../web-routes';
import { Card, Row } from '../components/Card';
import { Link } from '../components/Link';
import { SETTINGS_ANCHORS } from '../settings-anchors';
import { LICENCE_URL, NOTICES_FILE, SOURCE_REPOSITORY_URL } from '../source';
import { Section } from './Section';

const FINGERPRINT = /^[0-9a-f]{64}$/u;

type Fingerprint =
  | { readonly kind: 'loading' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'read'; readonly sha256: string };

/** The build's fingerprint: a SHA-256 in hex, or `missing` when the file cannot be read. */
function useFingerprint(): Fingerprint {
  const [value, setValue] = useState<Fingerprint>({ kind: 'loading' });
  useEffect(() => {
    let current = true;
    // The page's own origin: `connect-src 'self'` is what allows it.
    fetch('/fingerprint.json', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((json: unknown) => {
        const found =
          typeof json === 'object' && json !== null
            ? (json as { readonly fingerprint?: unknown }).fingerprint
            : undefined;
        if (!current) return;
        setValue(
          typeof found === 'string' && FINGERPRINT.test(found)
            ? { kind: 'read', sha256: found }
            : { kind: 'missing' },
        );
      })
      .catch(() => {
        if (current) setValue({ kind: 'missing' });
      });
    return () => {
      current = false;
    };
  }, []);
  return value;
}

/** The data inventory, one row per kind of data: what, where, does it leave, how long. */
const INVENTORY: readonly (readonly [
  AppMessageKey,
  AppMessageKey,
  AppMessageKey,
  AppMessageKey,
])[] = [
  [
    'privacy.inventory.reading.what',
    'privacy.inventory.reading.where',
    'privacy.inventory.reading.leaves',
    'privacy.inventory.reading.kept',
  ],
  [
    'privacy.inventory.play.what',
    'privacy.inventory.play.where',
    'privacy.inventory.play.leaves',
    'privacy.inventory.play.kept',
  ],
  [
    'privacy.inventory.start.what',
    'privacy.inventory.start.where',
    'privacy.inventory.start.leaves',
    'privacy.inventory.start.kept',
  ],
  [
    'privacy.inventory.answer.what',
    'privacy.inventory.answer.where',
    'privacy.inventory.answer.leaves',
    'privacy.inventory.answer.kept',
  ],
  [
    'privacy.inventory.rule.what',
    'privacy.inventory.rule.where',
    'privacy.inventory.rule.leaves',
    'privacy.inventory.rule.kept',
  ],
  [
    'privacy.inventory.connection.what',
    'privacy.inventory.connection.where',
    'privacy.inventory.connection.leaves',
    'privacy.inventory.connection.kept',
  ],
  [
    'privacy.inventory.account.what',
    'privacy.inventory.account.where',
    'privacy.inventory.account.leaves',
    'privacy.inventory.account.kept',
  ],
  [
    'privacy.inventory.settings.what',
    'privacy.inventory.settings.where',
    'privacy.inventory.settings.leaves',
    'privacy.inventory.settings.kept',
  ],
  [
    'privacy.inventory.diagnostics.what',
    'privacy.inventory.diagnostics.where',
    'privacy.inventory.diagnostics.leaves',
    'privacy.inventory.diagnostics.kept',
  ],
];

export function AboutSection() {
  const fingerprint = useFingerprint();
  const version = browser.runtime.getManifest().version;

  return (
    <Section id="about" title={t('options.about.title')}>
      <Card>
        <Row
          title={t('options.about.version')}
          control={<span class="text-body-s text-muted-foreground">{version}</span>}
        />
        <Row title={t('options.about.fingerprint')} detail={t('options.about.fingerprint_detail')}>
          <p class="mt-2 font-mono text-micro break-all text-muted-foreground">
            {fingerprint.kind === 'loading'
              ? t('options.loading')
              : fingerprint.kind === 'read'
                ? fingerprint.sha256
                : t('options.about.fingerprint_missing')}
          </p>
        </Row>
        <Row
          title={t('options.about.source')}
          detail={SOURCE_REPOSITORY_URL === null ? t('options.about.source_soon') : undefined}
          control={
            SOURCE_REPOSITORY_URL === null ? undefined : (
              <Link href={SOURCE_REPOSITORY_URL}>{t('options.about.source_link')}</Link>
            )
          }
        />
        <Row
          title={t('options.about.licence')}
          control={<Link href={LICENCE_URL}>{t('options.about.licence_name')}</Link>}
        />
        <Row
          title={t('options.about.notices')}
          detail={t('options.about.notices_detail')}
          control={<Link href={`/${NOTICES_FILE}`}>{t('options.about.notices_link')}</Link>}
        />
      </Card>

      <div>
        <h3 id={SETTINGS_ANCHORS.data} class="px-1 font-display text-display-s font-semibold">
          {t('privacy.inventory.title')}
        </h3>
        <p class="mt-1 max-w-[40rem] px-1 text-body-s text-muted-foreground">
          {t('privacy.inventory.lead')}
        </p>
        <Card class="mt-3 overflow-x-auto">
          <table class="w-full min-w-[36rem] border-collapse text-start text-body-s">
            <thead>
              <tr class="text-caption text-muted-foreground">
                <th scope="col" class="px-5 pt-4 pb-2 text-start font-medium">
                  {t('privacy.inventory.col.what')}
                </th>
                <th scope="col" class="px-3 pt-4 pb-2 text-start font-medium">
                  {t('privacy.inventory.col.where')}
                </th>
                <th scope="col" class="px-3 pt-4 pb-2 text-start font-medium">
                  {t('privacy.inventory.col.leaves')}
                </th>
                <th scope="col" class="px-5 pt-4 pb-2 text-start font-medium">
                  {t('privacy.inventory.col.kept')}
                </th>
              </tr>
            </thead>
            <tbody>
              {INVENTORY.map(([what, where, leaves, kept]) => (
                <tr key={what} class="border-t border-border align-top">
                  <th scope="row" class="px-5 py-3 text-start font-medium">
                    {t(what)}
                  </th>
                  <td class="px-3 py-3 text-muted-foreground">{t(where)}</td>
                  <td class="px-3 py-3">{t(leaves)}</td>
                  <td class="px-5 py-3 text-muted-foreground">{t(kept)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p class="mt-3 max-w-[40rem] px-1 text-body-s">{t('privacy.inventory.nothing_else')}</p>
        <p class="mt-2 flex flex-wrap gap-x-5 gap-y-1 px-1 text-body-s">
          <Link href={`${WEB_APP_BASE_URL}${WEB_ROUTES.privacy}`}>
            {t('options.about.privacy_policy')}
          </Link>
          {SOURCE_REPOSITORY_URL === null ? null : (
            <Link href={`${SOURCE_REPOSITORY_URL}/blob/main/docs/privacy.md`}>
              {t('options.about.privacy_notes')}
            </Link>
          )}
        </p>
      </div>
    </Section>
  );
}
