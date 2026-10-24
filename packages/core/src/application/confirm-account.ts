/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sameConnection } from './credential-refused';
import type { Connected } from './credential-refused';
import type { AccountData, AccountKey, AccountKnown, ConnectionRepo } from './ports';
import type { ViewingLock } from './viewing-lock';

/** The key a record is made under now: the stored connection's, once a check has read it. */
export const keyOf = (known: AccountKnown): AccountKey | null =>
  known.kind === 'read' ? known.key : null;

interface Deps {
  readonly connection: ConnectionRepo;
  readonly account: AccountData;
  readonly lock: ViewingLock;
}

/** What naming the account changed. */
export type Confirmed =
  /** The connection already knew it: nothing moved. */
  | { readonly kind: 'same' }
  /** Kept now; `deleted` plays and starts not sent yet were another account's, or nobody's. */
  | { readonly kind: 'kept'; readonly deleted: number }
  /** A disconnect or another connection came first: nothing moved. */
  | { readonly kind: 'stale' };

/**
 * A connection check named the account `started` acts for. Until then nothing is sent under
 * that connection; now what the browser keeps is made that account's alone.
 *
 * - A connection a sign-in made (`unread`) may be another person's than the one whose plays
 *   wait here: every record that carries another key, or none, is deleted, never sent.
 * - A connection stored before connections named their account (`inherited`) has had its own
 *   records all along: those without a key take this one.
 * - A connection whose key has changed (the server rotated what it derives keys from) treats
 *   what it holds as another account's: deleted, the safe direction.
 *
 * Inside the viewing lock, so no play is queued between the removal and the key being kept; the
 * removal comes first, so a stop between them only repeats it at the next check.
 */
export class ConfirmAccount {
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  execute(started: Connected, key: AccountKey): Promise<Confirmed> {
    const { connection, account, lock } = this.#deps;
    return lock.run(async () => {
      if (!sameConnection(await connection.get(), started)) return { kind: 'stale' };
      const known = await connection.account();
      if (known.kind === 'read' && known.key === key) return { kind: 'same' };
      if (known.kind === 'inherited') await account.adopt(key);
      const deleted = await account.keepOnly(key);
      await connection.keepAccountKey(started.id, key);
      return { kind: 'kept', deleted };
    });
  }
}
