/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The app's own ports: what the composition root needs from the browser beyond core's ports
// (packages/core/src/application/ports.ts). Each is small and role-specific; background.ts hands
// the root its Chrome implementations, a test its fakes.

import type {
  AccountRule,
  ConnectionStatus,
  EpochMs,
  Scheduler,
  Settings,
  SettingsValue,
} from '@mt/core';
import type { StatePath } from '@mt/services';

import type { AppAlarmName } from '../platform/scheduler';

/** Core's scheduler, and the app's own `status` alarm (a timed pause ending). */
export interface AppScheduler extends Scheduler {
  at(name: AppAlarmName, when: number): Promise<void>;
  clear(name: AppAlarmName): Promise<void>;
}

/** Core's settings, and the reset *Clear all local data* needs. */
export interface AppSettings extends Settings {
  get(): Promise<SettingsValue>;
  reset(): Promise<void>;
}

/** One frame of a tab and, when Chrome named it, the document it holds (`sender.documentId`). */
export interface FrameTarget {
  readonly tabId: number;
  readonly frameId: number;
  /** Targets exactly that document: a frame that has since loaded another is not touched. */
  readonly documentId: string | null;
}

/**
 * Injects the collector into one frame of a tab, after the bootstrap's first `play`: `true` when
 * it was injected. A frame that already runs one is not given a second (the collector refuses
 * it, and reports at once instead).
 */
export interface CollectorInjector {
  inject(target: FrameTarget): Promise<boolean>;
}

/** One frame of an open tab, with its document's origin (`null`: an opaque one, a sandbox). */
export interface OpenFrame {
  readonly frameId: number;
  readonly documentId: string | null;
  readonly origin: string | null;
}

/**
 * Puts the bootstrap into tabs that were open before it could run there: Chrome leaves a
 * reloaded or updated extension's manifest scripts in open tabs cut off from the new worker, and
 * runs a newly registered script only in pages loaded after it.
 */
export interface BootstrapInjector {
  /** The open tabs whose URL this extension may see; with `patterns`, those matching one. */
  openTabs(
    patterns?: readonly string[],
  ): Promise<readonly { readonly tabId: number; readonly url: string }[]>;
  /** The frames of a tab this extension may script, each with its origin; `[]` when none. */
  framesOf(tabId: number): Promise<readonly OpenFrame[]>;
  /** Runs the bootstrap in one frame's document: `true` when it ran. */
  inject(target: FrameTarget): Promise<boolean>;
}

/**
 * Reads a module's declared page state in a frame's MAIN world: each named path walked by our
 * reader, calls only from `allowedCalls`, keys from `routeGroups` (the capture groups of the
 * player route the frame's pathname matched, index 0 the whole match), the results bounded
 * JSON. An entry it could not read, or that read as nothing, is absent.
 */
export interface PageStateReader {
  read(
    target: FrameTarget,
    paths: Readonly<Record<string, StatePath>>,
    allowedCalls: readonly string[],
    routeGroups: readonly (string | null)[],
  ): Promise<Readonly<Record<string, unknown>>>;
}

/** What the root may know of a tab without the `tabs` permission. */
export interface TabsInfo {
  /** The tab the popup opened over: the active tab of the last focused window. */
  active(): Promise<number | null>;
  /**
   * The tab: its URL, when this extension may see it — a site it has access to, or the tab the
   * popup was opened over while it is up (`activeTab`), else `null` — and whether it is audible
   * and incognito (no permission needed for either); `null` for no such tab.
   */
  get(tabId: number): Promise<TabFacts | null>;
}

export interface TabFacts {
  readonly url: string | null;
  readonly audible: boolean;
  readonly incognito: boolean;
}

/** What the server answered the connection check, as it is kept. */
export interface ConnectionCheckAnswer {
  readonly status: ConnectionStatus;
  /** The server's `expires_at`; `null`: the credential has no end. */
  readonly expiresAt: EpochMs | null;
  /** When it answered. */
  readonly checkedAt: EpochMs;
}

/** The last connection check: which connection asked, when, and what came back. */
export interface ConnectionCheckRecord {
  /** The connection that asked (`ConnectionState.id`): a record of another one means nothing. */
  readonly connectionId: string;
  /** When it last asked, answered or not: the once-a-minute bound counts from here. */
  readonly askedAt: EpochMs;
  /** The server's last answer for that connection; `null` until it gave one. */
  readonly answer: ConnectionCheckAnswer | null;
}

/**
 * Where the last connection check is kept for the browser session (`storage.session`), so a
 * worker that restarts within the minute does not ask again. A value that is not a record reads
 * as none.
 */
export interface ConnectionCheckStore {
  get(): Promise<ConnectionCheckRecord | null>;
  /** `null` forgets it (a disconnect, *Clear all local data*). */
  set(record: ConnectionCheckRecord | null): Promise<void>;
}

/** The account's rule as the last connection check read it, and which connection asked. */
export interface AccountRuleRecord {
  /** The connection that read it: a record of another one is no rule, so a reconnect forgets it. */
  readonly connectionId: string;
  readonly rule: AccountRule;
}

/**
 * Where the last rule read is kept across browser restarts, so a browser started offline still
 * has it. A value that is not a record reads as none.
 */
export interface AccountRuleStore {
  get(): Promise<AccountRuleRecord | null>;
  /** `null` forgets it (a disconnect, *Clear all local data*). */
  set(record: AccountRuleRecord | null): Promise<void>;
}
