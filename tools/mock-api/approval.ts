/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The approval: what the web app's `/connect/extension` page posts to the backend's
// `POST /v1/me/scrobblers/authorize` once the person confirms, read here as that route reads it
// (its `AuthorizeExtensionRequest` model, then the code-minting checks), and the mock's own
// stand-in for the page: a static HTML document with one Approve button.
//
// The page renders no value from its query — the form posts back to the page's own URL, query
// and all — so there is nothing in it to escape. It redirects only to a redirect URI shaped as
// the backend allowlists Chrome's (`https://<32 letters a–p>.chromiumapp.org/`, exactly), and a
// refused approval is answered on the page, never redirected anywhere: no open redirect.

import type { Errors } from './evidence.ts';
import { noErrors } from './evidence.ts';
import type { Approval } from './state.ts';

/** `_chrome_redirects`: `https://<extension id>.chromiumapp.org/`, an id being 32 of `a`–`p`. */
const CHROME_REDIRECT = /^https:\/\/[a-p]{32}\.chromiumapp\.org\/$/;
/** `SHA256_B64URL_PATTERN`. */
const SHA256_B64URL = /^[A-Za-z0-9_-]{43}$/;
/** `_STATE`: visible ASCII, 1 to `STATE_MAX_LENGTH`. */
const STATE = /^[\x21-\x7e]{1,512}$/;
/** `_plain_text`: no `C*` code point and no line or paragraph separator. */
const NOT_PLAIN = /[\p{C}\p{Zl}\p{Zp}]/u;

const REDIRECT_URI_MAX_LENGTH = 512;
const STATE_MAX_LENGTH = 512;
const DISPLAY_NAME_MAX_LENGTH = 60;
const CLIENTS = ['chrome_extension', 'safari_extension'] as const;

/** What the mock calls a connection approved on its own page. */
const PAGE_DISPLAY_NAME = 'Chrome (mock)';

/** The approval's fields, in `AuthorizeExtensionRequest`'s order. */
const FIELDS = [
  'client',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'dpop_jkt',
  'state',
  'display_name',
] as const;

/** The query the extension's approval URL carries (`buildApprovalUrl`): every field but the name. */
const QUERY_FIELDS = FIELDS.filter((f) => f !== 'display_name');

export type ApprovalRead =
  | { readonly ok: true; readonly approval: Approval }
  /** `422 validation.failed` with the model's entries (`details.errors`). */
  | { readonly ok: false; readonly kind: 'model'; readonly errors: Errors }
  /** `422 validation.failed` raised by the code-minting checks, with its message and details. */
  | {
      readonly ok: false;
      readonly kind: 'rule';
      readonly message: string;
      readonly details: Readonly<Record<string, string | number>>;
    };

/** The route's body, judged as the backend judges it; total over any JSON value. */
export function readApprovalBody(value: unknown): ApprovalRead {
  const errors = noErrors();
  const add = (loc: readonly (string | number)[], type: string, msg: string): void => {
    errors.count += 1;
    if (errors.errors.length < 20) errors.errors.push({ loc, type, msg });
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    add(
      ['body'],
      'model_type',
      'Input should be a valid dictionary or instance of AuthorizeExtensionRequest',
    );
    return { ok: false, kind: 'model', errors };
  }
  const body = value as Readonly<Record<string, unknown>>;
  const text = (name: (typeof FIELDS)[number], min: number, max: number, pattern?: RegExp) => {
    if (!Object.hasOwn(body, name)) {
      add(['body', name], 'missing', 'Field required');
      return;
    }
    const field = body[name];
    if (typeof field !== 'string') {
      add(['body', name], 'string_type', 'Input should be a valid string');
      return;
    }
    const length = Array.from(field).length;
    const loc = ['body', name];
    if (length < min) {
      add(loc, 'string_too_short', `String should have at least ${String(min)} characters`);
    } else if (length > max) {
      add(loc, 'string_too_long', `String should have at most ${String(max)} characters`);
    } else if (pattern !== undefined && !pattern.test(field)) {
      add(loc, 'string_pattern_mismatch', `String should match pattern '${pattern.source}'`);
    }
  };
  const literal = (name: (typeof FIELDS)[number], allowed: readonly string[]) => {
    if (!Object.hasOwn(body, name)) add(['body', name], 'missing', 'Field required');
    else if (!allowed.includes(body[name] as string)) {
      const expected = allowed.map((a) => `'${a}'`).join(' or ');
      add(['body', name], 'literal_error', `Input should be ${expected}`);
    }
  };
  literal('client', CLIENTS);
  text('redirect_uri', 1, REDIRECT_URI_MAX_LENGTH);
  text('code_challenge', 43, 43, SHA256_B64URL);
  literal('code_challenge_method', ['S256']);
  text('dpop_jkt', 43, 43, SHA256_B64URL);
  text('state', 1, STATE_MAX_LENGTH);
  text('display_name', 1, DISPLAY_NAME_MAX_LENGTH);
  for (const name of Object.keys(body)) {
    if (!(FIELDS as readonly string[]).includes(name)) {
      add(['body', name.slice(0, 100)], 'extra_forbidden', 'Extra inputs are not permitted');
    }
  }
  if (errors.count > 0) return { ok: false, kind: 'model', errors };

  const client = body.client as Approval['client'];
  const redirectUri = body.redirect_uri as string;
  const state = body.state as string;
  // The code-minting checks, in the server's order (the method and the two digests the model took).
  if (!STATE.test(state)) {
    return rule(`state must be 1 to ${String(STATE_MAX_LENGTH)} visible ASCII characters`, {
      field: 'state',
    });
  }
  // Safari's callbacks are the containing app's; the mock is configured with none.
  if (!(client === 'chrome_extension' && CHROME_REDIRECT.test(redirectUri))) {
    return rule('redirect_uri is not registered for this client', {
      field: 'redirect_uri',
      reason: 'not_allowed',
    });
  }
  const displayName = (body.display_name as string).normalize('NFC').trim();
  const nameLength = Array.from(displayName).length;
  if (nameLength < 1 || nameLength > DISPLAY_NAME_MAX_LENGTH) {
    return rule(`display_name must be 1 to ${String(DISPLAY_NAME_MAX_LENGTH)} characters`, {
      field: 'display_name',
      max_length: DISPLAY_NAME_MAX_LENGTH,
    });
  }
  if (NOT_PLAIN.test(displayName)) {
    return rule('display_name must be plain text', { field: 'display_name' });
  }
  return {
    ok: true,
    approval: {
      client,
      redirectUri,
      codeChallenge: body.code_challenge as string,
      dpopJkt: body.dpop_jkt as string,
      state,
      displayName,
    },
  };
}

