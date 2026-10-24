/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// The bootstrap and its re-injection: the worker injects it again into the open tabs of a
// tracked site on install, update and grant, because Chrome leaves a reloaded extension's
// manifest scripts orphaned in open tabs. Injected into a frame whose bootstrap still reaches
// the worker, it adds nothing; one left by a reloaded extension (its runtime gone) is replaced.
// One `play` asks once; a video already playing when it is injected asks at once.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import bootstrap from '../entrypoints/bootstrap';
import { addVideo, setVideo } from '../testing/video';
import { rearmBootstrap, setBootstrapArm } from './slots';

let asked: unknown[] = [];

/** A frame no bootstrap has run in yet. */
function freshFrame(): void {
  Reflect.deleteProperty(globalThis, Symbol.for('mediatracker.bootstrap'));
  Reflect.deleteProperty(globalThis, Symbol.for('mediatracker.bootstrap-alive'));
}

beforeEach(() => {
  asked = [];
  freshFrame();
  fakeBrowser.runtime.onMessage.addListener((...args: unknown[]) => {
    const [message, , sendResponse] = args as [unknown, unknown, (reply: unknown) => void];
    asked.push(message);
    sendResponse({ inject: false });
    return true;
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

/** Runs the script, as the manifest entry or `scripting.executeScript` does. */
function inject(): void {
  (bootstrap as unknown as { main: () => void }).main();
}

/** A `<video>` of the page starts playing. */
async function play(): Promise<void> {
  const video = document.createElement('video');
  document.body.append(video);
  video.dispatchEvent(new Event('play'));
  await vi.waitFor(() => {
    expect(asked.length).toBeGreaterThan(0);
  });
}

const plays = (): number =>
  asked.filter((m) => (m as { type?: unknown }).type === 'bootstrap/play').length;

test('injected into a frame whose bootstrap is live, it adds nothing: one play asks once', async () => {
  inject();
  inject();
  await play();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(plays()).toBe(1);
});

test('a bootstrap a reloaded extension left behind is replaced: the play asks', async () => {
  // The orphan's runtime is gone (`runtime.id` undefined in its own world): it can ask nothing.
  setBootstrapArm(
    () => undefined,
    () => false,
  );
  inject();
  await play();
  expect(plays()).toBe(1);
});

test('a bootstrap of an older build (no liveness of its own) is replaced too', async () => {
  setBootstrapArm(() => undefined);
  inject();
  await play();
  expect(plays()).toBe(1);
});

// *Track this site* while the video plays: the worker injects the bootstrap into the tab, and no
// `play` will come.
test('injected where a video already plays, it asks at once, and a later play asks nothing more', async () => {
  addVideo(document, { width: 1280, height: 720, paused: false });
  inject();
  await vi.waitFor(() => {
    expect(plays()).toBe(1);
  });
  document.querySelector('video')?.dispatchEvent(new Event('play'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(plays()).toBe(1);
});

test('a paused or ended video, or a page out of view, waits for its play', async () => {
  const video = addVideo(document, { width: 1280, height: 720, paused: true });
  inject();
  freshFrame();
  setVideo(video, { paused: false, ended: true });
  inject();
  freshFrame();
  setVideo(video, { ended: false });
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  try {
    inject();
  } finally {
    Reflect.deleteProperty(document, 'visibilityState');
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(plays()).toBe(0);
  // Each of the three is armed, and its play asks.
  video.dispatchEvent(new Event('play'));
  await vi.waitFor(() => {
    expect(plays()).toBe(3);
  });
});

// A collector that stops re-arms the bootstrap; the video may still be playing (its page
// hidden, say). Asking then would bring back a collector that just stopped.
test('re-armed by a collector, it waits for a play even while a video plays', async () => {
  inject();
  await play();
  const video = addVideo(document, { width: 1280, height: 720, paused: false });
  rearmBootstrap();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(plays()).toBe(1);
  video.dispatchEvent(new Event('play'));
  await vi.waitFor(() => {
    expect(plays()).toBe(2);
  });
});
