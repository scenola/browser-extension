/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The wire, as the backend's API document states it (`generated/schema.d.ts`, from the subset
// in `tools/openapi/`), plus the one shape the document does not state: the error envelope.

import type { ConnectionStatus, PlayBody } from '@mt/core';

import type { components } from './generated/schema';

type Schemas = components['schemas'];

/** The body of `POST /v1/integrations/plays`. */
export type WirePlay = Schemas['PlayEvidence'];
/** Its `202`: the play's id (or `null` when nothing was kept), state and reason. */
export type WireAccepted = Schemas['PlayAcceptedResponse'];
/** The `200` of `GET /v1/integrations/plays/{scrobble_id}`. */
export type WireReceipt = Schemas['PlayReceiptResponse'];
/** The `200` of `GET /v1/integrations/connection`. */
type WireConnection = Schemas['IntegrationConnectionResponse'];

/**
 * The fields of the one error envelope every refusal answers with
 * (documented by the backend's integrations API), pinned to
 * that description by `tools/gates/error-envelope-contract.test.ts`.
 */
export const WIRE_ERROR_FIELDS = [
  'code',
  'message',
  'request_id',
  'details',
  'retry_after_seconds',
] as const;

/**
 * Every refusal: `{"error": {...}}`; branch on `code`. The API document does not model it:
 * its `422` names FastAPI's `HTTPValidationError` (`{detail: [...]}`), which the server never
 * sends — a `422` is this envelope with `code: "validation.failed"` and the failures in
 * `details`. Read it as untrusted (`unknown`), never by casting an answer to this type.
 */
export interface WireError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly request_id?: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly retry_after_seconds?: number;
  };
}

/**
 * Compile-time proof: the domain's play body is a wire play. `tsc` fails here when
 * `PlayBody` stops fitting `PlayEvidence` — fix `PlayBody`, never this line. That it carries
 * no field the wire refuses (`additionalProperties: false`) is proved in `wire.test-d.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- a proof for tsc, never called
const _playFits: (b: PlayBody) => WirePlay = (b) => b;

/**
 * Compile-time proof: every connection status the domain knows is one the route documents.
 * The route's enum is wider (`awaiting_binding`, `revoked`, which it never
 * answers to a credential that can ask): the gateway reads anything outside the domain's set
 * as no answer, never as one of these.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- a proof for tsc, never called
const _statusFits: (s: ConnectionStatus) => WireConnection['status'] = (s) => s;
