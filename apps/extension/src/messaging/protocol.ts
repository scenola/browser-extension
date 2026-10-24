/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The one message protocol: a versioned discriminated union, validated with valibot on arrival.
// Content scripts send `bootstrap/*` and `collector/*` with `runtime.sendMessage`; the popup and
// the settings pages hold a port named `ui`, send requests over it and receive `ui/response`
// answers and `ui/state` pushes. Every message carries `v: 1`; one this version does not know,
// or of any other shape, is `null` — never a throw. A message never names the site it comes
// from: the worker takes that from the sender (src/composition/content-router.ts).

import { HISTORY_DAYS } from '@mt/core';
import type {
  AccountRule,
  ConnectionState,
  ConnectionStatus,
  EpochMs,
  IgnoredReason,
  ReceiptView,
} from '@mt/core';
import * as v from 'valibot';

import type { AppMessageKey } from '../i18n/t';
import { PROTOCOL_VERSION } from './constants';
import { PlaybackSampleSchema, SnapshotSchema } from './schemas';
import { CONNECT_TOKEN_LIMITS } from './token-limits';

// Spelled once, in constants.ts, so a page can read them without this module's validators.
export { PROTOCOL_VERSION, UI_PORT_NAME } from './constants';

const version = v.literal(PROTOCOL_VERSION);
const text = (max: number) => v.pipe(v.string(), v.maxLength(max));

// ── content scripts → worker ────────────────────────────────────────────────────────────────

/** The bootstrap saw the first `play` of its document; the worker answers `BootstrapAnswer`. */
const BootstrapPlaySchema = v.strictObject({ v: version, type: v.literal('bootstrap/play') });

/** One sample (and the latest snapshot, when one was built); answered `CollectorAnswer`. */
const CollectorReportSchema = v.strictObject({
  v: version,
  type: v.literal('collector/report'),
  isTop: v.boolean(),
  sample: v.nullable(PlaybackSampleSchema),
  snapshot: v.nullable(SnapshotSchema),
});

/** The collector's video has been gone for 30 s; it stopped. */
const CollectorGoneSchema = v.strictObject({ v: version, type: v.literal('collector/gone') });

const ContentMessageSchema = v.variant('type', [
  BootstrapPlaySchema,
  CollectorReportSchema,
  CollectorGoneSchema,
]);

export type ContentMessage = v.InferOutput<typeof ContentMessageSchema>;
export type CollectorReport = v.InferOutput<typeof CollectorReportSchema>;

/** `inject`: the worker injected the collector into the sender's frame. */
export interface BootstrapAnswer {
  readonly inject: boolean;
}

/** `stop`: the frame's site is not (or no longer) tracked; the collector stops. */
export interface CollectorAnswer {
  readonly stop: boolean;
}

/** A content message, or `null` for anything else (an unknown version or shape). */
export function parseMessage(raw: unknown): ContentMessage | null {
  const result = v.safeParse(ContentMessageSchema, raw);
  return result.success ? result.output : null;
}

/** Whether a runtime message is addressed to the content protocol at all (by its `type`). */
export function isContentMessageType(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const type = (raw as { readonly type?: unknown }).type;
  if (typeof type !== 'string') return false;
  return type.startsWith('bootstrap/') || type.startsWith('collector/');
}

// ── pages → worker, over the `ui` port ─────────────────────────────────────────────────────

const requestId = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const ui = <T extends string, E extends v.ObjectEntries>(type: T, entries: E) =>
  v.strictObject({ v: version, id: requestId, type: v.literal(type), ...entries });

const HostListSchema = v.pipe(v.array(text(253)), v.maxLength(500));

/** What `ui/settings` may change; the pause has its own request. */
const SettingsPatchSchema = v.strictObject({
  trackIncognito: v.exactOptional(v.boolean()),
  disabledServices: v.exactOptional(v.pipe(v.array(text(32)), v.maxLength(32))),
  excludedHosts: v.exactOptional(HostListSchema),
  allowedHosts: v.exactOptional(HostListSchema),
  allSites: v.exactOptional(v.boolean()),
  diagnostics: v.exactOptional(v.boolean()),
  historyDays: v.exactOptional(v.picklist(HISTORY_DAYS)),
});

