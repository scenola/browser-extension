/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The store build's sign-in: PKCE with a credential bound to a DPoP key.
//
//   1. a fresh ECDSA P-256 key, non-extractable, and a PKCE verifier and `state`;
//   2. the verifier and the `state` written to `storage.session` before any window opens;
//   3. the web app's approval page in `identity.launchWebAuthFlow`, which ends at the
//      extension's redirect with a code — or never, when the person closes the window;
//   4. the returned `state` compared exactly with this flow's, the code traded for the
//      credential (`exchangeCode`);
//   5. the connection — its state, the credential and the key pair — written in one put.
//
// Nothing about the connection is stored before step 5, and step 5 is one IndexedDB write, so a
// worker that stops anywhere in the flow leaves the connection as it was: never a key without
// a credential, never a credential without its key. The flow record of step 2 is the only trace
// a stopped flow leaves, and the next worker deletes it (`discardInterruptedSignIn`).
//
// One flow at a time: the mutex below is module-level, so every strategy that opens an approval
// (this one and the e2e build's `TestAuth`) shares it, and a second `connect()` while one runs
// answers the first one's promise — one window, one code, one connection.

import {
  ProtocolInputError,
  buildApprovalUrl,
  createPkce,
  exchangeCode,
  generateDpopKey,
  jwkThumbprint,
  publicJwk,
  randomBytes,
} from '@mt/api';
import type { NonceStore } from '@mt/api';
import { uuidv7 } from '@mt/core';
import type { AuthStrategy, Clock, ConnectResult, ConnectionState } from '@mt/core';
import type { Browser } from 'wxt/browser';

import { isRecord } from '../values';

type Connected = Extract<ConnectionState, { kind: 'connected' }>;

/** What a sign-in strategy writes on success: the whole connection, in one put. */
export interface CredentialStore {
  saveCredential(
    state: Connected,
    accessToken: string,
    keyPair: CryptoKeyPair | null,
  ): Promise<void>;
}

/** One diagnostics line (`DiagnosticsLog.log`): an event name and ids or codes, nothing else. */
export type SignInLog = (event: string, detail: Readonly<Record<string, unknown>>) => Promise<void>;

/** The flow in progress, as `storage.session` holds it for its lifetime (step 2 above). */
interface PendingFlow {
  readonly v: 1;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly startedAt: number;
}

const FLOW_KEY = 'signInFlow';

/**
 * The flow record in `storage.session` — memory only, cleared when the browser closes, and
 * closed to content scripts (its default access level). Every method is total: a store that
 * cannot answer is no flow.
 */
export class SessionFlowStore {
  readonly #area: Browser.storage.StorageArea;

  constructor(area: Browser.storage.StorageArea) {
    this.#area = area;
  }

  /** Written before the window opens; a failure here stops the flow before anything is shown. */
  async save(flow: PendingFlow): Promise<void> {
    await this.#area.set({ [FLOW_KEY]: flow });
  }

