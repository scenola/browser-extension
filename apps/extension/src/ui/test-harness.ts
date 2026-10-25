/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Test infrastructure for the pages' tests, imported by tests only. Two ways to hand a page its
// `UiConnection`:
//
//   - `fakeUi(state)`: a fixture `PopupState` and a recorder of the requests the page sends;
//   - `rootUi(...)`: the worker's real composition root over in-memory ports, so what the page
//     shows is what the root built from stored data (the waiting link, *What was sent*, the
//     export), not what a fixture says it would build.
//
// And `axe(element)`, the accessibility audit every page's test runs.

import {
  FakeClock,
  FakeInterpreter,
  FakePlaysGateway,
  FakeScheduler,
  InMemoryAccountData,
  InMemoryConnectionRepo,
  InMemoryOutbox,
  InMemoryPlayHistory,
  InMemorySettings,
  InMemoryViewingStore,
  RecordingStatusDisplay,
  SequentialIds,
} from '@mt/core/testing';
import { DEFAULT_SETTINGS } from '@mt/core';
import type {
  AccountData,
  ConnectionRepo,
  ConnectionState,
  HistoryEntry,
  OutboxEntry,
} from '@mt/core';
import { signal } from '@preact/signals';
import axeCore from 'axe-core';
import type { AxeResults } from 'axe-core';

import { createRoot } from '../composition/root';
import type { PlatformDeps, Root } from '../composition/root';
import { WEB_APP_BASE_URL } from '../config';
import { PROTOCOL_VERSION } from '../messaging/protocol';
import type { PopupState, UiResponse } from '../messaging/protocol';
import type { DiagnosticsLog } from '../platform/diagnostics';
import type { SitePermissions } from '../platform/site-permissions';
import type { UiAsk, UiConnection } from './store';

const DAY = 24 * 3600 * 1000;

/**
 * axe-core's audit of a rendered element, with its default rules. The element must be in the
 * document, as a rendered page's container is.
 */
export function axe(element: Element): Promise<AxeResults> {
  return axeCore.run(element);
}

/** A connection made yesterday, far from its expiry (no "reconnect soon" notice). */
export function connectedState(now: number): Extract<ConnectionState, { kind: 'connected' }> {
  return {
    kind: 'connected',
    id: '01929a4e-0000-7000-8000-000000000001',
    strategy: 'pkce_dpop',
    connectedAt: now - DAY,
    expiresAt: now + 80 * DAY,
  };
}

export interface FakeUi {
  readonly ui: UiConnection;
  readonly sent: UiAsk[];
}

/** A page's connection over a fixture state; every request is recorded and answered. */
export function fakeUi(
  state: PopupState | null,
  answer: (ask: UiAsk) => UiResponse | Promise<UiResponse> = () => ({ ok: true }),
): FakeUi {
  const sent: UiAsk[] = [];
  return {
    sent,
    ui: {
      state: signal(state),
      live: signal(true),
      send: (ask) => {
        sent.push(ask);
        return Promise.resolve(answer(ask));
      },
    },
  };
}

export interface RootUi {
  readonly root: Root;
  readonly deps: PlatformDeps;
  readonly ui: UiConnection;
  readonly sent: UiAsk[];
  /** Pushes the root's current state to the page, as the worker does after a change. */
  refresh(): Promise<void>;
}

class Permissions implements SitePermissions {
  forgetAllSites(): Promise<void> {
    return Promise.resolve();
  }
  has(): Promise<boolean> {
    return Promise.resolve(true);
  }
  hasAllSites(): Promise<boolean> {
    return Promise.resolve(false);
  }
  forget(): Promise<void> {
    return Promise.resolve();
  }
  forgetAll(): Promise<void> {
    return Promise.resolve();
  }
  reconcile(): Promise<void> {
    return Promise.resolve();
  }
}

const silentLog: DiagnosticsLog = {
  log: () => Promise.resolve(),
  list: () => Promise.resolve([]),
  clear: () => Promise.resolve(),
  prune: () => Promise.resolve(),
};

export interface RootSeed {
  readonly now: number;
  readonly connection?: ConnectionRepo;
  /** What the connection left; over the in-memory stores unless `connection` is a stored one. */
  readonly account?: AccountData;
  readonly history?: readonly HistoryEntry[];
  readonly outbox?: readonly OutboxEntry[];
  readonly tabId?: number | null;
}

/** The worker's composition root over in-memory ports, and a page's connection to it. */
export async function rootUi(seed: RootSeed): Promise<RootUi> {
  const clock = new FakeClock(seed.now);
  const history = new InMemoryPlayHistory();
  for (const entry of seed.history ?? []) await history.put(entry);
  const outbox = new InMemoryOutbox();
  for (const entry of seed.outbox ?? []) await outbox.add(entry);
  const settings = new InMemorySettings();
  const viewings = new InMemoryViewingStore();
  const connection = seed.connection ?? new InMemoryConnectionRepo(connectedState(seed.now));
  const account =
    seed.account ??
    (connection instanceof InMemoryConnectionRepo
      ? new InMemoryAccountData({ connection, outbox, history, viewings })
      : null);
  if (account === null) throw new Error('a stored connection needs its account data');
  const deps: PlatformDeps = {
    clock,
    ids: new SequentialIds(),
    random: () => 0.5,
    viewings,
    outbox,
    history,
    connection,
    account,
    scheduler: new FakeScheduler(clock),
    status: new RecordingStatusDisplay(),
    settings: Object.assign(settings, {
      reset: async () => {
        await settings.patch(DEFAULT_SETTINGS);
      },
    }),
    permissions: new Permissions(),
    interpreter: new FakeInterpreter(() => null),
    gateway: new FakePlaysGateway(),
    connectionGateway: { check: () => Promise.resolve({ kind: 'unavailable', detail: 'harness' }) },
    connectionChecks: { get: () => Promise.resolve(null), set: () => Promise.resolve() },
    accountRules: { get: () => Promise.resolve(null), set: () => Promise.resolve() },
    strategies: [],
    pageState: { read: () => Promise.resolve({}) },
    injector: { inject: () => Promise.resolve(false) },
    bootstrap: {
      openTabs: () => Promise.resolve([]),
      framesOf: () => Promise.resolve([]),
      inject: () => Promise.resolve(false),
    },
    tabs: { active: () => Promise.resolve(null), get: () => Promise.resolve(null) },
    diagnostics: silentLog,
    wipe: () => Promise.resolve(),
    extensionId: 'test-extension-id',
    webAppBaseUrl: WEB_APP_BASE_URL,
    buildMode: import.meta.env.MT_BUILD_MODE,
  };
  const root = createRoot(deps);
  const tabId = seed.tabId ?? null;
  const state = signal<PopupState | null>(await root.uiState(tabId));
  const sent: UiAsk[] = [];
  let nextId = 1;
  const ui: UiConnection = {
    state,
    live: signal(true),
    send: async (ask) => {
      sent.push(ask);
      const id = nextId;
      nextId += 1;
      const answer = await root.onUiRequest({ ...ask, v: PROTOCOL_VERSION, id });
      return answer?.response ?? { ok: false, error: 'no_answer' };
    },
  };
  return {
    root,
    deps,
    ui,
    sent,
    refresh: async () => {
      state.value = await root.uiState(tabId);
    },
  };
}
