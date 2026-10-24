/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Step 1, *Connect*: what the extension does and does not do, one button that opens
// the sign-in window, and — if the window closes without connecting — what happened, plainly,
// naming MediaTracker Plus. Already connected, it says so and moves on.

import type { ConnectionState } from '@mt/core';

import { t } from '../../i18n/t';
import type { UiResponse } from '../../messaging/protocol';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import {
  ConnectMessage,
  OFFERS_PERSONAL_TOKEN,
  PersonalTokenForm,
  WINDOW_STRATEGY,
  useConnect,
} from '../connect';
import type { UiAsk } from '../store';

export function StepConnect({
  connection,
  send,
  onDone,
}: {
  readonly connection: ConnectionState | null;
  readonly send: (ask: UiAsk) => Promise<UiResponse>;
  readonly onDone: () => void;
}) {
  const { busy, outcome, connect } = useConnect(send);
  const connected = connection?.kind === 'connected';

  const after = (strategy: 'pkce_dpop' | 'personal_token' | 'test', token?: string): void => {
    void connect(strategy, token).then((read) => {
      if (read.kind === 'result' && read.result.kind === 'connected') onDone();
    });
  };

  return (
    <>
      <h1
        tabIndex={-1}
        class="font-display text-display-l font-semibold tracking-[-0.015em] text-balance"
      >
        {t('welcome.connect.title')}
      </h1>
      <p class="mt-3 max-w-[32rem] text-body text-muted-foreground">{t('welcome.connect.body')}</p>

      {connected ? (
        <div class="mt-8 flex flex-col items-start gap-4">
          <p class="flex items-center gap-2 text-body" aria-live="polite">
            <Icon name="check" />
            {t('welcome.connect.already')}
          </p>
          <Button variant="primary" size="lg" onClick={onDone}>
            {t('welcome.continue')}
          </Button>
        </div>
      ) : (
        <div class="mt-8 flex flex-col items-start gap-4">
          {WINDOW_STRATEGY === null ? null : (
            <>
              <Button
                variant="primary"
                size="lg"
                disabled={busy}
                aria-describedby="connect-note"
                onClick={() => {
                  after(WINDOW_STRATEGY ?? 'pkce_dpop');
                }}
              >
                {busy ? t('welcome.connect.waiting') : t('common.connect')}
              </Button>
              <p id="connect-note" class="text-body-s text-muted-foreground">
                {t('welcome.connect.note')}
              </p>
            </>
          )}
          {OFFERS_PERSONAL_TOKEN ? (
            <div class="mt-2 w-full max-w-[28rem]">
              <PersonalTokenForm
                busy={busy}
                onSubmit={(token) => {
                  after('personal_token', token);
                }}
              />
            </div>
          ) : null}
          <div class="min-h-6 w-full max-w-[32rem]">
            <ConnectMessage outcome={outcome} />
          </div>
        </div>
      )}
    </>
  );
}
