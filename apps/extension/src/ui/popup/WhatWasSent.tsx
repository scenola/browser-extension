/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *What was sent*: for one play, the exact JSON body that left the browser, when, and
// MediaTracker's answer — or, for a play not sent yet, why. A recorded play links to its title in
// the web app, where a wrong one is fixed: the connection cannot change the diary.

import { useEffect, useRef, useState } from 'preact/hooks';

import { t } from '../../i18n/t';
import type { EntryView, UiResponse } from '../../messaging/protocol';
import { isRecord } from '../../values';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Link } from '../components/Link';
import { fullMoment } from '../format';
import type { UiAsk } from '../store';

interface Sent {
  readonly body: unknown;
  readonly sentAt: number;
  readonly view: EntryView;
  readonly href: string | null;
  /** What the server answered, as kept: its id for the play and the latest receipt. */
  readonly answer: Readonly<Record<string, unknown>> | null;
  readonly queued: boolean;
}

type Loaded =
  { readonly kind: 'loading' } | { readonly kind: 'missing' } | ({ readonly kind: 'ok' } & Sent);

/** The worker's answer (`ui/what-was-sent`), read totally. */
function readSent(response: UiResponse): Sent | null {
  if (!response.ok || !isRecord(response.data)) return null;
  const d = response.data;
  if (typeof d.sentAt !== 'number' || !isRecord(d.view) || typeof d.view.messageKey !== 'string') {
    return null;
  }
  const queued = typeof d.state === 'string';
  const answer = queued
    ? { state: d.state, last_error: d.lastError ?? null }
    : { scrobble_id: d.scrobbleId ?? null, receipt: d.receipt ?? null };
  return {
    body: d.body,
    sentAt: d.sentAt,
    view: d.view as unknown as EntryView,
    href: typeof d.href === 'string' ? d.href : null,
    answer,
    queued,
  };
}

export function WhatWasSent({
  playId,
  label,
  send,
  onBack,
}: {
  readonly playId: string;
  readonly label: string;
  readonly send: (ask: UiAsk) => Promise<UiResponse>;
  readonly onBack: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [copied, setCopied] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let current = true;
    void send({ type: 'ui/what-was-sent', playId }).then((response) => {
      if (!current) return;
      const sent = readSent(response);
      setLoaded(sent === null ? { kind: 'missing' } : { kind: 'ok', ...sent });
    });
    return () => {
      current = false;
    };
  }, [playId, send]);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const body = loaded.kind === 'ok' ? JSON.stringify(loaded.body, null, 2) : '';

  const copy = (): void => {
    void navigator.clipboard.writeText(body).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  };

  return (
    <section
      aria-labelledby="sent-heading"
      class="px-4 pt-3 pb-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onBack();
        }
      }}
    >
      <Button size="sm" variant="ghost" onClick={onBack} class="-ms-2">
        <Icon name="chevron-start" />
        {t('popup.sent.back')}
      </Button>
      <h2
        id="sent-heading"
        ref={heading}
        tabIndex={-1}
        class="mt-2 font-display text-display-s font-semibold [overflow-wrap:anywhere]"
      >
        {label === '' ? t('popup.entry.untitled') : label}
      </h2>

      {loaded.kind === 'loading' ? (
        <p class="mt-2 text-body-s text-muted-foreground">{t('popup.sent.loading')}</p>
      ) : loaded.kind === 'missing' ? (
        <p role="alert" class="mt-2 text-body-s text-muted-foreground">
          {t('popup.sent.missing')}
        </p>
      ) : (
        <>
          <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-body-s">
            <dt class="text-muted-foreground">
              {loaded.queued ? t('popup.sent.queued_at') : t('popup.sent.sent_at')}
            </dt>
            <dd>{fullMoment(loaded.sentAt)}</dd>
            <dt class="text-muted-foreground">{t('popup.sent.answer')}</dt>
            <dd>{t(loaded.view.messageKey)}</dd>
          </dl>
          {loaded.href === null ? null : (
            <p class="mt-2 text-body-s">
              <Link href={loaded.href}>
                {loaded.view.link === 'title'
                  ? t('popup.sent.open_title')
                  : t('popup.sent.open_app')}
              </Link>
            </p>
          )}

          <div class="mt-4 flex items-center justify-between gap-2">
            <h3 class="text-micro font-semibold text-muted-foreground">{t('popup.sent.body')}</h3>
            <Button size="sm" variant="ghost" onClick={copy}>
              <Icon name={copied ? 'check' : 'copy'} />
              {copied ? t('popup.sent.copied') : t('popup.sent.copy')}
            </Button>
          </div>
          <pre
            tabIndex={0}
            aria-label={t('popup.sent.body')}
            class="mt-1 max-h-56 overflow-auto rounded-xl border border-border bg-card p-3 font-mono text-micro leading-relaxed whitespace-pre"
          >
            {body}
          </pre>

          <h3 class="mt-4 text-micro font-semibold text-muted-foreground">
            {loaded.queued ? t('popup.sent.not_sent') : t('popup.sent.answered')}
          </h3>
          <pre
            tabIndex={0}
            aria-label={loaded.queued ? t('popup.sent.not_sent') : t('popup.sent.answered')}
            class="mt-1 overflow-auto rounded-xl border border-border bg-card p-3 font-mono text-micro leading-relaxed whitespace-pre"
          >
            {JSON.stringify(loaded.answer, null, 2)}
          </pre>
        </>
      )}
    </section>
  );
}
