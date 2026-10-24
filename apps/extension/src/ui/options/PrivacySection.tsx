/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *Privacy*: tracking in incognito windows (off by default), how long the local history is kept
// (1, 7 or 30 days; 7 to begin with) and *Clear history*, *Export my extension data* — a JSON
// file the worker builds from what is stored, never the sign-in or the key — and *Clear all
// local data*, which forgets the connection too. Each clear asks first.

import { DEFAULT_SETTINGS, HISTORY_DAYS } from '@mt/core';
import type { SettingsValue } from '@mt/core';
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';

import { PRODUCT_NAME } from '../../brand';
import { t } from '../../i18n/t';
import type { AppMessageKey } from '../../i18n/t';
import type { SettingsPatch, UiResponse } from '../../messaging/protocol';
import { Button } from '../components/Button';
import { Card, Row } from '../components/Card';
import { Confirm } from '../components/Confirm';
import { Segmented } from '../components/Segmented';
import { Switch } from '../components/Switch';
import { downloadJson, fileDate, holdsSecret } from '../data';
import type { UiAsk } from '../store';
import { Section } from './Section';

/** Whether Chrome lets the extension run in incognito windows at all; `null` until it says. */
function useIncognitoAllowed(): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    browser.extension
      .isAllowedIncognitoAccess()
      .then((value) => {
        if (current) setAllowed(value);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  return allowed;
}

type Note =
  | 'exported'
  | 'export_failed'
  | 'export_refused'
  | 'history_cleared'
  | 'history_clear_failed'
  | 'cleared'
  | 'clear_failed'
  | 'change_failed'
  | null;

const NOTES: Readonly<Record<Exclude<Note, null>, AppMessageKey>> = {
  exported: 'options.privacy.exported',
  export_failed: 'options.privacy.export_failed',
  export_refused: 'options.privacy.export_refused',
  history_cleared: 'options.privacy.history_cleared',
  history_clear_failed: 'options.privacy.history_clear_failed',
  cleared: 'options.privacy.cleared',
  clear_failed: 'options.privacy.clear_failed',
  change_failed: 'options.privacy.change_failed',
};

/** What each clear asks the worker, and what the page says after. */
const CLEARS = {
  history: { type: 'ui/clear-history', done: 'history_cleared', failed: 'history_clear_failed' },
  all: { type: 'ui/clear', done: 'cleared', failed: 'clear_failed' },
} as const;

type Clear = keyof typeof CLEARS;

export function PrivacySection({
  settings,
  patch,
  send,
}: {
  readonly settings: SettingsValue | null;
  readonly patch: (p: SettingsPatch) => Promise<UiResponse>;
  readonly send: (ask: UiAsk) => Promise<UiResponse>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Clear | null>(null);
  const [note, setNote] = useState<Note>(null);

  const exportData = (): void => {
    setBusy(true);
    setNote(null);
    void send({ type: 'ui/export' }).then((response) => {
      setBusy(false);
      if (!response.ok) {
        setNote('export_failed');
        return;
      }
      // The worker never puts the sign-in or the key in an export; a file that holds either
      // anyway is refused here rather than saved.
      if (holdsSecret(response.data)) {
        setNote('export_refused');
        return;
      }
      const now = Date.now();
      downloadJson(`${PRODUCT_NAME.toLowerCase()}-extension-${fileDate(now)}.json`, response.data);
      setNote('exported');
    });
  };

  const ask = (what: Clear): void => {
    setNote(null);
    setConfirming(what);
  };

  const clear = (what: Clear): void => {
    const { type, done, failed } = CLEARS[what];
    setBusy(true);
    void send({ type }).then((response) => {
      setBusy(false);
      setConfirming(null);
      setNote(response.ok ? done : failed);
    });
  };

  const cancel = (): void => {
    setConfirming(null);
  };

  return (
    <Section id="privacy" title={t('options.privacy.title')}>
      <Card>
        <IncognitoRow settings={settings} patch={patch} onNote={setNote} />
        <HistoryDaysRow settings={settings} patch={patch} onNote={setNote} />
        <ClearRow
          title={t('options.privacy.history')}
          detail={t('options.privacy.history_detail', {
            days: settings?.historyDays ?? DEFAULT_SETTINGS.historyDays,
          })}
          ask={t('options.privacy.history_clear_action')}
          question={t('options.privacy.history_clear_confirm')}
          action={t('options.privacy.history_clear_confirm_action')}
          busy={busy}
          confirming={confirming === 'history'}
          onAsk={() => {
            ask('history');
          }}
          onConfirm={() => {
            clear('history');
          }}
          onCancel={cancel}
        />
      </Card>

      <Card>
        <Row
          title={t('options.privacy.export')}
          detail={t('options.privacy.export_detail')}
          control={
            <Button variant="secondary" size="sm" disabled={busy} onClick={exportData}>
              {t('options.privacy.export_action')}
            </Button>
          }
        />
        <ClearRow
          title={t('options.privacy.clear')}
          detail={t('options.privacy.clear_detail')}
          ask={t('options.privacy.clear_action')}
          question={t('options.privacy.clear_confirm')}
          action={t('options.privacy.clear_confirm_action')}
          busy={busy}
          confirming={confirming === 'all'}
          onAsk={() => {
            ask('all');
          }}
          onConfirm={() => {
            clear('all');
          }}
          onCancel={cancel}
        />
      </Card>
      {note === null ? null : (
        <p
          role={note.endsWith('failed') || note === 'export_refused' ? 'alert' : 'status'}
          class="text-body-s"
        >
          {t(NOTES[note])}
        </p>
      )}
    </Section>
  );
}

/** *Track in incognito windows*, and Chrome's own switch when that half is still off. */
function IncognitoRow({
  settings,
  patch,
  onNote,
}: {
  readonly settings: SettingsValue | null;
  readonly patch: (p: SettingsPatch) => Promise<UiResponse>;
  readonly onNote: (note: Note) => void;
}) {
  const allowed = useIncognitoAllowed();
  const incognito = settings?.trackIncognito ?? false;
  return (
    <Row
      id="incognito-label"
      title={t('options.privacy.incognito')}
      detail={<span id="incognito-detail">{t('options.privacy.incognito_detail')}</span>}
      control={
        <Switch
          checked={incognito}
          disabled={settings === null}
          labelledBy="incognito-label"
          describedBy="incognito-detail"
          onToggle={() => {
            onNote(null);
            void patch({ trackIncognito: !incognito }).then((response) => {
              if (!response.ok) onNote('change_failed');
            });
          }}
        />
      }
    >
      {incognito && allowed === false ? <IncognitoNotAllowed /> : null}
    </Row>
  );
}

/** *Keep history for*: 1, 7 or 30 days, the plays older than that leaving the browser. */
function HistoryDaysRow({
  settings,
  patch,
  onNote,
}: {
  readonly settings: SettingsValue | null;
  readonly patch: (p: SettingsPatch) => Promise<UiResponse>;
  readonly onNote: (note: Note) => void;
}) {
  const choices = HISTORY_DAYS.map((days) => ({
    value: days,
    label: t('options.privacy.history_days_choice', { days }),
  }));
  return (
    <Row
      id="history-days-label"
      title={t('options.privacy.history_days')}
      detail={<span id="history-days-detail">{t('options.privacy.history_days_detail')}</span>}
      control={
        <Segmented
          choices={choices}
          value={settings?.historyDays ?? null}
          disabled={settings === null}
          labelledBy="history-days-label"
          describedBy="history-days-detail"
          onChoose={(historyDays) => {
            onNote(null);
            void patch({ historyDays }).then((response) => {
              if (!response.ok) onNote('change_failed');
            });
          }}
        />
      }
    />
  );
}

/**
 * A row that deletes something, asked first: *Clear history* and *Clear all local data*. `ask`
 * is the row's own button, a name no other button of the page has; `question` says what goes and
 * what stays; `action` names the deletion on the button that does it.
 */
function ClearRow({
  title,
  detail,
  ask,
  question,
  action,
  busy,
  confirming,
  onAsk,
  onConfirm,
  onCancel,
}: {
  readonly title: string;
  readonly detail: string;
  readonly ask: string;
  readonly question: string;
  readonly action: string;
  readonly busy: boolean;
  readonly confirming: boolean;
  readonly onAsk: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <Row
      title={title}
      detail={detail}
      control={
        confirming ? undefined : (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onAsk}>
            {ask}
          </Button>
        )
      }
    >
      {confirming ? (
        <Confirm action={action} busy={busy} onConfirm={onConfirm} onCancel={onCancel}>
          {question}
        </Confirm>
      ) : null}
    </Row>
  );
}

/**
 * Incognito tracking is on, and Chrome does not run the extension there: Chrome's own switch,
 * on the extension's page in its settings, is the other half.
 */
function IncognitoNotAllowed() {
  return (
    <div class="mt-3 flex flex-wrap items-center gap-3 rounded-2xl bg-secondary p-3">
      <p class="min-w-0 flex-1 text-caption">{t('options.privacy.incognito_chrome')}</p>
      <Button
        size="sm"
        variant="secondary"
        class="bg-background"
        onClick={() => {
          void browser.tabs.create({
            url: `chrome://extensions/?id=${encodeURIComponent(browser.runtime.id)}`,
          });
        }}
      >
        {t('options.privacy.incognito_open')}
      </Button>
    </div>
  );
}
