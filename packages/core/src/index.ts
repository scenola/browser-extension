/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { DAY_MS, HOUR_MS, MAX_DATE_MS, MINUTE_MS } from './domain/time';
export type { EpochMs } from './domain/time';
export { advance } from './domain/coverage';
export type { PlaybackSample } from './domain/coverage';
export {
  IDENTITY_FIELDS,
  MAX_MARKER_SECONDS,
  READING_SOURCES,
  identityOf,
  titleKey,
  titleProviderId,
} from './domain/reading';
export type { Field, MergedReading, ServiceReading, ViewingKey } from './domain/reading';
export { PART_READ_BY, SNAPSHOT_PARTS } from './domain/snapshot';
export type { Snapshot, SnapshotPart } from './domain/snapshot';
export { REMOVED_KINDS, sanitizeCapture, sanitizeSnapshot } from './domain/sanitize';
export type { Removed, RemovedKind } from './domain/sanitize';
export { MIN_CONTENT_SECONDS, newViewing, reportVerdict, shareLine } from './domain/viewing';
export type { Story, Viewing } from './domain/viewing';
export { uuidv7 } from './domain/ids';
export { normalizeTitle } from './domain/titles';
export { parseEpisodeLabel, parseEpisodeOnlyLabel } from './domain/labels';
export { readGeneric } from './domain/generic-readers';
export { ADDRESS_QUERY_PARAMS } from './domain/generic-readers/address';
export { cutJsonLd } from './domain/generic-readers/json-ld';
export { OPEN_GRAPH_PROPERTIES } from './domain/generic-readers/open-graph';
export { entryVerdict } from './domain/entry-rule';
export type { EntryVerdict } from './domain/entry-rule';
export { BLOCKED_HOST_SUFFIXES, BLOCKED_TLD_FORMS, isBlockedHost } from './domain/blocked-sites';
export {
  EPISODE_NUMBER_MAX,
  MAX_BODY_BYTES,
  MAX_SECONDS,
  SEASON_NUMBER_MAX,
  MAX_PROVIDER_ENTRIES,
  MAX_TITLE_CODE_POINTS,
  buildPlay,
  clampTitle,
  isImdbId,
  isProviderKey,
  isProviderNamespace,
  isProviderValue,
  isStart,
  isYear,
  playLabel,
  playRefusal,
} from './domain/play';
export {
  DEFAULT_FINISH_THRESHOLD_PERCENT,
  DEFAULT_RULE,
  readAccountRule,
} from './domain/account-rule';
export type { AccountRule } from './domain/account-rule';
export { IGNORED_REASONS, ignoredOf } from './domain/ignored';
export type { IgnoredReason } from './domain/ignored';
export type { PlayBody, ProviderEntry, StartBody, ViewingBody } from './domain/play';
export type { MessageKey } from './domain/messages';
export { sentPlayView } from './domain/receipts';
export type { ReceiptState, ReceiptView } from './domain/receipts';
export { expiringSoon, slideExpiry } from './domain/connection';
export type { ConnectionState } from './domain/connection';
export { computeStatus } from './domain/status';
export type { NotTracked, Status, StatusInputs } from './domain/status';
export { electFrame } from './domain/frames';
export type { FrameReport } from './domain/frames';
export {
  DEFAULT_SETTINGS,
  HISTORY_DAYS,
  PAUSE_INDEFINITELY,
  isHistoryDays,
  isIndefinitePause,
  isPaused,
} from './domain/settings';
export type { HistoryDays, SettingsValue } from './domain/settings';
export { OUTBOX_SLOW_RETRY_MS, notCounted } from './domain/outbox';
export type { OutboxEntry, SendResult } from './domain/outbox';
export { isReceiptSettled } from './domain/receipt-schedule';

export type {
  AccountData,
  AccountKey,
  AccountKnown,
  AlarmName,
  AuthStrategy,
  Clock,
  ConnectResult,
  ConnectionCheckResult,
  ConnectionGateway,
  ConnectionRepo,
  ConnectionStatus,
  Diagnostics,
  HistoryEntry,
  Ids,
  Interpreter,
  Outbox,
  PlayHistory,
  PlaysGateway,
  Random,
  ReceiptResult,
  Scheduler,
  Settings,
  StatusDisplay,
  TabState,
  ViewingStore,
} from './application/ports';
export { IngestObservation } from './application/ingest-observation';
export { ViewingLock } from './application/viewing-lock';
export { ReportViewing } from './application/report-viewing';
export { SkipViewing } from './application/skip-viewing';
export { ClearHistory } from './application/clear-history';
export { PauseTracking } from './application/pause-tracking';
export { DrainOutbox } from './application/drain-outbox';
export { RefreshReceipts } from './application/refresh-receipts';
export { Connect } from './application/connect';
export { credentialRefused } from './application/credential-refused';
export { Disconnect, SEND_FIRST_WAIT_MS } from './application/disconnect';
export { ConfirmAccount, keyOf } from './application/confirm-account';
export type { Confirmed } from './application/confirm-account';
export type { Disconnected } from './application/disconnect';
export {
  DIAGNOSTICS_MAX_ENTRIES,
  EXPIRE_INTERVAL_MS,
  ExpireStale,
} from './application/expire-stale';
