/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A page's line to the worker: one `runtime.connect({ name: "ui" })` port, over which
// requests go and `ui/response` answers and `ui/state` pushes come back, so the page renders live
// without polling. The worker can stop at any moment (MV3); its port then disconnects, every
// request still waiting is answered `disconnected`, and the port is opened again — which starts
// the worker — so a page left open keeps showing what is true.

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import { browser } from 'wxt/browser';
import type { Browser } from 'wxt/browser';

import { PROTOCOL_VERSION, UI_PORT_NAME } from '../messaging/constants';
import type { PopupState, UiRequest, UiResponse } from '../messaging/protocol';
import { isRecord } from '../values';

/** A request as a page writes it: the version and the correlation id are the store's. */
type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type UiAsk = Without<UiRequest, 'v' | 'id'>;

export interface UiConnection {
  /** The worker's latest `ui/state`; `null` until the first one arrives. */
  readonly state: Signal<PopupState | null>;
  /** Whether a port is open right now (`false` between a worker stop and the reconnect). */
  readonly live: Signal<boolean>;
  /** Sends one request; answers `{ ok: false, error: "disconnected" }` if the worker stopped. */
  send(ask: UiAsk): Promise<UiResponse>;
}

type Runtime = Pick<typeof Browser.runtime, 'connect'> & { readonly id?: string | undefined };

/** The first reconnect waits this long; each next one twice as long, up to the cap. */
const RETRY_FIRST_MS = 100;
const RETRY_MAX_MS = 5_000;
/** At most this many requests wait at once; a page never has more than a few. */
const MAX_PENDING = 64;

const DISCONNECTED: UiResponse = { ok: false, error: 'disconnected' };

/** A push's state, when it has the shape every page reads (the worker is ours; still total). */
function readState(x: unknown): PopupState | null {
  if (!isRecord(x)) return null;
  const { connection, waiting, recent } = x;
  if (!isRecord(connection) || typeof connection.kind !== 'string') return null;
  if (!Array.isArray(waiting) || !Array.isArray(recent)) return null;
  return x as unknown as PopupState;
}

function readResponse(x: unknown): UiResponse | null {
  if (!isRecord(x) || typeof x.ok !== 'boolean') return null;
  if (x.ok) return x as unknown as UiResponse;
  return typeof x.error === 'string' ? { ok: false, error: x.error } : null;
}

/** Opens the page's port and keeps it open for the page's lifetime. */
export function connectUi(runtime: Runtime = browser.runtime): UiConnection {
  const state = signal<PopupState | null>(null);
  const live = signal(false);
  const pending = new Map<number, (response: UiResponse) => void>();
  let port: Browser.runtime.Port | null = null;
  let nextId = 1;
  let retryMs = RETRY_FIRST_MS;

  const settleAll = (): void => {
    for (const resolve of pending.values()) resolve(DISCONNECTED);
    pending.clear();
  };

  const onMessage = (raw: unknown): void => {
    if (!isRecord(raw) || raw.v !== PROTOCOL_VERSION) return;
    if (raw.type === 'ui/state') {
      const next = readState(raw.state);
      if (next !== null) state.value = next;
      retryMs = RETRY_FIRST_MS;
      return;
    }
    if (raw.type === 'ui/response' && typeof raw.id === 'number') {
      const resolve = pending.get(raw.id);
      if (resolve === undefined) return;
      pending.delete(raw.id);
      resolve(readResponse(raw.response) ?? { ok: false, error: 'bad_response' });
    }
  };

  const open = (): void => {
    // A reloaded or removed extension has no id here: nothing will ever answer again.
    if (runtime.id === undefined) return;
    let opened: Browser.runtime.Port;
    try {
      opened = runtime.connect({ name: UI_PORT_NAME });
    } catch {
      retry();
      return;
    }
    port = opened;
    live.value = true;
    opened.onMessage.addListener(onMessage);
    opened.onDisconnect.addListener(() => {
      if (port === opened) port = null;
      live.value = false;
      settleAll();
      retry();
    });
  };

  const retry = (): void => {
    const wait = retryMs;
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    setTimeout(open, wait);
  };

  open();

  return {
    state,
    live,
    send(ask) {
      const current = port;
      if (current === null || pending.size >= MAX_PENDING) return Promise.resolve(DISCONNECTED);
      const id = nextId;
      nextId += 1;
      return new Promise<UiResponse>((resolve) => {
        pending.set(id, resolve);
        try {
          current.postMessage({ ...ask, v: PROTOCOL_VERSION, id });
        } catch {
          pending.delete(id);
          resolve(DISCONNECTED);
        }
      });
    },
  };
}