const connect = <S extends string, E extends v.ObjectEntries>(strategy: S, entries: E) =>
  ui('ui/connect', { strategy: v.literal(strategy), ...entries });

/**
 * `ui/connect`, one shape per strategy: the browser sign-in takes no token; a personal token is
 * required and bounded by its own length; the e2e session is optional and bounded by token68's.
 * A store build knows the first alone, since store builds ship without the other two: the
 * build-mode test folds at build time, so they — their names included — are not in its bundle.
 */
const ConnectRequestSchema = v.variant('strategy', [
  connect('pkce_dpop', {}),
  ...(import.meta.env.MT_BUILD_MODE === 'store'
    ? []
    : [
        connect('personal_token', { token: text(CONNECT_TOKEN_LIMITS.personalToken) }),
        connect('test', { token: v.exactOptional(text(CONNECT_TOKEN_LIMITS.testSession)) }),
      ]),
]);

const UiRequestSchema = v.variant('type', [
  /** "Don't add this viewing". */
  ui('ui/skip', { viewingId: text(64) }),
  /** Pause until a moment (`PAUSE_INDEFINITELY` for "until I turn it back on"); `null` resumes. */
  ui('ui/pause', { until: v.nullable(v.pipe(v.number(), v.finite())) }),
  /** *Track this site*, after the page's click was granted the site's access. */
  ui('ui/track-site', { origin: text(300) }),
  /** *What was sent* for one play. */
  ui('ui/what-was-sent', { playId: text(64) }),
  /** Connect with a strategy, each with the token it takes and no other. */
  ConnectRequestSchema,
  /**
   * *Disconnect from this browser*: the account leaves with everything recorded for it;
   * `sendFirst` sends what is left first, for a bounded time. Answers how many went and how many
   * were deleted unsent.
   */
  ui('ui/disconnect', { sendFirst: v.boolean() }),
  /** Changes some settings and answers all of them; `{}` only reads them. */
  ui('ui/settings', { patch: SettingsPatchSchema }),
  /** *Export my extension data*: never the credential or the key. */
  ui('ui/export', {}),
  /** *Clear all local data*: the connection too. */
  ui('ui/clear', {}),
  /** *Clear history*: the plays already sent and their answers, nothing else. */
  ui('ui/clear-history', {}),
  /** *Capture page sample* of a tab, or of the tab that reported last. */
  ui('ui/capture', {
    tabId: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  }),
]);

export type UiRequest = v.InferOutput<typeof UiRequestSchema>;
export type SettingsPatch = v.InferOutput<typeof SettingsPatchSchema>;

export type UiResponse =
  { readonly ok: true; readonly data?: unknown } | { readonly ok: false; readonly error: string };

/** A UI request, or `null` for anything else. */
export function parseUiRequest(raw: unknown): UiRequest | null {
  const result = v.safeParse(UiRequestSchema, raw);
  return result.success ? result.output : null;
}

// ── worker → pages, over the `ui` port ─────────────────────────────────────────────────────

/** How one play is shown: a receipt's view, or the outbox's word for one not answered yet. */
export interface EntryView {
  readonly tone: ReceiptView['tone'];
  readonly messageKey: AppMessageKey;
  readonly link: ReceiptView['link'];
  readonly settled: boolean;
}

/** One question the person is asked, however many plays it settles. */
export interface WaitingRow {
  /** Stable while the question stands: a list key, never shown. */
  readonly id: string;
  /** The show and its episodes, or the newest play's words; empty when it names nothing. */
  readonly label: string;
  /** Episodes or titles the label leaves unnamed: shown as "and N more". */
  readonly more: number;
  /** The plays one answer settles; shown when more than one. */
  readonly count: number;
  /** The question's card in the web app's Up Next, or Up Next itself; built from `WEB_ROUTES`. */
  readonly href: string;
}

export interface HistoryEntryView {
  readonly playId: string;
  /** The words the play is shown by (`playLabel`); empty when it names nothing in words. */
  readonly label: string;
  /** A film begun, not a viewing: shown as *Started*. */
  readonly start: boolean;
  readonly sentAt: EpochMs;
  readonly view: EntryView;
  readonly titleId: string | null;
  /** The web app's page `view.link` points to, built from `WEB_ROUTES`; `null` for none. */
  readonly href: string | null;
}

