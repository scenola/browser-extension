/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The bootstrap: the only script on a tracked page until a video plays. It is declared in the
// manifest for every built-in host and registered at run time for the sites the person allowed
// (both in every frame, from document start; build/manifest.ts, platform/site-permissions.ts),
// and it is one capture-phase `play` listener on the document — media events do not bubble, but
// they do pass the document going down. On the first `play` of a `<video>` it asks the worker
// once and removes itself; the worker, when the site is tracked, has injected the collector by
// the time it answers.
//
// Where a site's module says its player sits inside a shadow root (`shadowRootPlayer`), whose
// events never reach the document, it also looks there every 5 s while the page is visible,
// and stops once it found a playing video.
//
// It is an unlisted script with a manifest entry of its own, not a WXT content script: WXT's
// content-script wrapper is over half the 2 KB budget, and announces itself to the page with a
// `postMessage` carrying the extension's id — which pages must never see.
//
// When the collector stops (its video gone, the page hidden), it re-arms this listener through
// the frame's isolated-world slot (collector/slots.ts), so a later `play` asks again.
//
// Chrome does not run a reloaded or updated extension's manifest scripts in tabs already open:
// the old bootstrap stays there, cut off from the new worker. So the worker injects this script
// again into those tabs on install, update and grant. A frame whose bootstrap can still reach the
// worker gets nothing more; one whose bootstrap was cut off gets a new one. Injected so, it can
// find its video already playing — *Track this site* is pressed while it plays — and no `play`
// will come to say so: then it asks at once, if the page is the one in view.

import type { UnlistedScriptDefinition } from 'wxt';
import { browser } from 'wxt/browser';
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';

import { shadowRootsOf } from '../collector/election';
import { liveBootstrap, reachesWorker, setBootstrapArm } from '../collector/slots';
import type { ContentMessage } from '../messaging/protocol';

/** The hosts whose module sets `shadowRootPlayer`, from the registry at build time. */
declare const __MT_SHADOW_ROOT_HOSTS__: readonly string[];

const SHADOW_CHECK_MS = 5000;

const PLAY: ContentMessage = { v: 1, type: 'bootstrap/play' };

function inShadowRootHost(hostname: string): boolean {
  return __MT_SHADOW_ROOT_HOSTS__.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
}

function playingIn(root: ParentNode): boolean {
  for (const video of root.querySelectorAll('video')) {
    if (!video.paused && !video.ended) return true;
  }
  return false;
}

function playingInShadowRoot(): boolean {
  for (const root of shadowRootsOf(document)) {
    if (playingIn(root)) return true;
  }
  return false;
}

const bootstrap: UnlistedScriptDefinition = defineUnlistedScript(() => {
  if (liveBootstrap()) return;
  const shadow = inShadowRootHost(location.hostname);
  let armed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const disarm = (): void => {
    armed = false;
    document.removeEventListener('play', onPlay, true);
    clearInterval(timer);
  };
  const ask = (): void => {
    if (!armed) return;
    disarm();
    try {
      // An answer is the worker's verdict, kept for the document; no answer at all (the worker
      // could not be reached) lets the next `play` ask again.
      browser.runtime.sendMessage(PLAY).catch(() => {
        if (reachesWorker()) arm();
      });
    } catch {
      // Cut off from the worker (the extension was updated): nothing to ask.
    }
  };
  const onPlay = (event: Event): void => {
    if (event.target instanceof HTMLVideoElement) ask();
  };
  const arm = (): void => {
    if (armed) return;
    armed = true;
    document.addEventListener('play', onPlay, true);
    if (shadow) {
      timer = setInterval(() => {
        if (document.visibilityState === 'visible' && playingInShadowRoot()) ask();
      }, SHADOW_CHECK_MS);
    }
  };

  setBootstrapArm(arm, reachesWorker);
  arm();
  // Only here, as the script starts: re-armed by a collector that stopped, it waits for a `play`,
  // or a video still playing would have it ask again for a collector that just stopped.
  if (
    document.visibilityState === 'visible' &&
    (playingIn(document) || (shadow && playingInShadowRoot()))
  ) {
    ask();
  }
});

export default bootstrap;
