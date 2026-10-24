/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The service worker: it builds the Chrome implementations of the ports, hands them
// to the composition root, and wires Chrome's events to it — every listener registered
// synchronously, as MV3 requires, so an event that woke the worker is never missed. Nothing
// else lives here.

import { createPlaysGateway } from '@mt/api';
import type { AuthStrategy } from '@mt/core';
import type { BackgroundDefinition } from 'wxt';
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';

import { createRoot } from '../composition/root';
import { API_BASE_URL, AUTH_STRATEGIES, TEST_APPROVE_URL, WEB_APP_BASE_URL } from '../config';
import { startRouter } from '../messaging/router';
import {
  ChromePkceDpopAuth,
  SessionFlowStore,
  discardInterruptedSignIn,
} from '../platform/auth-chrome';
import type { PkceDpopDeps } from '../platform/auth-chrome';
import { PersonalTokenAuth } from '../platform/auth-personal-token';
import { TestAuth } from '../platform/auth-test';
import { LocalAccountRuleStore } from '../platform/account-rule-store';
import { cryptoIds, jitter, systemClock } from '../platform/clock';
import { SessionConnectionCheckStore } from '../platform/connection-check-store';
import { IdbConnectionRepo } from '../platform/connection-store';
import { IdbDiagnostics } from '../platform/diagnostics';
import { IdbPlayHistory } from '../platform/history-store';
import { IdbAccountData, sharedDatabase, wipeDatabase } from '../platform/idb';
import {
  ScriptingBootstrapInjector,
  ScriptingCollectorInjector,
  ScriptingPageStateReader,
} from '../platform/injection';
import { OFFSCREEN_PAGE, OffscreenInterpreter } from '../platform/interpreter';
import { SessionNonceStore } from '../platform/nonce-store';
import { IdbOutbox } from '../platform/outbox-store';
import { AlarmScheduler } from '../platform/scheduler';
import { ChromeSettings, closeToContentScripts } from '../platform/settings';
import { credentialSigner } from '../platform/signer';
import { ChromeSitePermissions } from '../platform/site-permissions';
import { ActionStatusDisplay } from '../platform/status-display';
import { ChromeTabs } from '../platform/tabs';
import { IdbViewingStore } from '../platform/viewing-store';

const background: BackgroundDefinition = defineBackground(() => {
  const db = sharedDatabase();
  void closeToContentScripts();
  const settings = new ChromeSettings();
  const connection = new IdbConnectionRepo(db);
  const nonces = new SessionNonceStore(browser.storage.session);
  const diagnosticsOn = async (): Promise<boolean> => (await settings.get()).diagnostics;

  const diagnostics = new IdbDiagnostics(db, systemClock, diagnosticsOn);
  // Service modules run in the offscreen document's sandbox, never here.
  const interpreter = new OffscreenInterpreter({
    offscreen: browser.offscreen,
    runtime: browser.runtime,
    offscreenUrl: new URL(`/${OFFSCREEN_PAGE}`, self.location.origin).href,
    onFailure: (serviceId, reason) => {
      void diagnostics.log('interpret.failed', { serviceId, reason });
    },
  });

  // The sign-in strategies this build compiles in. The build-mode comparisons fold
  // at build time, so a store build — `pkce_dpop` alone (config-rules.ts) — carries no code of
  // the other two at all; within a build, `AUTH_STRATEGIES` decides which are offered.
  const auth: PkceDpopDeps = {
    apiBase: API_BASE_URL,
    fetch: globalThis.fetch.bind(globalThis),
    nonces,
    clock: systemClock,
    credentials: connection,
    flows: new SessionFlowStore(browser.storage.session),
    redirectUri: () => browser.identity.getRedirectURL(),
    log: (event, detail) => diagnostics.log(event, detail),
  };
  void discardInterruptedSignIn(auth.flows);
  const strategies: AuthStrategy[] = [];
  if (AUTH_STRATEGIES.includes('pkce_dpop')) {
    strategies.push(
      new ChromePkceDpopAuth({
        ...auth,
        webBase: WEB_APP_BASE_URL,
        identity: browser.identity,
        keepAlive: () => browser.runtime.getPlatformInfo(),
      }),
    );
  }
  if (import.meta.env.MT_BUILD_MODE !== 'store' && AUTH_STRATEGIES.includes('personal_token')) {
    strategies.push(new PersonalTokenAuth(auth));
  }
  if (
    import.meta.env.MT_BUILD_MODE === 'e2e' &&
    TEST_APPROVE_URL !== null &&
    AUTH_STRATEGIES.includes('test')
  ) {
    strategies.push(new TestAuth({ ...auth, approveUrl: TEST_APPROVE_URL }));
  }

  // One gateway for the plays, their receipts and the connection check: one credential,
  // one signer, one nonce.
  const gateway = createPlaysGateway({
    fetch: globalThis.fetch.bind(globalThis),
    apiBase: API_BASE_URL,
    signer: credentialSigner(connection, nonces, systemClock),
  });

  // It sets only what changed; what a tab showed is forgotten when Chrome resets it.
  const status = new ActionStatusDisplay(browser.action);

  const root = createRoot({
    clock: systemClock,
    ids: cryptoIds,
    random: jitter,
    viewings: new IdbViewingStore(db),
    outbox: new IdbOutbox(db),
    history: new IdbPlayHistory(db),
    connection,
    account: new IdbAccountData(db),
    scheduler: new AlarmScheduler(browser.alarms, systemClock),
    status,
    settings,
    permissions: new ChromeSitePermissions(browser.permissions, browser.scripting, settings),
    interpreter,
    gateway,
    connectionGateway: gateway,
    connectionChecks: new SessionConnectionCheckStore(browser.storage.session),
    accountRules: new LocalAccountRuleStore(browser.storage.local),
    strategies,
    pageState: new ScriptingPageStateReader(browser.scripting),
    injector: new ScriptingCollectorInjector(browser.scripting),
    bootstrap: new ScriptingBootstrapInjector(browser.scripting, browser.tabs),
    tabs: new ChromeTabs(browser.tabs),
    diagnostics,
    wipe: () => wipeDatabase(db),
    extensionId: browser.runtime.id,
    webAppBaseUrl: WEB_APP_BASE_URL,
    buildMode: import.meta.env.MT_BUILD_MODE,
  });

  startRouter(root, browser.runtime, self.location.origin);
  browser.alarms.onAlarm.addListener((alarm) => {
    void root.onAlarm(alarm.name);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    status.forget(tabId);
    void root.onTabRemoved(tabId);
  });
  // A tab that loads another page shows Chrome's defaults again (its own icon, badge and title
  // are reset); a same-document navigation keeps them and reports no `loading`.
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status === 'loading') {
      status.forget(tabId);
      root.onTabLoading(tabId);
    } else if (change.status === 'complete' || (change.status === undefined && change.url)) {
      // `tab.url` is there only for a site we have access to: a page we may track is ready now.
      void root.onTabAt(tabId, tab.url, tab.incognito);
    }
  });
  browser.runtime.onStartup.addListener(() => {
    void root.onStartup();
  });
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') void browser.tabs.create({ url: '/welcome.html' });
    void root.onInstalled(details.reason);
  });
  browser.permissions.onAdded.addListener((added) => {
    void root.onPermissionsChanged(added.origins ?? []);
  });
  browser.permissions.onRemoved.addListener(() => {
    void root.onPermissionsChanged([]);
  });
  self.addEventListener('online', () => {
    void root.onOnline();
  });
  void root.onWake();
});

export default background;
