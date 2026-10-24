/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The approval page the sign-in opens: the web app's
// `/connect/extension`, which asks the person to approve and redirects back with a code.

import { apiUrl } from './http';
import { ProtocolInputError } from './input-error';

export interface ApprovalParams {
  /** `chrome.identity.getRedirectURL()`: where the approval sends the code. */
  readonly redirectUri: string;
  /** The PKCE S256 challenge (`createPkce`). */
  readonly challenge: string;
  /** The key's RFC 7638 thumbprint (`jwkThumbprint`): the credential is bound to it. */
  readonly jkt: string;
  /** The flow's `state`, compared exactly when the approval returns. */
  readonly state: string;
}

/**
 * `<webBase>/connect/extension?client=chrome_extension&redirect_uri=…&code_challenge=…
 * &code_challenge_method=S256&dpop_jkt=…&state=…`, every value form-encoded, so none can add or
 * replace a parameter. Refuses (`bad_url`) a web base that is not an absolute http(s) URL
 * without userinfo, query or fragment — a configuration error, found before a window opens.
 */
export function buildApprovalUrl(webBase: string, p: ApprovalParams): string {
  if (!isPlainBase(webBase)) throw new ProtocolInputError('bad_url');
  const query = new URLSearchParams([
    ['client', 'chrome_extension'],
    ['redirect_uri', p.redirectUri],
    ['code_challenge', p.challenge],
    ['code_challenge_method', 'S256'],
    ['dpop_jkt', p.jkt],
    ['state', p.state],
  ]);
  return `${apiUrl(webBase, '/connect/extension')}?${query.toString()}`;
}

function isPlainBase(base: string): boolean {
  if (base.includes('?') || base.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username === '' &&
    url.password === ''
  );
}
