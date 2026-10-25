/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *Diagnostics*, off by default: a local log — event names and ids, every value scrubbed of
// sign-in material on the way in — the person can save and attach to a report, and *Capture page
// sample*: the snapshot a service's module would receive from the tab that played last,
// sanitised (no account, profile, e-mail, token or URL query), shown here to be read before it is
// saved as `<service>-<date>.snapshot.json`. Above it, what it holds: one line per part, marked
// *used* where a reader took something from it; what the sanitiser removed, by kind; and where it
// goes — nowhere, until the person saves it.

import { REMOVED_KINDS, SNAPSHOT_PARTS } from '@mt/core';
import type { RemovedKind, SettingsValue, SnapshotPart } from '@mt/core';
import { useEffect, useState } from 'preact/hooks';

import { PRODUCT_NAME } from '../../brand';
import { t, uiLocale } from '../../i18n/t';
import type { AppMessageKey } from '../../i18n/t';
import type { SettingsPatch, UiResponse } from '../../messaging/protocol';
import type { DiagnosticsEntry } from '../../platform/idb';
import { openDatabase } from '../../platform/idb';
import { isRecord } from '../../values';
import { Button } from '../components/Button';
import { Card, Row } from '../components/Card';
import { Switch } from '../components/Switch';
import { downloadJson, fileDate, holdsSecret } from '../data';
import { SETTINGS_ANCHORS } from '../settings-anchors';
import type { UiAsk } from '../store';
import { Section } from './Section';

/**
 * The log as the worker wrote it: read here, in the extension's own page, from its
 * own database, and closed again at once so it never holds up the worker.
 */
async function readLog(): Promise<readonly DiagnosticsEntry[]> {
  const db = await openDatabase();
  try {
    return await db.getAll('diagnostics');
  } finally {
    db.close();
  }
}

interface Capture {
  readonly filename: string;
  readonly fixture: unknown;
  /** The parts a reader took something from this time. */
  readonly used: readonly SnapshotPart[];
  /** What the sanitiser removed, by kind, each at least one. */
  readonly removed: readonly (readonly [RemovedKind, number])[];
}

/** Each part of a sample in words, and the line that says what it holds. */
const PARTS: Readonly<
  Record<SnapshotPart, { readonly name: AppMessageKey; readonly detail?: AppMessageKey }>
> = {
  address: {
    name: 'options.diagnostics.part.address',
    detail: 'options.diagnostics.part.address_detail',
  },
  page_title: { name: 'options.diagnostics.part.page_title' },
  open_graph: {
    name: 'options.diagnostics.part.open_graph',
    detail: 'options.diagnostics.part.open_graph_detail',
  },
  structured_data: { name: 'options.diagnostics.part.structured_data' },
  media_session: { name: 'options.diagnostics.part.media_session' },
  page_data: {
    name: 'options.diagnostics.part.page_data',
    detail: 'options.diagnostics.part.page_data_detail',
  },
  signals: {
    name: 'options.diagnostics.part.signals',
    detail: 'options.diagnostics.part.signals_detail',
  },
};

/** Each kind of removal, counted. */
const REMOVED: Readonly<Record<RemovedKind, AppMessageKey>> = {
  query_values: 'options.diagnostics.removed.query_values',
  named_entries: 'options.diagnostics.removed.named_entries',
  emails: 'options.diagnostics.removed.emails',
  tokens: 'options.diagnostics.removed.tokens',
  links_with_query: 'options.diagnostics.removed.links_with_query',
  overlong: 'options.diagnostics.removed.overlong',
};

/** The worker's `ui/capture` answer, read totally; the file name is kept to a plain one. */
function readCapture(response: UiResponse): Capture | null {
  if (!response.ok || !isRecord(response.data)) return null;
  const { filename, fixture, used } = response.data;
  if (
    typeof filename !== 'string' ||
    !/^[a-z0-9_-]{1,40}-\d{4}-\d{2}-\d{2}\.snapshot\.json$/u.test(filename)
  ) {
    return null;
  }
  const counts = isRecord(fixture) && isRecord(fixture.removed) ? fixture.removed : {};
  return {
    filename,
    fixture,
    used: Array.isArray(used) ? SNAPSHOT_PARTS.filter((part) => used.includes(part)) : [],
    removed: REMOVED_KINDS.flatMap((kind) => {
      const count = counts[kind];
      return typeof count === 'number' && Number.isInteger(count) && count > 0
        ? [[kind, count] as const]
        : [];
    }),
  };
}