function rule(message: string, details: Readonly<Record<string, string | number>>): ApprovalRead {
  return { ok: false, kind: 'rule', message, details };
}

/**
 * The page's query, judged as the route judges the body the page would post: each of the six
 * parameters exactly once and nothing else — a repeated parameter has no one meaning, so it is
 * refused rather than resolved.
 */
export function readApprovalQuery(query: URLSearchParams): ApprovalRead {
  const body: Record<string, string> = { display_name: PAGE_DISPLAY_NAME };
  const seen = new Set<string>();
  let count = 0;
  for (const [name, value] of query) {
    count += 1;
    const known = (QUERY_FIELDS as readonly string[]).includes(name);
    if (count > QUERY_FIELDS.length || seen.has(name) || !known) {
      return rule('the approval query is not the extension’s', { field: 'query' });
    }
    seen.add(name);
    body[name] = value;
  }
  return readApprovalBody(body);
}

/** `_with_query(redirect_uri, code=…, state=…)`; the redirect has no query of its own. */
export function redirectTo(approval: Approval, code: string): string {
  return `${approval.redirectUri}?code=${quotePlus(code)}&state=${quotePlus(approval.state)}`;
}

/** Python's `urlencode` value quoting (`quote_plus`, `safe=''`): all but `A–Z a–z 0–9 _ . - ~`. */
function quotePlus(text: string): string {
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    const safe =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x5f ||
      byte === 0x2e ||
      byte === 0x2d ||
      byte === 0x7e;
    out += safe
      ? String.fromCharCode(byte)
      : byte === 0x20
        ? '+'
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

// ── the page ─────────────────────────────────────────────────────────────────────────────────

/**
 * Every page answer's headers: no script at all, a form that may post only to the mock and be
 * redirected only to an extension's redirect, no framing, no referrer (the URL carries the
 * `state`), never cached.
 */
export const PAGE_HEADERS: readonly (readonly [string, string])[] = [
  ['Content-Type', 'text/html; charset=utf-8'],
  [
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://*.chromiumapp.org; frame-ancestors 'none'; base-uri 'none'",
  ],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'no-referrer'],
  ['Cache-Control', 'no-store'],
];

const STYLE =
  'body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;background:#f6f6f4;color:#1d1d1b}' +
  'main{max-width:28rem;margin:0 auto}h1{font-size:1.4rem;margin:0 0 .75rem}' +
  'button{font:inherit;padding:.6rem 1.4rem;border:0;border-radius:6px;background:#1d1d1b;color:#fff;cursor:pointer}' +
  '@media (prefers-color-scheme:dark){body{background:#1d1d1b;color:#f6f6f4}button{background:#f6f6f4;color:#1d1d1b}}';

function page(title: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${title}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`
  );
}

/** The approval page: one button, posting back to this page's own URL (its query unchanged). */
export function approvalPage(): string {
  return page(
    'Approve the connection',
    '<h1>Connect the browser extension?</h1>' +
      '<p>This page belongs to the local mock API. Approving lets the extension add plays to the ' +
      'mock’s test account. Nothing leaves this computer.</p>' +
      '<form method="post"><button type="submit">Approve</button></form>',
  );
}

/** A refused approval: said on the page, never redirected anywhere. */
export function refusedPage(): string {
  return page(
    'Approval refused',
    '<h1>This approval link is not valid</h1>' +
      '<p>Start the connection again from the extension.</p>',
  );
}
