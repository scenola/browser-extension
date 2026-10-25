# The mock API

A local stand-in for the Scenola routes the extension uses, so a contributor can run the
extension without the private backend, and the end-to-end tests can drive every answer the
server gives. It behaves as the server does — the backend line each rule mirrors is named in the
code beside it — so code that passes against the mock passes against the server.

```sh
pnpm mock-api                                        # http://127.0.0.1:8787
node tools/mock-api/server.ts --port=9000
node tools/mock-api/server.ts --public-url=http://localhost:8787
```

Set the extension's API base URL **and** its web-app base URL to the URL it prints. It listens on
127.0.0.1 only and keeps everything in memory: restart it to start over.

**The base URL must be exactly the one the extension is configured with.** A DPoP proof names the
URL it was made for (`htu`), and the mock compares it with its own public URL, as the server
compares it with `api_public_base_url`. `http://localhost:8787` and `http://127.0.0.1:8787` are
different URLs: if the extension is built with `localhost`, start the mock with
`--public-url=http://localhost:8787`.

## Routes

- `GET /connect/extension?…` — the approval page the sign-in opens: one **Approve** button. It
  renders nothing from its query.
- `POST /connect/extension?…` — the button: mints a code and answers `303` to
  `redirect_uri?code=…&state=…`, only when the redirect is `https://<32 letters a–p>.chromiumapp.org/`
  exactly. Anything else is refused on the page and never redirected to.
- `POST /__test/approve` — what `TestAuth` calls: the body of the backend's
  `POST /v1/me/scrobblers/authorize`, answered `{redirect_to}`.
- `POST /v1/integrations/oauth/token` — the code exchange: PKCE, the DPoP proof, the nonce.
  Answers the DPoP-bound credential.
- `POST /v1/integrations/plays` — a play: `Authorization: DPoP`, its proof, an `Idempotency-Key`,
  the evidence. `202`. The account's two lines decide at the door: each is a share of
  the **base** (`story_seconds` when sent, else `duration_seconds`) against the **measure**
  (`played_seconds` when sent, else `furthest_position_seconds`). A viewing counts with no numbers
  at all, at `ended: true`, or once the measure reaches `ceil(finish × base / 100)`; a start
  (`report: "start"`) once it reaches `max(ceil(start × base / 100), 300)` with starts on. Anything
  else is answered `202` with `scrobble_id: null` and `ignored` / `not_completed`, and not kept.
  The model refuses (`422`) a story longer than the running time, a story without
  `played_seconds`, more played than the story (or than the running time with no story), and a
  start that is an episode's, lacks `duration_seconds` or `furthest_position_seconds`, or says
  `ended: true`.
- `GET /v1/integrations/plays/{id}` — the play's receipt: `received`, then, 5 s later on the mock's
  clock, `recorded` for a viewing (the door kept only what counts). A kept start reads `started`,
  or `ignored` / `status_stands` when a stored play of the same film was recorded or started; both
  name the title.
- `GET /v1/integrations/connection` — the connection read:
  `200 {status, created_at, expires_at, start_threshold_percent, start_floor_seconds,
finish_threshold_percent, account_key}` (the account's lines: starts `null` until `setStartThreshold`, the
  floor 300, the finish 70 until `setFinishThreshold`), authenticated as the receipt read is (its failures share that
  address bucket) with its own budget, `integration_connection_reads`, 30 a minute. `status` is
  `active`, `braked` or `suspended`, never `revoked` (a revoked or ended credential gets the
  `401 scrobbling.credential_invalid` every route gives) and never `awaiting_binding`.
  `created_at` is the sign-in and never moves; `expires_at` is when the presented credential stops
  working (the sooner of its sliding and its absolute end). **Reading it slides nothing**: only a
  stored play moves `expires_at`, at most every ten minutes.

`/__test/approve` takes the real route's body — `client`, `redirect_uri`, `code_challenge`,
`code_challenge_method`, `dpop_jkt`, `state` **and** `display_name` — and its `Idempotency-Key`,
so the same `TestAuth` code works against the real backend. The mock has no accounts; an
`Authorization` header is accepted, not required. Like the real one it is shown once: the same key
again answers `409 idempotency.already_applied`.

## What it mirrors

- **The order of the server's layers**: the body cap (`413` over 16 KiB on the plays route, 64 KiB
  elsewhere), the idempotency layer, the JSON parse, the credential and its proof, the budget, the
  body's schema, the route. A refusal comes from the layer the server's comes from — a replay or a
  missing key never reaches authentication.
- **DPoP**, in the server's order of checks: size, `typ`, `alg`
  (ES256 only), a public P-256 `jwk` on the curve, the key the credential is bound to, the
  signature (`jose`), `htm`, `htu` (normalised as the server normalises it), `iat`,
  the nonce, `jti`, `ath`. A `jti` is single use for 10 minutes. The nonce is an HMAC of a
  5-minute bucket; the current and the previous are accepted. A stale or missing nonce is a `400`
  with `details.error = use_dpop_nonce` at the token endpoint, and a
  `401 scrobbling.dpop_nonce_required` on the plays routes, each with a fresh `DPoP-Nonce`; every
  answer to a verified proof carries one. A replay carries none: it verified nothing.
- **One answer for every bad credential**: `401 scrobbling.credential_invalid`, with
  `WWW-Authenticate: Bearer, DPoP algs="ES256"`, whatever was wrong — a thief's own key never
  learns that the credential is live. Failures are counted per address and door (30 a minute); the
  31st is a `429`.
