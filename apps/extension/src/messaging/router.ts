/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The worker's two doors: `runtime.onMessage` for content scripts and the `ui` port for the
// extension's own pages. The router only carries: it hands each message to the root with
// what Chrome says of its sender, posts the answer back, and pushes `ui/state` to every open page
// when the root says something changed. A message for another protocol (the offscreen
// document's) is left to its own listener.

import type { Browser } from 'wxt/browser';

import type { Root } from '../composition/root';
import { PROTOCOL_VERSION, UI_PORT_NAME, isContentMessageType } from './protocol';
import type { UiPush } from './protocol';

/** Pushes to one page are gathered over this long, so a burst of changes is one push. */
const PUSH_DEBOUNCE_MS = 150;

type Runtime = Pick<typeof Browser.runtime, 'onMessage' | 'onConnect' | 'id'>;

/** A port from one of this extension's own pages — never a content script, never a page. */
function fromOwnPage(port: Browser.runtime.Port, runtime: Runtime, origin: string): boolean {
  const sender = port.sender;
  if (sender?.id !== runtime.id) return false;
  const url = sender.url;
  return typeof url === 'string' && url.startsWith(`${origin}/`);
}

/** `extensionOrigin` is the worker's own (`chrome-extension://<id>`): the pages' origin. */
export function startRouter(root: Root, runtime: Runtime, extensionOrigin: string): void {
  runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (!isContentMessageType(raw)) return false;
    root.onContentMessage(raw, sender).then(
      (answer) => {
        sendResponse(answer);
      },
      () => {
        sendResponse(undefined);
      },
    );
    return true;
  });

  runtime.onConnect.addListener((port) => {
    if (port.name !== UI_PORT_NAME || !fromOwnPage(port, runtime, extensionOrigin)) {
      port.disconnect();
      return;
    }
    let open = true;
    const post = (message: UiPush): void => {
      if (!open) return;
      try {
        port.postMessage(message);
      } catch {
        open = false;
      }
    };
    // The popup shows the tab it opened over; a page open in a tab of its own shows none.
    const tabId: Promise<number | null> =
      port.sender?.tab === undefined ? root.activeTab() : Promise.resolve(null);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = (): void => {
      if (!open || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void tabId
          .then((id) => root.uiState(id))
          .then((state) => {
            post({ v: PROTOCOL_VERSION, type: 'ui/state', state });
          })
          .catch(() => undefined);
      }, PUSH_DEBOUNCE_MS);
    };
    const unsubscribe = root.subscribe(push);

    port.onMessage.addListener((raw: unknown) => {
      void root
        .onUiRequest(raw)
        .then((answer) => {
          if (answer !== null) post(answer);
        })
        .catch(() => undefined);
    });
    port.onDisconnect.addListener(() => {
      open = false;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    });

    push();
    void root.onUiOpened().catch(() => undefined);
  });
}
