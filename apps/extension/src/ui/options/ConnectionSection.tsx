/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *Connection*: its state, connected since, "reconnect needed by" — the sliding estimate,
// `min(now + 90 d, connected + 365 d)` — *Reconnect*, and *Disconnect from this browser*, which
// deletes the sign-in **and** the key so it can never be used again, with everything kept here
// for the account, and points to the web app's *Connected services* for what stays there (the
// extension has no route to remove it). It asks first, saying what goes; while plays wait and the
// connection works, the preferred answer sends them first.

import type { ConnectionState } from '@mt/core';
import { useState } from 'preact/hooks';

import { WEB_APP_BASE_URL } from '../../config';
import { t } from '../../i18n/t';
import type { ConnectionCheckView, UiResponse } from '../../messaging/protocol';
import { WEB_ROUTES } from '../../web-routes';
import { Button } from '../components/Button';
import { Card, Row } from '../components/Card';
import { CheckNotice } from '../components/CheckNotice';
import { Confirm } from '../components/Confirm';
import { Link } from '../components/Link';
import {
  ConnectMessage,
  OFFERS_PERSONAL_TOKEN,
  PersonalTokenForm,
  WINDOW_STRATEGY,
  useConnect,
} from '../connect';
import { day } from '../format';
import { isPersonalToken } from '../personal-token';
import type { UiAsk } from '../store';
import { Section } from './Section';

const CONNECTIONS_URL = `${WEB_APP_BASE_URL}${WEB_ROUTES.connections}`;

function stateWords(connection: ConnectionState): {
  readonly title: string;
  readonly detail: string;
} {
  switch (connection.kind) {
    case 'none':
      return { title: t('options.connection.none'), detail: t('options.connection.none_detail') };
    case 'broken':
      return {
        title: t('options.connection.broken'),
        detail:
          connection.reason === 'key_missing'
            ? t('options.connection.broken_key')
            : t('options.connection.broken_refused'),
      };
    case 'connected':
      return {
        title: t('options.connection.connected'),
        detail: isPersonalToken(connection.strategy)
          ? t('options.connection.with_token')
          : t('options.connection.with_window'),
      };
  }
}

/** What a disconnect answered: how many plays went first, how many were deleted unsent. */
interface Disconnected {
  readonly sent: number;
  readonly deleted: number;
}

function disconnectedOf(data: unknown): Disconnected {
  const counts = (data ?? {}) as Partial<Record<keyof Disconnected, unknown>>;
  const count = (x: unknown): number => (typeof x === 'number' && x >= 0 ? x : 0);
  return { sent: count(counts.sent), deleted: count(counts.deleted) };
}

export function ConnectionSection({
  connection,
  check,
  unsent,
  send,
}: {
  readonly connection: ConnectionState | null;
  /** What the server last said of the connection; `null` until it has answered. */
  readonly check: ConnectionCheckView | null;
  /** Plays not sent yet that can still go: what a disconnect offers to send first. */
  readonly unsent: number;
  readonly send: (ask: UiAsk) => Promise<UiResponse>;
}) {
  const { busy, outcome, connect } = useConnect(send);
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState<'send_first' | 'delete' | null>(null);
  const [disconnected, setDisconnected] = useState<Disconnected | 'failed' | null>(null);

  if (connection === null) {
    return (
      <Section id="connection" title={t('options.connection.title')}>
        <Card>
          <Row title={t('options.loading')} />
        </Card>
      </Section>
    );
  }

  const words = stateWords(connection);
  const linked = connection.kind !== 'none';
  // Only a working connection can send what is left; a broken one deletes it with the rest.
  const canSend = connection.kind === 'connected' && unsent > 0;

  const disconnect = (sendFirst: boolean): void => {
    setDisconnecting(sendFirst ? 'send_first' : 'delete');
    void send({ type: 'ui/disconnect', sendFirst }).then((response) => {
      setDisconnecting(null);
      setConfirming(false);
      setDisconnected(response.ok ? disconnectedOf(response.data) : 'failed');
    });
  };

  return (
    <Section id="connection" title={t('options.connection.title')}>
      <Card>
        <Row title={words.title} detail={words.detail} />
        <CheckNotice check={check} class="mx-5 mb-4" />
        {connection.kind === 'connected' ? (
          <ConnectionDates connection={connection} check={check} />
        ) : null}
        <div class="border-t border-border px-5 py-4">
          <div class="flex flex-wrap items-center gap-3">
            {WINDOW_STRATEGY === null ? null : (
              <Button
                variant="primary"
                disabled={busy || confirming}
                onClick={() => {
                  setDisconnected(null);
                  void connect(WINDOW_STRATEGY ?? 'pkce_dpop');
                }}
              >
                {connectLabel(busy, linked)}
              </Button>
            )}
            {linked && !confirming ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setConfirming(true);
                }}
              >
                {t('options.connection.disconnect')}
              </Button>
            ) : null}
          </div>
          {WINDOW_STRATEGY === null ? null : (
            <p class="mt-2 text-caption text-muted-foreground">{t('welcome.connect.note')}</p>
          )}
          {OFFERS_PERSONAL_TOKEN ? (
            <div class="mt-4">
              <PersonalTokenForm
                busy={busy || confirming}
                onSubmit={(token) => {
                  setDisconnected(null);
                  void connect('personal_token', token);
                }}
              />
            </div>
          ) : null}
          {confirming ? (
            <DisconnectConfirm
              unsent={unsent}
              canSend={canSend}
              disconnecting={disconnecting}
              onDisconnect={disconnect}
              onCancel={() => {
                setConfirming(false);
              }}
            />
          ) : null}
          <div class="mt-3 empty:mt-0">
            <ConnectMessage outcome={outcome} />
            <DisconnectOutcome disconnected={disconnected} />
          </div>
        </div>
      </Card>
    </Section>
  );
}

