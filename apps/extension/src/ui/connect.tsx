/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Connecting, as the welcome page and the settings page share it: which strategy this build
// connects with, the `ui/connect` request, and what each answer is in words. A cancel and a
// refusal look the same to the extension, so a closed window names Scenola Plus as well.

import type { ConnectResult } from '@mt/core';
import { useState } from 'preact/hooks';

import { AUTH_STRATEGIES, WEB_APP_BASE_URL } from '../config';
import { t } from '../i18n/t';
import type { AppMessageKey } from '../i18n/t';
import { isRecord } from '../values';
import { WEB_ROUTES } from '../web-routes';
import { Link } from './components/Link';
import { isPersonalToken } from './personal-token';
import type { UiAsk } from './store';
import type { UiResponse } from '../messaging/protocol';

/**
 * The strategy behind *Connect*: the approval window where the build has it, else the e2e
 * build's test approval. `null` in a build with personal tokens alone.
 */
export const WINDOW_STRATEGY: 'pkce_dpop' | 'test' | null = AUTH_STRATEGIES.includes('pkce_dpop')
  ? 'pkce_dpop'
  : AUTH_STRATEGIES.includes('test')
    ? 'test'
    : null;

/**
 * Whether this build offers a personal token (self-builds; never a store build). The mode is read
 * here, not through `config.ts`, so a store build folds this to `false` (`personal-token.ts`).
 */
export const OFFERS_PERSONAL_TOKEN: boolean =
  import.meta.env.MT_BUILD_MODE !== 'store' && AUTH_STRATEGIES.includes('personal_token');

/** How a connect attempt ended, for the words: a result, or the request's own failure. */
export type ConnectOutcome =
  | { readonly kind: 'result'; readonly result: ConnectResult; readonly strategy: string }
  | { readonly kind: 'error'; readonly error: string };

const RESULT_KINDS: ReadonlySet<string> = new Set([
  'connected',
  'cancelled',
  'code_invalid',
  'proof_invalid',
  'forbidden',
  'limit_reached',
  'feature_closed',
  'unavailable',
]);

function readOutcome(response: UiResponse, strategy: string): ConnectOutcome {
  if (!response.ok) return { kind: 'error', error: response.error };
  const result = isRecord(response.data) ? response.data.result : undefined;
  if (!isRecord(result) || typeof result.kind !== 'string' || !RESULT_KINDS.has(result.kind)) {
    return { kind: 'error', error: 'bad_response' };
  }
  return { kind: 'result', result: result as unknown as ConnectResult, strategy };
}

/** One connect at a time from a page; the worker serialises across pages too. */
export function useConnect(send: (ask: UiAsk) => Promise<UiResponse>) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ConnectOutcome | null>(null);

  const connect = (
    strategy: 'pkce_dpop' | 'personal_token' | 'test',
    token?: string,
  ): Promise<ConnectOutcome> => {
    setBusy(true);
    setOutcome(null);
    // The protocol checks the token per strategy: the window sign-in carries none, a
    // personal token requires one, and only the e2e session may carry an optional one.
    const ask: UiAsk =
      strategy === 'pkce_dpop'
        ? { type: 'ui/connect', strategy }
        : isPersonalToken(strategy)
          ? { type: 'ui/connect', strategy, token: token ?? '' }
          : token === undefined
            ? { type: 'ui/connect', strategy }
            : { type: 'ui/connect', strategy, token };
    return send(ask).then((response) => {
      const read = readOutcome(response, strategy);
      setBusy(false);
      setOutcome(read);
      return read;
    });
  };

  return { busy, outcome, connect };
}

const RESULT_MESSAGES: Readonly<
  Record<Exclude<ConnectResult['kind'], 'connected'>, AppMessageKey>
> = {
  cancelled: 'connect.result.cancelled',
  code_invalid: 'connect.result.code_invalid',
  proof_invalid: 'connect.result.proof_invalid',
  forbidden: 'connect.result.forbidden',
  limit_reached: 'connect.result.limit_reached',
  feature_closed: 'connect.result.feature_closed',
  unavailable: 'connect.result.unavailable',
};

/**
 * Self-builds connect with a personal token pasted from the web app. The field is a
 * password field — the token is a secret, never shown back — and the token goes to the worker
 * once, in the request; the page keeps nothing.
 */
export function PersonalTokenForm({
  busy,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly onSubmit: (token: string) => void;
}) {
  const [token, setToken] = useState('');
  return (
    <form
      class="flex w-full flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const value = token.trim();
        if (value === '') return;
        setToken('');
        onSubmit(value);
      }}
    >
      <label for="personal-token" class="text-body-s font-medium">
        {t('connect.token.label')}
      </label>
      <p id="personal-token-hint" class="text-caption text-muted-foreground">
        {t('connect.token.hint')}
      </p>
      <div class="flex gap-2">
        <input
          id="personal-token"
          type="password"
          autocomplete="off"
          spellcheck={false}
          maxLength={256}
          aria-describedby="personal-token-hint"
          value={token}
          onInput={(event) => {
            setToken(event.currentTarget.value);
          }}
          class="min-h-10 min-w-0 flex-1 rounded-full border border-muted-foreground bg-background px-4 font-mono text-body-s"
        />
        <button
          type="submit"
          disabled={busy || token.trim() === ''}
          class="inline-flex min-h-10 shrink-0 items-center rounded-full bg-secondary px-4 text-body-s font-medium text-secondary-foreground transition-colors duration-state ease-app hover:bg-accent disabled:opacity-50"
        >
          {t('connect.token.submit')}
        </button>
      </div>
    </form>
  );
}

/** A failed connect in words, with the one link that helps, if any. Nothing for a success. */
export function ConnectMessage({ outcome }: { readonly outcome: ConnectOutcome | null }) {
  if (outcome === null) return null;
  if (outcome.kind === 'error') {
    return (
      <p role="alert" class="text-body-s text-foreground">
        {outcome.error === 'no_strategy'
          ? t('connect.error.no_strategy')
          : t('connect.error.failed')}
      </p>
    );
  }
  const { result, strategy } = outcome;
  if (result.kind === 'connected') return null;
  const key =
    result.kind === 'code_invalid' && isPersonalToken(strategy)
      ? 'connect.result.token_invalid'
      : RESULT_MESSAGES[result.kind];
  const link =
    result.kind === 'limit_reached'
      ? {
          href: `${WEB_APP_BASE_URL}${WEB_ROUTES.connections}`,
          label: t('connect.link.connections'),
        }
      : result.kind === 'forbidden'
        ? { href: WEB_APP_BASE_URL, label: t('connect.link.web_app') }
        : null;
  return (
    <div role="alert" class="flex flex-col items-start gap-1.5 text-body-s">
      <p>{t(key)}</p>
      {link === null ? null : <Link href={link.href}>{link.label}</Link>}
    </div>
  );
}
