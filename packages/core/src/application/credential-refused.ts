/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ConnectionState } from '../domain/connection';
import type { ConnectionRepo, Outbox } from './ports';

export type Connected = Extract<ConnectionState, { kind: 'connected' }>;

/** Still the connection a pass started with: not disconnected, not replaced by a reconnect. */
export function sameConnection(current: ConnectionState, started: Connected): current is Connected {
  return current.kind === 'connected' && current.id === started.id;
}

/**
 * `401 scrobbling.credential_invalid` for a request `started` signed: the outbox pauses until
 * a reconnect, then that connection is marked broken. A connection made since,
 * or a disconnect, is left as it is — a late answer for an old credential breaks nothing new.
 *
 * Pause first: a `Connect` landing between the two writes then finds the entries paused and
 * resumes them, and the second check keeps the new connection from being marked broken. In
 * the other order it would resume nothing and the pause would follow it. Whatever is left
 * paused under a good connection, `DrainOutbox` resumes.
 */
export async function credentialRefused(
  connection: ConnectionRepo,
  outbox: Outbox,
  started: Connected,
): Promise<void> {
  if (!sameConnection(await connection.get(), started)) return;
  await outbox.pauseAll();
  if (!sameConnection(await connection.get(), started)) return;
  await connection.set({ kind: 'broken', reason: 'credential_invalid' });
}
