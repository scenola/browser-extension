/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import { receiptView, sentPlayView } from './receipts';
import type { ReceiptState } from './receipts';

const UNKNOWN = { tone: 'neutral', messageKey: 'receipt.unknown', link: null, settled: false };

describe('receiptView', () => {
  test.each([
    ['recorded', null, 'done', 'receipt.recorded', 'title', true],
    ['duplicate', null, 'done', 'receipt.duplicate', 'title', true],
    ['received', null, 'waiting', 'receipt.received', null, false],
    ['awaiting_catalog', null, 'waiting', 'receipt.awaiting_catalog', null, false],
    [
      'needs_confirmation',
      'text_only',
      'attention',
      'receipt.needs_confirmation',
      'waiting',
      false,
    ],
    [
      'needs_confirmation',
      'numbering_unknown',
      'attention',
      'receipt.needs_confirmation',
      'waiting',
      false,
    ],
    [
      'needs_confirmation',
      'anything_new',
      'attention',
      'receipt.needs_confirmation',
      'waiting',
      false,
    ],
    ['needs_confirmation', null, 'attention', 'receipt.needs_confirmation', 'waiting', false],
    ['held', 'plus_lapsed', 'attention', 'receipt.held.plus_lapsed', 'upgrade', false],
    ['held', 'braked', 'attention', 'receipt.held.braked', 'connections', false],
    ['held', 'dormant_return', 'attention', 'receipt.held.dormant_return', 'connections', false],
    ['ignored', 'not_completed', 'neutral', 'receipt.ignored.not_completed', null, true],
    ['ignored', 'unknown_id', 'neutral', 'receipt.ignored.not_tracked', null, true],
    ['ignored', 'not_served', 'neutral', 'receipt.ignored.not_tracked', null, true],
    ['ignored', 'medium_not_served', 'neutral', 'receipt.ignored.not_tracked', null, true],
    ['dismissed', 'user', 'neutral', 'receipt.dismissed.user', null, true],
    ['dismissed', 'revoked', 'attention', 'receipt.dismissed.revoked', 'connections', true],
    ['dismissed', 'account_deletion', 'neutral', 'receipt.dismissed.account_deletion', null, true],
    ['expired', null, 'neutral', 'receipt.expired', null, true],
  ] as const)('%s / %s', (state, reason, tone, messageKey, link, settled) => {
    expect(receiptView(state, reason)).toEqual({ tone, messageKey, link, settled });
  });

  test('an unknown state or reason is neutral and unsettled', () => {
    expect(receiptView('mystery' as ReceiptState, null)).toEqual(UNKNOWN);
    expect(receiptView('held', 'new_reason')).toEqual(UNKNOWN);
    expect(receiptView('held', null)).toEqual(UNKNOWN);
    expect(receiptView('ignored', 'other_account')).toEqual(UNKNOWN);
    expect(receiptView('dismissed', null)).toEqual(UNKNOWN);
  });

  test('unknown state names do not hit the prototype', () => {
    expect(receiptView('constructor' as ReceiptState, null)).toEqual(UNKNOWN);
  });
});

describe('sentPlayView', () => {
  test('a receipt the server no longer has is "no longer tracked", settled, never waiting', () => {
    expect(
      sentPlayView({
        receipt: { state: 'needs_confirmation', reason: 'text_only' },
        receiptGoneAt: 1,
      }),
    ).toEqual({
      tone: 'neutral',
      messageKey: 'receipt.no_longer_tracked',
      link: null,
      settled: true,
    });
  });

  test('otherwise the answer’s own view; no answer at all is unknown', () => {
    expect(
      sentPlayView({ receipt: { state: 'recorded', reason: null }, receiptGoneAt: null }),
    ).toEqual(receiptView('recorded', null));
    expect(sentPlayView({ receipt: null, receiptGoneAt: null })).toEqual(UNKNOWN);
  });
});
