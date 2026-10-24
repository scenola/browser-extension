/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// How long a `ui/connect` token may be, per strategy: spelled once, for the protocol that
// refuses a longer one and for the strategy that reads it. A module of its own with no code, so
// neither side imports the other.

export const CONNECT_TOKEN_LIMITS = {
  /**
   * A personal token is `mts_pat_` and 49 characters, 57 in all. A paste may carry whitespace
   * around it, which the strategy trims; anything longer is not one.
   */
  personalToken: 128,
  /** The dev session `TestAuth` presents once, as RFC 9110 token68 (e2e builds only). */
  testSession: 4096,
} as const;