export interface NowPlaying {
  readonly tabId: number;
  /** The built-in service's name, or the site's host on a site without one. */
  readonly serviceName: string;
  /** What the page says is playing (`playLabel` of the reading); empty when nothing. */
  readonly label: string;
  /** The episode's own title as the page states it, `null` for a film or none. */
  readonly episodeTitle: string | null;
  readonly progress: { readonly position: number; readonly duration: number } | null;
  /**
   * `not_tracking`: on a tracked site, or a turned-off built-in, something plays and goes
   * nowhere; `reason` says why.
   */
  readonly state: 'tracking' | 'added' | 'not_tracked' | 'blocked' | 'skipped' | 'not_tracking';
  /** Why `not_tracking`; `null` in every other state. */
  readonly reason: IgnoredReason | null;
  /**
   * Why a `tracking` viewing will not be added (the play builder would refuse its reading,
   * `playRefusal`); `null` when it will be, and in every other state.
   */
  readonly problem: 'series_no_episode' | 'no_title' | null;
  /** The viewing *Skip* names; `null` when nothing is bound. */
  readonly viewingId: string | null;
  /**
   * The origin *Track this site* asks for: `PopupState.site.origin` exactly when the site is
   * `trackable`, else `null` (a turned-off built-in or a blocked site gets none).
   */
  readonly origin: string | null;
}

/**
 * The site of the tab the popup opened over, as Chrome names it (`activeTab`): whether it is
 * tracked, and what *Track this site* would ask for.
 */
export interface ActiveSite {
  /** The tab's origin, as `URL.origin` writes it (`https://www.example.com`). */
  readonly origin: string;
  /** The built-in service's name, or the tab's host. */
  readonly name: string;
  /**
   * `tracked`: a built-in service, a site the person allowed, or every site. `trackable`: not
   * tracked, and *Track this site* would change that (an excluded site too: tracking it removes
   * the exclusion). `turned_off`: a built-in service the person turned off in Settings, which
   * *Track this site* does not turn back on. `blocked`: never tracked (the block list).
   */
  readonly tracking: 'tracked' | 'trackable' | 'turned_off' | 'blocked';
  /**
   * The match pattern *Track this site* asks Chrome for (`https://www.example.com/*`; a port is
   * never part of one), exactly when `tracking` is `trackable`; else `null`.
   */
  readonly pattern: string | null;
}

/** What the server last said of the current connection. */
export interface ConnectionCheckView {
  /** The connection's status as the plays route applies it. */
  readonly status: ConnectionStatus;
  /** The server's `expires_at` for the stored credential; `null`: the credential has no end. */
  readonly expiresAt: EpochMs | null;
  /** When the server answered. */
  readonly checkedAt: EpochMs;
}

export interface PopupState {
  readonly connection: ConnectionState;
  readonly nowPlaying: NowPlaying | null;
  /** Questions the server asks the person (`needs_confirmation` plays), newest first. */
  readonly waiting: readonly WaitingRow[];
  /** The last ten plays: sent, waiting to be sent, or not sendable. */
  readonly recent: readonly HistoryEntryView[];
  /**
   * Plays and starts not sent yet that can still go (waiting or paused, not given up on): what a
   * disconnect offers to send first.
   */
  readonly unsent: number;
  readonly pausedUntil: EpochMs | null;
  /**
   * The site of the tab the popup opened over; `null` for a page in a tab of its own, a tab that
   * is not an `http(s)` page, or one whose address Chrome does not show.
   */
  readonly site: ActiveSite | null;
  /**
   * The server's last answer for the current connection; `null` until it answered for this one.
   * A `401` is not here: it is `connection: broken (credential_invalid)`.
   */
  readonly connectionCheck: ConnectionCheckView | null;
  /**
   * The account's rule for the current connection, as the last check read it; off without one.
   * Shown read-only: only a signed-in person changes it, in the app.
   */
  readonly accountRule: AccountRule;
}

export interface UiResponseMessage {
  readonly v: typeof PROTOCOL_VERSION;
  readonly type: 'ui/response';
  readonly id: number;
  readonly response: UiResponse;
}

interface UiStateMessage {
  readonly v: typeof PROTOCOL_VERSION;
  readonly type: 'ui/state';
  readonly state: PopupState;
}

export type UiPush = UiResponseMessage | UiStateMessage;
