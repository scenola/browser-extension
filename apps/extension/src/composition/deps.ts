/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the composition root is built from: core's ports, the app's own (./ports.ts), and their
// Chrome implementations. background.ts hands the root the real ones, a test its fakes; every
// module of the root reads the ports it needs from here.

import type {
  AccountData,
  AuthStrategy,
  Clock,
  ConnectionGateway,
  ConnectionRepo,
  Ids,
  Interpreter,
  Outbox,
  PlayHistory,
  PlaysGateway,
  Random,
  StatusDisplay,
  ViewingStore,
} from '@mt/core';

import type { DiagnosticsLog } from '../platform/diagnostics';
import type { SitePermissions } from '../platform/site-permissions';
import type {
  AccountRuleStore,
  AppScheduler,
  AppSettings,
  BootstrapInjector,
  CollectorInjector,
  ConnectionCheckStore,
  PageStateReader,
  TabsInfo,
} from './ports';

export interface PlatformDeps {
  readonly clock: Clock;
  readonly ids: Ids;
  readonly random: Random;
  readonly viewings: ViewingStore;
  readonly outbox: Outbox;
  readonly history: PlayHistory;
  readonly connection: ConnectionRepo;
  /** What the connection left here, which a disconnect removes. */
  readonly account: AccountData;
  readonly scheduler: AppScheduler;
  readonly status: StatusDisplay;
  readonly settings: AppSettings;
  readonly permissions: SitePermissions;
  readonly interpreter: Interpreter;
  readonly gateway: PlaysGateway;
  /** `GET /v1/integrations/connection`, with the plays' credential. */
  readonly connectionGateway: ConnectionGateway;
  /** The last connection check, kept for the browser session. */
  readonly connectionChecks: ConnectionCheckStore;
  /** The account's rule the last check read, kept across browser restarts. */
  readonly accountRules: AccountRuleStore;
  readonly strategies: readonly AuthStrategy[];
  readonly pageState: PageStateReader;
  readonly injector: CollectorInjector;
  readonly bootstrap: BootstrapInjector;
  readonly tabs: TabsInfo;
  readonly diagnostics: DiagnosticsLog;
  /** Removes every record of the extension's database (*Clear all local data*). */
  readonly wipe: () => Promise<void>;
  /** `runtime.id`: the only sender a content message is accepted from. */
  readonly extensionId: string;
  /** `WEB_APP_BASE_URL`: the links the popup shows are built on it. */
  readonly webAppBaseUrl: string;
  readonly buildMode: string;
}
