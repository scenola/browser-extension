/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *Sites*: each built-in service on or off, the all-sites switch, the single sites the person
// allowed (each a permission Chrome granted from a click — removing one gives the access back),
// and the excluded sites, never tracked even with all sites on.

import type { SettingsValue } from '@mt/core';
import { useState } from 'preact/hooks';

import { t } from '../../i18n/t';
import type { SettingsPatch, UiResponse } from '../../messaging/protocol';
import { canonicalHost } from '../../platform/settings';
import { SITES } from '../../sites';
import { Button } from '../components/Button';
import { Card, Row } from '../components/Card';
import { Switch } from '../components/Switch';
import { SETTINGS_ANCHORS } from '../settings-anchors';
import { AllSitesError, useAllSites } from '../sites-switch';
import { GroupTitle, Section } from './Section';

/** The most of a typed site that is read, and that the field takes. */
const MAX_SITE_INPUT = 2048;

/** What the person typed as a site — a host or a whole URL — as a host, or `null`. */
function hostOf(input: string): string | null {
  const text = input.trim().slice(0, MAX_SITE_INPUT);
  if (text === '') return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) {
    try {
      return canonicalHost(new URL(text).hostname);
    } catch {
      return null;
    }
  }
  return canonicalHost(text.split('/')[0] ?? '');
}

export function SitesSection({
  settings,
  patch,
}: {
  readonly settings: SettingsValue | null;
  readonly patch: (p: SettingsPatch) => Promise<UiResponse>;
}) {
  const allSites = useAllSites(settings?.allSites ?? false, patch);
  const [failed, setFailed] = useState(false);
  const change = (p: SettingsPatch): void => {
    setFailed(false);
    void patch(p).then((response) => {
      if (!response.ok) setFailed(true);
    });
  };

  return (
    <Section id="sites" title={t('options.sites.title')} lead={t('options.sites.lead')}>
      <GroupTitle id={SETTINGS_ANCHORS.services}>{t('options.sites.built_in')}</GroupTitle>
      <Card>
        {SITES.sites.map((site) => {
          const on = !(settings?.disabledServices ?? []).includes(site.id);
          const labelId = `service-${site.id}`;
          return (
            <Row
              key={site.id}
              id={labelId}
              title={site.name}
              control={
                <Switch
                  checked={on}
                  disabled={settings === null}
                  labelledBy={labelId}
                  onToggle={() => {
                    const disabled = settings?.disabledServices ?? [];
                    change({
                      disabledServices: on
                        ? [...disabled, site.id]
                        : disabled.filter((id) => id !== site.id),
                    });
                  }}
                />
              }
            />
          );
        })}
      </Card>

      <GroupTitle>{t('options.sites.advanced')}</GroupTitle>
      <Card>
        <Row
          id="options-all-sites"
          title={t('sites.all.title')}
          detail={
            <span id="options-all-sites-detail">
              {t('sites.all.detail')} {t('sites.all.chrome_wording')}
            </span>
          }
          control={
            <Switch
              checked={settings?.allSites ?? false}
              busy={allSites.busy}
              disabled={settings === null}
              labelledBy="options-all-sites"
              describedBy="options-all-sites-detail"
              onToggle={allSites.toggle}
            />
          }
        >
          <AllSitesError note={allSites.note} />
        </Row>
      </Card>

      <GroupTitle>{t('options.sites.allowed')}</GroupTitle>
      <Card>
        <HostList
          hosts={settings?.allowedHosts ?? []}
          empty={t('options.sites.allowed_empty')}
          removeLabel={(host) => t('options.sites.remove_allowed', { host })}
          onRemove={(host) => {
            change({
              allowedHosts: (settings?.allowedHosts ?? []).filter((h) => h !== host),
            });
          }}
        />
      </Card>

      <GroupTitle>{t('options.sites.excluded')}</GroupTitle>
      <Card>
        <HostList
          hosts={settings?.excludedHosts ?? []}
          empty={t('options.sites.excluded_empty')}
          removeLabel={(host) => t('options.sites.remove_excluded', { host })}
          onRemove={(host) => {
            change({
              excludedHosts: (settings?.excludedHosts ?? []).filter((h) => h !== host),
            });
          }}
        />
        <AddExcluded
          disabled={settings === null}
          onAdd={(host) => {
            const current = settings?.excludedHosts ?? [];
            if (!current.includes(host)) change({ excludedHosts: [...current, host] });
          }}
        />
      </Card>
      {failed ? (
        <p role="alert" class="text-body-s">
          {t('options.sites.failed')}
        </p>
      ) : null}
    </Section>
  );
}

function HostList({
  hosts,
  empty,
  removeLabel,
  onRemove,
}: {
  readonly hosts: readonly string[];
  readonly empty: string;
  readonly removeLabel: (host: string) => string;
  readonly onRemove: (host: string) => void;
}) {
  if (hosts.length === 0) {
    return <Row title={<span class="font-normal text-muted-foreground">{empty}</span>} />;
  }
  return (
    <ul>
      {hosts.map((host) => (
        <li
          key={host}
          class="flex items-center gap-3 border-t border-border px-5 py-3 first:border-t-0"
        >
          <span class="min-w-0 flex-1 truncate text-body-s">{host}</span>
          <Button
            size="sm"
            variant="ghost"
            aria-label={removeLabel(host)}
            onClick={() => {
              onRemove(host);
            }}
          >
            {t('options.sites.remove')}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function AddExcluded({
  disabled,
  onAdd,
}: {
  readonly disabled: boolean;
  readonly onAdd: (host: string) => void;
}) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      class="border-t border-border px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        const host = hostOf(text);
        if (host === null) {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        setText('');
        onAdd(host);
      }}
    >
      <label for="exclude-host" class="text-body-s font-medium">
        {t('options.sites.exclude_label')}
      </label>
      <div class="mt-2 flex gap-2">
        <input
          id="exclude-host"
          type="text"
          inputMode="url"
          autocomplete="off"
          spellcheck={false}
          maxLength={MAX_SITE_INPUT}
          placeholder={t('options.sites.exclude_placeholder')}
          aria-invalid={invalid}
          aria-describedby={invalid ? 'exclude-host-error' : undefined}
          value={text}
          onInput={(event) => {
            setText(event.currentTarget.value);
            setInvalid(false);
          }}
          class="min-h-10 min-w-0 flex-1 rounded-full border border-muted-foreground bg-background px-4 text-body-s placeholder:text-muted-foreground aria-invalid:border-destructive"
        />
        <Button type="submit" variant="secondary" disabled={disabled || text.trim() === ''}>
          {t('options.sites.exclude_add')}
        </Button>
      </div>
      {invalid ? (
        <p id="exclude-host-error" role="alert" class="mt-2 text-caption">
          {t('options.sites.exclude_invalid')}
        </p>
      ) : null}
    </form>
  );
}