  async load(): Promise<PendingFlow | null> {
    try {
      return readFlow((await this.#area.get(FLOW_KEY))[FLOW_KEY]);
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      await this.#area.remove(FLOW_KEY);
    } catch {
      // Gone with the browser session anyway; the next flow overwrites it.
    }
  }
}

function readFlow(r: unknown): PendingFlow | null {
  if (
    !isRecord(r) ||
    r.v !== 1 ||
    typeof r.state !== 'string' ||
    typeof r.verifier !== 'string' ||
    typeof r.redirectUri !== 'string' ||
    typeof r.startedAt !== 'number'
  ) {
    return null;
  }
  return {
    v: 1,
    state: r.state,
    verifier: r.verifier,
    redirectUri: r.redirectUri,
    startedAt: r.startedAt,
  };
}

/**
 * A flow record left by a worker that stopped mid-flow: its window's code went with it (the
 * redirect is caught only by the call that opened it), so the record is deleted at the next
 * start rather than left beside a verifier nobody will use.
 */
export async function discardInterruptedSignIn(flows: SessionFlowStore): Promise<void> {
  await flows.clear();
}

/** What every PKCE + DPoP strategy needs. */
export interface PkceDpopDeps {
  /** The configured public API base URL: the token endpoint's `htu` is built from it. */
  readonly apiBase: string;
  readonly fetch: typeof fetch;
  readonly nonces: NonceStore;
  readonly clock: Clock;
  readonly credentials: CredentialStore;
  readonly flows: SessionFlowStore;
  /** `identity.getRedirectURL()`: `https://<extension id>.chromiumapp.org/`. */
  readonly redirectUri: () => string;
  readonly log: SignInLog;
}

/** What the approval is asked to approve (`buildApprovalUrl`'s parameters). */
export interface Approval {
  readonly redirectUri: string;
  readonly challenge: string;
  readonly jkt: string;
  readonly state: string;
}

/**
 * How an approval ended: at the redirect, with its URL; without one (`cancelled`, and why, for
 * diagnostics only); or refused by the server outright (the test approval's HTTP answers).
 */
export type ApprovalAnswer =
  | { readonly kind: 'redirected'; readonly url: string }
  | { readonly kind: 'cancelled'; readonly why: string }
  | Exclude<ConnectResult, { kind: 'connected' | 'cancelled' }>;

/** An `unavailable`'s `detail`, for the log only: why the server could not be asked. */
const why = (result: { readonly kind: string; readonly detail?: string }): { detail?: string } =>
  result.detail === undefined ? {} : { detail: result.detail };

/** The only flow running in this worker, whichever strategy started it. */
let flight: Promise<ConnectResult> | null = null;

/**
 * Runs one PKCE + DPoP sign-in through `approve`, or answers the one already running. `approve`
 * opens whatever stands for the approval page and resolves when it ends.
 */
export function connectPkceDpop(
  deps: PkceDpopDeps,
  strategy: AuthStrategy['id'],
  approve: (approval: Approval) => Promise<ApprovalAnswer>,
): Promise<ConnectResult> {
  if (flight !== null) return flight;
  const run = signIn(deps, strategy, approve).finally(() => {
    flight = null;
  });
  flight = run;
  return run;
}

async function signIn(
  deps: PkceDpopDeps,
  strategy: AuthStrategy['id'],
  approve: (approval: Approval) => Promise<ApprovalAnswer>,
): Promise<ConnectResult> {
  const { clock, flows, log } = deps;
  const jti = (): string => uuidv7(clock.now(), randomBytes);
  let secrets: Awaited<ReturnType<typeof prepare>>;
  const redirectUri = deps.redirectUri();
  try {
    secrets = await prepare();
    // Persisted before the window opens (step 2), and only for the flow's lifetime.
    await flows.save({
      v: 1,
      state: secrets.pkce.state,
      verifier: secrets.pkce.verifier,
      redirectUri,
      startedAt: clock.now(),
    });
  } catch (error: unknown) {
    // The platform could not make a key, the random values or the flow record: nothing was
    // shown and nothing is stored. A bug or a broken browser, never the person's doing.
    void log('signin.failed', { strategy, step: 'prepare', reason: faultOf(error) });
    throw error;
  }
  const { pair, jwk, jkt, pkce } = secrets;
  try {
    const answer = await approve({
      redirectUri,
      challenge: pkce.challenge,
      jkt,
      state: pkce.state,
    });
    if (answer.kind === 'cancelled') {
      void log('signin.cancelled', { strategy, why: answer.why });
      return { kind: 'cancelled' };
    }
    if (answer.kind !== 'redirected') {
      void log('signin.refused', { strategy, kind: answer.kind, step: 'approve', ...why(answer) });
      return answer;
    }
    const back = readRedirect(answer.url, redirectUri);
    if (back.kind === 'cancelled') {
      void log('signin.cancelled', { strategy, why: back.why });
      return { kind: 'cancelled' };
    }
    // The state the approval came back with must be this flow's, exactly: the one in memory and
    // the one persisted for it. A flow whose record went (another start cleared it) is not ours
    // to finish.
    const persisted = await flows.load();
    if (back.state !== pkce.state || persisted?.state !== pkce.state) {
      void log('signin.cancelled', { strategy, why: 'state_mismatch' });
      return { kind: 'cancelled' };
    }
    const exchanged = await exchangeCode(
      {
        fetch: deps.fetch,
        apiBase: deps.apiBase,
        pair,
        jwk,
        nonces: deps.nonces,
        now: () => clock.now(),
        jti,
      },
      { code: back.code, verifier: persisted.verifier, redirectUri: persisted.redirectUri },
    );
    if (exchanged.kind !== 'token') {
      void log('signin.refused', {
        strategy,
        kind: exchanged.kind,
        step: 'token',
        ...why(exchanged),
      });
      return exchanged;
    }
    const connectedAt = clock.now();
    const state: Connected = {
      kind: 'connected',
      id: uuidv7(connectedAt, randomBytes),
      strategy: 'pkce_dpop',
      connectedAt,
      expiresAt: connectedAt + exchanged.expiresIn * 1000,
    };
    // The one write that makes the connection: its state, the credential and the key together.
    await deps.credentials.saveCredential(state, exchanged.accessToken, pair);
    void log('signin.connected', { strategy, connectionId: state.id });
    return { kind: 'connected', state };
  } catch (error: unknown) {
    void log('signin.failed', { strategy, step: 'flow', reason: faultOf(error) });
    throw error;
  } finally {
    await flows.clear();
  }
}

/** A new connection's key, its JWK and thumbprint, and the flow's PKCE secrets. */
async function prepare() {
  const pair = await generateDpopKey();
  const jwk = await publicJwk(pair);
  const jkt = await jwkThumbprint(jwk);
  const pkce = await createPkce(randomBytes);
  return { pair, jwk, jkt, pkce };
}

const MAX_REDIRECT_LENGTH = 8192;
/** The server mints 43-character codes and takes `state` up to 512 visible ASCII characters. */
const MAX_PARAM_LENGTH = 512;

type Redirect =
  | { readonly kind: 'code'; readonly code: string; readonly state: string }
  | { readonly kind: 'cancelled'; readonly why: string };

/**
 * The approval's redirect, read totally: it must be the redirect this flow named (origin and
 * path), carry no `error`, and exactly one `code` and one `state`. Anything else is a flow that
 * did not end in an approval.
 *
 * @public
 */
export function readRedirect(raw: string, redirectUri: string): Redirect {
  if (raw.length > MAX_REDIRECT_LENGTH) return { kind: 'cancelled', why: 'redirect_too_long' };
  let url: URL;
  let expected: URL;
  try {
    url = new URL(raw);
    expected = new URL(redirectUri);
  } catch {
    return { kind: 'cancelled', why: 'redirect_unreadable' };
  }
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    return { kind: 'cancelled', why: 'redirect_elsewhere' };
  }
  const params = url.searchParams;
  if (params.has('error')) return { kind: 'cancelled', why: 'denied' };
  const codes = params.getAll('code');
  const states = params.getAll('state');
  const code = codes[0];
  const state = states[0];
  if (codes.length !== 1 || states.length !== 1 || code === undefined || state === undefined) {
    return { kind: 'cancelled', why: 'no_code' };
  }
  if (
    code.length === 0 ||
    state.length === 0 ||
    code.length > MAX_PARAM_LENGTH ||
    state.length > MAX_PARAM_LENGTH
  ) {
    return { kind: 'cancelled', why: 'no_code' };
  }
  return { kind: 'code', code, state };
}

/** Why a step threw, by reason or by kind only: never its message, which may carry a value. */
function faultOf(error: unknown): string {
  if (error instanceof ProtocolInputError) return error.reason;
  return error instanceof Error ? error.name.slice(0, 64) : typeof error;
}

// ── Chrome's approval window ─────────────────────────────────────────────────────────────────

type Identity = Pick<typeof Browser.identity, 'launchWebAuthFlow'>;

export interface ChromePkceDpopDeps extends PkceDpopDeps {
  /** The web app's origin: the approval page is `<webBase>/connect/extension`. */
  readonly webBase: string;
  readonly identity: Identity;
  /**
   * Any extension API call (`runtime.getPlatformInfo`): made while the window is open, so the
   * worker's 30-second idle timer does not stop it while the person signs in.
   */
  readonly keepAlive: () => Promise<unknown>;
}

/** An extension API call this often keeps the worker from its 30-second idle stop. */
const KEEP_ALIVE_MS = 20_000;

/**
 * The store build's strategy (`pkce_dpop`): the approval is the web app's page in Chrome's
 * sign-in window (`identity.launchWebAuthFlow`, interactive). If the window shares the
 * browser's web session the person approves at once; if not, they sign in inside it first. A
 * window the person closes is `cancelled`.
 */
export class ChromePkceDpopAuth implements AuthStrategy {
  readonly id = 'pkce_dpop';
  readonly #deps: ChromePkceDpopDeps;

