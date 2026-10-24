/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// The collector's lifecycle: it stops and removes every listener (one AbortController) on
// pagehide, when the worker answers { stop: true }, or when the elected video is gone for 30 s
// (it sends collector/gone). A second injection adds no listeners; a top frame without a video
// sends snapshot-only reports, since the worker's frame table forgets a frame silent for 30 s.
// It samples every 15 s.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import collector from '../entrypoints/collector';
import { addVideo, setVideo, setViewport } from '../testing/video';
import { runningCollector } from './slots';

interface Added {
  readonly target: string;
  readonly type: string;
  readonly signal: AbortSignal | undefined;
}

let added: Added[] = [];
let sent: Record<string, unknown>[] = [];
let answer: unknown = { stop: false };

function track(target: EventTarget, name: string): void {
  const original = target.addEventListener.bind(target);
  vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
    const signal = typeof options === 'object' ? options.signal : undefined;
    added.push({ target: name, type, signal });
    original(type, listener, options);
  });
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(Date.UTC(2026, 9, 20, 19, 40));
  setViewport(window, 1920, 1080);
  added = [];
  sent = [];
  answer = { stop: false };
  // The worker: the fake browser's `sendMessage` hands each message to `onMessage`.
  fakeBrowser.runtime.onMessage.addListener((...args: unknown[]) => {
    const [message, , sendResponse] = args as [unknown, unknown, (reply: unknown) => void];
    sent.push(message as Record<string, unknown>);
    sendResponse(answer);
    return true;
  });
  track(document, 'document');
  track(window, 'window');
});

afterEach(() => {
  runningCollector()?.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

/** Runs the injected script, as `scripting.executeScript({ files: ["collector.js"] })` does. */
function inject(): void {
  (collector as unknown as { main: () => void }).main();
}

const reports = () => sent.filter((m) => m.type === 'collector/report');

/** Every listener the collector added is gone: its signal was aborted. */
function everyListenerRemoved(): boolean {
  return added.length > 0 && added.every((a) => a.signal?.aborted === true);
}

async function flush(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function playingFilm(): HTMLVideoElement {
  return addVideo(document, {
    width: 1280,
    height: 720,
    paused: false,
    duration: 2_880,
    currentTime: 100,
  });
}

describe('the collector', () => {
  // Double injection adds no listeners (the worker's memory of injected frames is lost on a
  // restart, so a frame can be injected twice): one AbortController.
  test('a second injection adds no listeners, and reports at once', async () => {
    playingFilm();
    inject();
    await flush(0);
    const listeners = added.length;
    const before = reports().length;
    expect(listeners).toBeGreaterThan(0);
    inject();
    await flush(0);
    expect(added.length).toBe(listeners);
    expect(reports().length).toBeGreaterThan(before);
  });

  test('pagehide removes every listener and stops reporting', async () => {
    const film = playingFilm();
    inject();
    await flush(0);
    window.dispatchEvent(new Event('pagehide'));
    await flush(0);
    expect(everyListenerRemoved()).toBe(true);
    const count = sent.length;
    film.dispatchEvent(new Event('pause'));
    await flush(60_000);
    expect(sent.length).toBe(count);
  });

  test('{ stop: true } removes every listener and stops reporting', async () => {
    answer = { stop: true };
    const film = playingFilm();
    inject();
    await flush(0);
    expect(everyListenerRemoved()).toBe(true);
    const count = sent.length;
    film.dispatchEvent(new Event('seeked'));
    await flush(60_000);
    expect(sent.length).toBe(count);
  });

  // Only `{ stop: true }` stops it.
  test('an answer that is not { stop: true } does not stop it', async () => {
    answer = undefined;
    playingFilm();
    inject();
    await flush(0);
    expect(added.some((a) => a.signal?.aborted !== true)).toBe(true);
    const count = reports().length;
    await flush(16_000);
    expect(reports().length).toBeGreaterThan(count);
  });

  test('30 s without its video, it says collector/gone and removes every listener', async () => {
    const film = playingFilm();
    inject();
    await flush(5_000);
    film.remove();
    await flush(36_000);
    expect(sent.some((m) => m.type === 'collector/gone')).toBe(true);
    expect(everyListenerRemoved()).toBe(true);
  });

  // A video still there for 30 s does not end the collector.
  test('a video that stays keeps the collector', async () => {
    playingFilm();
    inject();
    await flush(45_000);
    expect(sent.some((m) => m.type === 'collector/gone')).toBe(false);
    expect(everyListenerRemoved()).toBe(false);
  });

  // Identity comes from the top frame, and the worker drops frames silent for 30 s: so the top
  // frame without a video keeps sending its snapshot, sample-less
  test('the top frame without a video sends snapshot-only reports, past 30 s too', async () => {
    document.title = 'Arrival';
    inject();
    await flush(0);
    expect(reports().length).toBeGreaterThan(0);
    for (const r of reports()) {
      expect(r.sample).toBeNull();
      expect(r.snapshot).not.toBeNull();
    }
    const early = reports().length;
    await flush(46_000);
    expect(reports().length).toBeGreaterThan(early);
    expect(sent.some((m) => m.type === 'collector/gone')).toBe(false);
    for (const r of reports()) expect(r.sample).toBeNull();
  });

  // A sample every 15 s while playing (4 in 60 s, give or take the edges).
  test('while playing, a sample roughly every 15 s', async () => {
    const film = playingFilm();
    inject();
    await flush(0);
    const start = reports().filter((r) => r.sample !== null).length;
    for (let s = 0; s < 60; s += 1) {
      setVideo(film, { currentTime: 100 + s });
      await flush(1_000);
    }
    const samples = reports().filter((r) => r.sample !== null).length - start;
    expect(samples).toBeGreaterThanOrEqual(3);
    expect(samples).toBeLessThanOrEqual(6);
  });

  // A sample on pause (a media event).
  test('pause is sampled at once', async () => {
    const film = playingFilm();
    inject();
    await flush(2_000);
    const count = reports().length;
    setVideo(film, { paused: true });
    film.dispatchEvent(new Event('pause'));
    await flush(1_100);
    const last = reports().at(-1);
    expect(reports().length).toBeGreaterThan(count);
    expect((last?.sample as { paused?: boolean } | null)?.paused).toBe(true);
  });
});