/** What a sample holds and what was taken out of it, above the sample itself. */
function CaptureSummary({ capture }: { readonly capture: Capture }) {
  const removed = new Intl.ListFormat(uiLocale(), { type: 'conjunction' }).format(
    capture.removed.map(([kind, count]) => t(REMOVED[kind], { count })),
  );
  return (
    <div class="mt-3 flex flex-col gap-2 text-caption">
      <p class="font-medium">{t('options.diagnostics.capture_parts')}</p>
      <ul class="flex flex-col gap-1">
        {SNAPSHOT_PARTS.map((part) => {
          const words = PARTS[part];
          return (
            <li key={part} class="flex flex-wrap items-baseline gap-x-2">
              <span>{t(words.name)}</span>
              {words.detail === undefined ? null : (
                <span class="text-muted-foreground">{t(words.detail)}</span>
              )}
              {capture.used.includes(part) ? (
                <span class="font-semibold">{t('options.diagnostics.part_used')}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p>
        {capture.removed.length === 0
          ? t('options.diagnostics.removed_none')
          : t('options.diagnostics.removed', { list: removed })}
      </p>
      <p class="text-muted-foreground">{t('options.diagnostics.capture_where')}</p>
    </div>
  );
}

/** What went wrong, in words. */
const NOTES = {
  log_failed: 'options.diagnostics.log_failed',
  capture_empty: 'options.diagnostics.capture_empty',
  capture_failed: 'options.diagnostics.capture_failed',
  change_failed: 'options.diagnostics.change_failed',
} as const satisfies Readonly<Record<string, AppMessageKey>>;

type Note = keyof typeof NOTES | null;

export function DiagnosticsSection({
  settings,
  patch,
  send,
}: {
  readonly settings: SettingsValue | null;
  readonly patch: (p: SettingsPatch) => Promise<UiResponse>;
  readonly send: (ask: UiAsk) => Promise<UiResponse>;
}) {
  const on = settings?.diagnostics ?? false;
  const [count, setCount] = useLogCount(on, settings);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  const saveLog = (): void => {
    setNote(null);
    readLog()
      .then((entries) => {
        setCount(entries.length);
        const now = Date.now();
        const file = { format: 'scenola-extension-diagnostics', version: 1, entries };
        // Scrubbed on the way in; a file that still holds sign-in material is not saved.
        if (holdsSecret(file)) {
          setNote('log_failed');
          return;
        }
        downloadJson(`${PRODUCT_NAME.toLowerCase()}-diagnostics-${fileDate(now)}.json`, file);
      })
      .catch(() => {
        setNote('log_failed');
      });
  };

  const captureSample = (): void => {
    setBusy(true);
    setNote(null);
    void send({ type: 'ui/capture' }).then((response) => {
      setBusy(false);
      if (!response.ok && response.error === 'no_snapshot') {
        setCapture(null);
        setNote('capture_empty');
        return;
      }
      const read = readCapture(response);
      if (read === null) {
        setCapture(null);
        setNote('capture_failed');
        return;
      }
      setCapture(read);
    });
  };

  return (
    <Section
      id="diagnostics"
      title={t('options.diagnostics.title')}
      lead={t('options.diagnostics.lead')}
    >
      <Card>
        <Row
          id="diagnostics-label"
          title={t('options.diagnostics.log')}
          detail={<span id="diagnostics-detail">{t('options.diagnostics.log_detail')}</span>}
          control={
            <Switch
              checked={on}
              disabled={settings === null}
              labelledBy="diagnostics-label"
              describedBy="diagnostics-detail"
              onToggle={() => {
                setNote(null);
                void patch({ diagnostics: !on }).then((response) => {
                  if (!response.ok) setNote('change_failed');
                });
              }}
            />
          }
        />
        {on ? (
          <Row
            title={t('options.diagnostics.entries', { count: count ?? 0 })}
            detail={t('options.diagnostics.entries_detail')}
            control={
              <Button variant="secondary" size="sm" onClick={saveLog}>
                {t('options.diagnostics.save_log')}
              </Button>
            }
          />
        ) : null}
      </Card>

      <Card>
        <Row
          id={SETTINGS_ANCHORS.capture}
          title={t('options.diagnostics.capture')}
          detail={t('options.diagnostics.capture_detail')}
          control={
            <Button variant="secondary" size="sm" disabled={busy} onClick={captureSample}>
              {t('options.diagnostics.capture_action')}
            </Button>
          }
        >
          {capture === null ? null : <CapturePreview capture={capture} />}
        </Row>
      </Card>
      {note === null ? null : (
        <p role="alert" class="text-body-s">
          {t(NOTES[note])}
        </p>
      )}
    </Section>
  );
}

/**
 * How many entries the log holds, read again whenever the settings change; `null` while
 * diagnostics are off or the log cannot be read.
 */
function useLogCount(
  on: boolean,
  settings: SettingsValue | null,
): [number | null, (count: number | null) => void] {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    if (!on) {
      setCount(null);
      return;
    }
    readLog()
      .then((entries) => {
        if (current) setCount(entries.length);
      })
      .catch(() => {
        if (current) setCount(null);
      });
    return () => {
      current = false;
    };
  }, [on, settings]);
  return [count, setCount];
}

/** A captured sample, to be read before it is saved: its file, what it holds, and itself. */
function CapturePreview({ capture }: { readonly capture: Capture }) {
  return (
    <div class="mt-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="min-w-0 text-caption text-muted-foreground [overflow-wrap:anywhere]">
          {t('options.diagnostics.capture_ready', { file: capture.filename })}
        </p>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            downloadJson(capture.filename, capture.fixture);
          }}
        >
          {t('options.diagnostics.capture_save')}
        </Button>
      </div>
      <CaptureSummary capture={capture} />
      <pre
        tabIndex={0}
        aria-label={t('options.diagnostics.capture_preview')}
        class="mt-2 max-h-80 overflow-auto rounded-xl border border-border bg-background p-3 font-mono text-micro leading-relaxed whitespace-pre"
      >
        {JSON.stringify(capture.fixture, null, 2)}
      </pre>
    </div>
  );
}