  constructor(deps: ChromePkceDpopDeps) {
    this.#deps = deps;
  }

  connect(): Promise<ConnectResult> {
    return connectPkceDpop(this.#deps, this.id, (approval) => this.#window(approval));
  }

  async #window(approval: Approval): Promise<ApprovalAnswer> {
    const { identity, keepAlive, webBase } = this.#deps;
    const url = buildApprovalUrl(webBase, approval);
    const timer = setInterval(() => {
      keepAlive().catch(() => undefined);
    }, KEEP_ALIVE_MS);
    try {
      const returned = await identity.launchWebAuthFlow({ url, interactive: true });
      return typeof returned === 'string'
        ? { kind: 'redirected', url: returned }
        : { kind: 'cancelled', why: 'no_redirect' };
    } catch (error: unknown) {
      // Closed by the person ("did not approve"), or the page could not load: either way no
      // code came back. The kind is kept for diagnostics, never Chrome's message itself.
      return { kind: 'cancelled', why: windowEnding(error) };
    } finally {
      clearInterval(timer);
    }
  }
}

function windowEnding(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/did not approve/iu.test(message.slice(0, 200))) return 'window_closed';
  if (/could not be loaded/iu.test(message.slice(0, 200))) return 'page_not_loaded';
  return 'window_failed';
}
