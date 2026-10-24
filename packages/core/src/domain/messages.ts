/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every message key core refers to. Core defines the keys; the app supplies the text
 * (and the translations), so a key added here without text fails in the app.
 */
export type MessageKey =
  | 'receipt.recorded'
  | 'receipt.duplicate'
  | 'receipt.received'
  | 'receipt.awaiting_catalog'
  | 'receipt.needs_confirmation'
  | 'receipt.held.plus_lapsed'
  | 'receipt.held.braked'
  | 'receipt.held.dormant_return'
  | 'receipt.ignored.not_completed'
  | 'receipt.ignored.not_tracked'
  | 'receipt.started'
  | 'receipt.ignored.status_stands'
  | 'receipt.ignored.not_placed'
  | 'receipt.start.not_taken'
  | 'receipt.dismissed.user'
  | 'receipt.dismissed.revoked'
  | 'receipt.dismissed.account_deletion'
  | 'receipt.expired'
  | 'receipt.unknown'
  | 'receipt.no_longer_tracked'
  | 'status.idle'
  | 'status.tracking'
  | 'status.added'
  | 'status.added_plain'
  | 'status.waiting'
  | 'status.paused'
  | 'status.paused_indefinitely'
  | 'status.blocked'
  | 'status.not_tracking'
  | 'status.service_off'
  | 'status.incognito_off'
  | 'status.disconnected'
  | 'status.connection_broken'
  | 'status.connection_expiring'
  | 'status.problem.plus_lapsed'
  | 'status.problem.braked';