function connectLabel(busy: boolean, linked: boolean): string {
  if (busy) return t('options.connection.waiting');
  return linked ? t('common.reconnect') : t('common.connect');
}

/** A connection's dates: since when, and until when — the server's date once it answered. */
function ConnectionDates({
  connection,
  check,
}: {
  readonly connection: Extract<ConnectionState, { kind: 'connected' }>;
  readonly check: ConnectionCheckView | null;
}) {
  return (
    <>
      <Row
        title={t('options.connection.since')}
        control={<Value>{day(connection.connectedAt)}</Value>}
      />
      {check !== null ? (
        // The server has answered: its date replaces the estimate — for a personal
        // token too, whose end the person chose.
        <Row
          title={t('options.connection.ends')}
          detail={t('options.connection.ends_detail')}
          control={
            <Value>
              {check.expiresAt === null ? t('options.connection.no_end') : day(check.expiresAt)}
            </Value>
          }
        />
      ) : isPersonalToken(connection.strategy) ? null : (
        <Row
          title={t('options.connection.until')}
          detail={t('options.connection.until_detail')}
          control={<Value>{day(connection.expiresAt)}</Value>}
        />
      )}
    </>
  );
}

/**
 * *Disconnect from this browser*, asked first: what goes, and — while plays wait and the
 * connection works — the preferred answer, sending them first.
 */
function DisconnectConfirm({
  unsent,
  canSend,
  disconnecting,
  onDisconnect,
  onCancel,
}: {
  readonly unsent: number;
  readonly canSend: boolean;
  readonly disconnecting: 'send_first' | 'delete' | null;
  readonly onDisconnect: (sendFirst: boolean) => void;
  readonly onCancel: () => void;
}) {
  return (
    <Confirm
      action={
        unsent > 0
          ? t('options.connection.delete_unsent', { count: unsent })
          : t('options.connection.disconnect')
      }
      first={
        canSend
          ? {
              action: t('options.connection.send_first', { count: unsent }),
              onConfirm: () => {
                onDisconnect(true);
              },
            }
          : undefined
      }
      busy={disconnecting !== null}
      onConfirm={() => {
        onDisconnect(false);
      }}
      onCancel={onCancel}
    >
      <div class="flex flex-col items-start gap-1.5">
        <p>{t('options.connection.disconnect_confirm')}</p>
        {unsent > 0 ? (
          <p>
            {canSend
              ? t('options.connection.disconnect_unsent', { count: unsent })
              : t('options.connection.disconnect_unsent_broken', { count: unsent })}
          </p>
        ) : null}
        <p>{t('options.connection.disconnect_account')}</p>
        <Link href={CONNECTIONS_URL}>{t('connect.link.connections')}</Link>
        {disconnecting === 'send_first' ? (
          <p role="status">{t('options.connection.sending_first')}</p>
        ) : null}
      </div>
    </Confirm>
  );
}

/** What a disconnect did: how many plays went first, how many were deleted, or that it failed. */
function DisconnectOutcome({
  disconnected,
}: {
  readonly disconnected: Disconnected | 'failed' | null;
}) {
  if (disconnected === null) return null;
  if (disconnected === 'failed') {
    return (
      <p role="alert" class="text-body-s">
        {t('options.connection.disconnect_failed')}
      </p>
    );
  }
  return (
    <div role="status" class="flex flex-col items-start gap-1.5 text-body-s">
      <p>{t('options.connection.disconnected')}</p>
      {disconnected.sent > 0 ? (
        <p>{t('options.connection.disconnected_sent', { count: disconnected.sent })}</p>
      ) : null}
      {disconnected.deleted > 0 ? (
        <p>{t('options.connection.disconnected_deleted', { count: disconnected.deleted })}</p>
      ) : null}
      <Link href={CONNECTIONS_URL}>{t('connect.link.connections')}</Link>
    </div>
  );
}

function Value({ children }: { readonly children: string }) {
  return <span class="text-body-s text-muted-foreground">{children}</span>;
}
