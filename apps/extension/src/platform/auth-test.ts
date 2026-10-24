/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The end-to-end build's sign-in (`test`): the store build's flow in every step but one — the
// approval is a request instead of a window, because automation cannot click inside Chrome's
// sign-in window. It posts what the web app's approval page posts
// (`POST /v1/me/scrobblers/authorize`'s body, with an `Idempotency-Key`) to `MT_TEST_APPROVE_URL`
// and follows the `redirect_to` it answers. PKCE, the DPoP key, the `state` check and the token
// exchange are the real ones (auth-chrome.ts).
//
// Against the mock API that URL is `/__test/approve`, which asks for no session. Against the dev
// backend (`pnpm e2e:stack`) it is the real route, which needs the person's session: the test
// hands it in as `ui/connect`'s `token` and it is sent as `Authorization: Bearer` on that one
// request — never stored, never compiled into the build. Built only into e2e builds
// (background.ts); a store build carries none of this file.

import { REQUEST_TIMEOUT_MS, errorCode, randomBytes, request } from '@mt/api';
import type { HttpAnswer } from '@mt/api';
import { uuidv7 } from '@mt/core';
import type { AuthStrategy, ConnectResult } from '@mt/core';

import { EXTENSION_NAME } from '../brand';
import { CONNECT_TOKEN_LIMITS } from '../messaging/token-limits';
import { connectPkceDpop } from './auth-chrome';
import type { Approval, ApprovalAnswer, PkceDpopDeps } from './auth-chrome';

export interface TestAuthDeps extends PkceDpopDeps {
  /** `MT_TEST_APPROVE_URL`: the mock's `/__test/approve` or the backend's authorize route. */
  readonly approveUrl: string;
}

/** The connection's name in the web app's *Connected services* (`display_name`, ≤ 60). */
const DISPLAY_NAME = `${EXTENSION_NAME} (e2e)`;

/** RFC 9110 token68, bounded: what may follow `Bearer`. */
const SESSION_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/u;
const MAX_SESSION_TOKEN = CONNECT_TOKEN_LIMITS.testSession;

export class TestAuth implements AuthStrategy {
  readonly id = 'test';
  readonly #deps: TestAuthDeps;

  constructor(deps: TestAuthDeps) {
    this.#deps = deps;
  }

  connect(input?: { readonly token?: string }): Promise<ConnectResult> {
    const session = input?.token;
    if (session !== undefined && !isSessionToken(session)) {
      void this.#deps.log('signin.refused', { strategy: this.id, kind: 'bad_session_token' });
      return Promise.resolve({ kind: 'forbidden' });
    }
    return connectPkceDpop(this.#deps, this.id, (approval) => this.#approve(approval, session));
  }

  async #approve(approval: Approval, session: string | undefined): Promise<ApprovalAnswer> {
    const { approveUrl, clock, fetch, log } = this.#deps;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Shown once, like the real route: a retry is a new approval with a fresh key.
      'Idempotency-Key': uuidv7(clock.now(), randomBytes),
    };
    if (session !== undefined) headers.Authorization = `Bearer ${session}`;
    const answer = await request({
      fetch,
      url: approveUrl,
      method: 'POST',
      headers,
      body: JSON.stringify({
        client: 'chrome_extension',
        redirect_uri: approval.redirectUri,
        code_challenge: approval.challenge,
        code_challenge_method: 'S256',
        dpop_jkt: approval.jkt,
        state: approval.state,
        display_name: DISPLAY_NAME,
      }),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const result = approvalResult(answer);
    if (result.kind !== 'redirected') {
      void log('signin.approve_answer', {
        status: answer.kind === 'response' ? answer.status : answer.kind,
        code: answer.kind === 'response' ? errorCode(answer.json) : null,
      });
    }
    return result;
  }
}

function isSessionToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SESSION_TOKEN && SESSION_TOKEN.test(value);
}

/**
 * The authorize route's answers: `200 {redirect_to}` is the approval; the server's own refusals
 * are read as the token endpoint's are (only an enveloped one is the server's): no session or
 * Plus (`401`, `403`) → `forbidden`, the feature closed (`404`) → `feature_closed`, a refused
 * approval (`422`) → `code_invalid`. Anything else — a replayed key, a budget, a `5xx`, no
 * answer — is `unavailable`: try again.
 */
function approvalResult(answer: HttpAnswer): ApprovalAnswer {
  if (answer.kind !== 'response') return { kind: 'unavailable' };
  const { status, json } = answer;
  if (status === 200) {
    const redirect = redirectTo(json);
    return redirect === null ? { kind: 'unavailable' } : { kind: 'redirected', url: redirect };
  }
  const enveloped = errorCode(json) !== null;
  if (!enveloped) return { kind: 'unavailable' };
  if (status === 401 || status === 403) return { kind: 'forbidden' };
  if (status === 404) return { kind: 'feature_closed' };
  if (status === 422) return { kind: 'code_invalid' };
  return { kind: 'unavailable' };
}

function redirectTo(json: unknown): string | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  if (!Object.hasOwn(json, 'redirect_to')) return null;
  const value = (json as Readonly<Record<string, unknown>>).redirect_to;
  return typeof value === 'string' ? value : null;
}