- **The code**: 43 characters, 60 seconds, single use, bound to its redirect,
  its verifier and its key; a refusal spends nothing. Ten live connections at most
  (`409 scrobbling.scrobbler_limit_reached`). A credential is `mts_ext_…` with the server's CRC32
  checksum, and lives 90 days past its last play and at most a year.
- **Idempotency**: the same key and body → the first answer; a different body →
  `422 idempotency.body_mismatch`; the first still running → `409 idempotency.in_flight` (the lock
  lives 45 s); a key that changes only its spelling → `409 idempotency.already_applied`, because
  the server keys its record and its claim differently. Scoped by the credential.
- **The evidence**: validated by the OpenAPI subset's own `PlayEvidence` — a schema keyword the
  validator does not implement stops the mock from starting — plus the model's rules (an offset on
  `watched_at`, at least one identifying field) and the door's window (30 days back, 24 hours
  ahead, both inclusive: `422 scrobbling.watched_at_out_of_range`). Budgets: 120 plays and 240
  receipt reads a minute per connection.
- **The envelope**: `{"error": {code, message, request_id, details, retry_after_seconds}}`, where
  `details` and `retry_after_seconds` appear only when they say something, as the server writes
  them. Ids are 26 lowercase Crockford characters; a receipt takes either case and the aliases.

## Where it is stricter than the server

Stricter is the safe direction: what passes here passes there. Pydantic's lax mode accepts `"5"` or
`true` for an integer, `"true"` or `1` for a boolean and a number for `watched_at`, a body in UTF-16,
and an `Idempotency-Key` that `int()` would read with a sign or an `0x`; the mock refuses each.

## What it does not do

Personal tokens (`Bearer mts_pat_…`: every one is unknown), rotation, the brake's own logic (a
braked connection is set by hand, below), the matching ladder (a play the door kept is
`recorded` by default), Safari's redirects, FastAPI's trailing-slash redirect. It keeps at most 10 000 plays (then `503`).

It records an answer before sending it; the server records it after the send. So against the
server, a same-key retry the instant an answer arrives can still meet `409 idempotency.in_flight`,
and here it never does on its own — force `in_flight` to test that path.

## In tests

```ts
import { startMockApi } from '../tools/mock-api/server.ts';

const api = await startMockApi({ port: 0, now: Date.parse('2026-10-21T12:00:00Z') });
// …point the code under test at api.url…
api.advance(5_000); // the receipt now reads `recorded`
api.plays; // every play stored, as sent
await api.close();
```

`now` freezes the clock: it then moves only with `advance` (nonces, code lifetimes, receipts,
budgets, locks). `held` counts the requests a forced `hang` is holding.

The web app's part — what the person does on the connections page — is played by five controls:

```ts
api.connections(); // the ids of the live connections, oldest first
api.revoke(); // Disconnect: every live connection (or `revoke(id)` for one)
api.setStatus('braked'); // 'active' | 'braked' | 'suspended' (or `setStatus(status, id)`)
api.setStartThreshold(10); // 5 | 10 | 20, or null: starts off (the default), for every connection
api.setFinishThreshold(90); // 50 | 70 (the default) | 90: when a viewing counts
```

After `revoke()` the credential gets the plays route's `401 scrobbling.credential_invalid` at
every route: plays, receipts and the connection read. `braked` is what the connection read states
and what the plays route applies: each play is held (`held` / `braked`). `suspended` (an account
being deleted) is stated, and a play is answered and not kept (`202`, `scrobble_id: null`,
`dismissed` / `account_deletion`). A standing status outranks the script's `progression`.

A `MockScript` forces answers, per route, each consumed by one request in order — at the point
where the server would give it, so a forced answer after a verified proof carries a fresh nonce:

```ts
startMockApi({
  port: 0,
  script: {
    token: ['limit_reached'],
    plays: ['nonce_required', { fault: 'rate_limited', retryAfterSeconds: 7 }, 'lost_answer'],
    receipts: ['not_found'],
    connection: ['unavailable', { fault: 'rate_limited', retryAfterSeconds: 7 }],
    progression: () => [
      { afterMs: 0, state: 'received' },
      { afterMs: 10_000, state: 'needs_confirmation', reason: 'text_only' },
    ],
  },
});
api.force({ plays: ['drop'] }); // more, later
```

The token endpoint:

- on arrival: `proof_invalid`, `feature_closed`, `rate_limited`, `drop`, `hang`, `raw`;
- once the proof verified: `nonce_required`, `code_invalid`, `plus_required`,
  `session_not_fresh`, `limit_reached`, `unavailable`, `internal_error`.

The plays route:

- on arrival: `feature_closed`, `too_large`, `in_flight`, `already_applied`, `body_mismatch`,
  `credential_invalid`, `drop`, `raw`;
- once the proof verified: `nonce_required`, `rate_limited`, `validation_failed`,
  `watched_at_out_of_range`, `unavailable`, `overloaded`, `internal_error`, `deadline`, `not_kept`,
  `hang` (holding the key until the client gives up) and `lost_answer` (stored and recorded, then
  the connection drops).

The receipt read:

- on arrival: `feature_closed`, `credential_invalid`, `drop`, `hang`, `raw`;
- once the proof verified: `nonce_required`, `rate_limited`, `not_found`, `unavailable`,
  `internal_error`.

The connection read takes the receipt read's list without `not_found`:

- on arrival: `feature_closed`, `credential_invalid`, `drop`, `hang`, `raw`;
- once the proof verified: `nonce_required`, `rate_limited`, `unavailable`, `internal_error`.

`{ fault: 'raw', status, body | text, headers }` sends anything at all, verbatim. A script the mock
cannot honour — an unknown name, a status outside 200–599, a progression that is not one — is
refused when it is given.

The mock logs nothing a request carried: an error is reported by its kind alone.
