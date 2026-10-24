/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// How the plays gateway presents the connection: read from storage once per send or receipt — a
// DPoP signer over the stored key pair, or a bearer signer for a personal token — and `null` when
// no usable credential is stored, which the gateway answers as `credential_invalid` without
// sending anything.

import { bearerSigner, dpopSigner, publicJwk } from '@mt/api';
import type { NonceStore, RequestSigner } from '@mt/api';
import { uuidv7 } from '@mt/core';
import type { Clock } from '@mt/core';

import type { StoredCredential } from './connection-store';

interface CredentialSource {
  credential(): Promise<StoredCredential | null>;
}

const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

export function credentialSigner(
  connection: CredentialSource,
  nonces: NonceStore,
  clock: Clock,
): () => Promise<RequestSigner | null> {
  return async () => {
    const credential = await connection.credential();
    if (credential === null) return null;
    // A store build has no personal-token connection to present; the fold drops the name and
    // the bearer signer from its bundle.
    if (import.meta.env.MT_BUILD_MODE !== 'store' && credential.strategy === 'personal_token') {
      return bearerSigner(credential.accessToken);
    }
    if (credential.pair === null) return null;
    let jwk;
    try {
      jwk = await publicJwk(credential.pair);
    } catch {
      // A key whose public half cannot be read cannot sign: the connection is made again.
      return null;
    }
    return dpopSigner({
      pair: credential.pair,
      jwk,
      accessToken: credential.accessToken,
      nonces,
      now: () => clock.now(),
      jti: () => uuidv7(clock.now(), randomBytes),
    });
  };
}
