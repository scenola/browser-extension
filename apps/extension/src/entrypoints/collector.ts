/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The collector: injected by the worker into a frame after its first `play`
// (`scripting.executeScript`, never a web-accessible resource), it elects the frame's video,
// samples it and builds the frame's snapshot, and sends one `collector/report` per sample.
//
// - Samples: every 15 s while the elected video plays — on the timer, or on `timeupdate` when
//   the timer is held back, its handler doing anything at most every 5 s — and at once on
//   `play`, `pause`, `seeked`, `ended`, `ratechange` and an unmute, a burst of those coalesced
//   to one a second. Nothing is sampled while it is paused: the events say when that ends.
// - Snapshots: every 5 s while it plays, at `play`, and on every new address (navigation.ts).
//   A report carries the snapshot when it changed, or when the last one sent is 15 s old; a
//   snapshot that changed while the video plays (the next episode on the same address) is
//   reported at once. Media events re-run the election at most every 200 ms and rebuild the
//   snapshot at most every second, whatever the page does with its videos.
// - A frame without a video sends snapshot-only reports (`sample: null`): the top frame of a
//   tab whose player is in another frame is where the title is. Such a top frame runs until
//   the worker answers `{ stop: true }`; any other collector stops once it has had no video for
//   30 s, and says so (`collector/gone`).
// - It stops — every listener and timer removed through one `AbortController` — on `pagehide`
//   (after a last report), on `{ stop: true }`, or when the video is gone; it then re-arms the
//   frame's bootstrap, so a later `play` in the same document asks again.
// - A second injection into a frame that has a collector adds nothing: the running one reports
//   at once instead. It is found through a slot of the isolated world, out of the page's reach
//   (collector/slots.ts).
//
// Nothing is logged: no title, no address, no page text.

import type { EpochMs, PlaybackSample, Snapshot } from '@mt/core';
import type { CollectSpec } from '@mt/services';
import type { UnlistedScriptDefinition } from 'wxt';
import { browser } from 'wxt/browser';
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';

import { electVideo, forgetSounded } from '../collector/election';
import { watchNavigation } from '../collector/navigation';
import { sampleOf } from '../collector/sampler';
import {
  clearRunningCollector,
  reachesWorker,
  rearmBootstrap,
  runningCollector,
  setRunningCollector,
} from '../collector/slots';
import type { RunningCollector } from '../collector/slots';
import { buildSnapshot, signalVisible } from '../collector/snapshot';
import type { CollectorReport } from '../messaging/protocol';
import { siteForHostname } from '../sites';

/** The cadence of samples while the video plays. */
const SAMPLE_INTERVAL_MS = 15_000;
/** The cadence of snapshots while it plays (`SNAPSHOT_INTERVAL_MS`); also the collector's tick. */
const SNAPSHOT_INTERVAL_MS = 5_000;
/** `timeupdate` fires several times a second; its handler looks at most this often. */
const TIMEUPDATE_CHECK_MS = 5_000;
/** Media events closer than this are one sample, taken after the burst. */
const EVENT_GAP_MS = 1_000;
/** Media events re-run the election at most this often (a page may toggle its videos at will). */
const ELECTION_GAP_MS = 200;
/** …and rebuild the snapshot at most this often. */
const SNAPSHOT_GAP_MS = 1_000;
/** An unchanged snapshot is sent again this often, so the worker keeps the frame. */
const SNAPSHOT_RESEND_MS = 15_000;
/** A collector without its video for this long stops. */
const GONE_AFTER_MS = 30_000;

/** The protocol's version (messaging/protocol.ts), checked by type; its schemas stay out. */
const VERSION: CollectorReport['v'] = 1;

/** What the collector sends: `collector/report` and `collector/gone` of messaging/protocol.ts. */
type Outgoing =
  | {
      readonly v: typeof VERSION;
      readonly type: CollectorReport['type'];
      readonly isTop: boolean;
      readonly sample: PlaybackSample | null;
      readonly snapshot: Snapshot | null;
    }
  | { readonly v: typeof VERSION; readonly type: 'collector/gone' };

/** The media events that are a sample of their own. */
const SAMPLED_EVENTS = ['play', 'pause', 'seeked', 'ended', 'ratechange', 'volumechange'] as const;
/** Every media event listened for, on the document and on a player's shadow root alike. */
const MEDIA_EVENTS = [...SAMPLED_EVENTS, 'timeupdate', 'emptied'] as const;
/** Events after which the election may have another answer. */
const ELECTION_EVENTS: ReadonlySet<string> = new Set(['play', 'pause', 'ended', 'emptied']);

/** The worker's answer to a report: `{ stop: true }` ends this collector; anything else does not. */
function saysStop(answer: unknown): boolean {
  return (
    typeof answer === 'object' &&
    answer !== null &&
    (answer as { readonly stop?: unknown }).stop === true
  );
}

class Collector implements RunningCollector {
  readonly #controller = new AbortController();
  readonly #spec: CollectSpec | null;
  readonly #isTop: boolean;
  #video: HTMLVideoElement | null = null;
  #hadVideo = false;
  #noVideoSince: EpochMs;
  #lastSampleAt = 0;
  #lastSampleMuted: boolean | null = null;
  #timeupdateCheckedAt = 0;
  #eventTimer: ReturnType<typeof setTimeout> | null = null;
  #tick: ReturnType<typeof setInterval> | null = null;
  #electedAt = 0;
  /** An election an event asked for and the gap put off: run before the next report. */
  #electionDue = false;
  #snapshot: Snapshot | null = null;
  #snapshotJson = '';
  #builtAt = 0;
  #sentJson = '';
  #sentAt = 0;
  #reportedAt = 0;
  readonly #shadowRoots = new WeakSet<ShadowRoot>();
  #stopped = false;

  constructor() {
    this.#spec = siteForHostname(location.hostname)?.module?.collect ?? null;
    this.#isTop = window === window.top;
    this.#noVideoSince = Date.now();
  }

  start(): void {
    setRunningCollector(this);
    const { signal } = this.#controller;
    for (const type of MEDIA_EVENTS) {
      document.addEventListener(type, this.#onMedia, { capture: true, passive: true, signal });
    }
    window.addEventListener('pagehide', this.#onPageHide, { signal });
    watchNavigation(window, this.#onNavigation, signal);
    this.#tick = setInterval(this.#onTick, SNAPSHOT_INTERVAL_MS);
    this.#elect();
    this.#buildSnapshot();
    this.#report(true);
  }

  refresh(): boolean {
    if (this.#stopped || !reachesWorker()) return false;
    this.#elect();
    this.#buildSnapshot();
    this.#report(true);
    return true;
  }

  stop(): void {
    this.#stop(false);
  }

  #stop(rearm: boolean): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#controller.abort();
    if (this.#tick !== null) clearInterval(this.#tick);
    if (this.#eventTimer !== null) clearTimeout(this.#eventTimer);
    this.#video = null;
    this.#snapshot = null;
    forgetSounded();
    clearRunningCollector(this);
    if (rearm) rearmBootstrap();
  }

  /** Re-runs the election; a video inside a shadow root gets the media listeners there too. */
  #elect(): void {
    this.#electedAt = Date.now();
    this.#electionDue = false;
    let video: HTMLVideoElement | null;
    try {
      video = electVideo(document, { shadow: this.#spec?.shadowRootPlayer === true });
    } catch {
      video = null;
    }
    if (video !== null) {
      this.#hadVideo = true;
      const root = video.getRootNode();
      if (root instanceof ShadowRoot && !this.#shadowRoots.has(root)) {
        this.#shadowRoots.add(root);
        const { signal } = this.#controller;
        for (const type of MEDIA_EVENTS) {
          root.addEventListener(type, this.#onMedia, { capture: true, passive: true, signal });
        }
      }
    } else if (this.#video !== null) {
      this.#noVideoSince = Date.now();
    }
    this.#video = video;
  }

  #playing(): boolean {
    const video = this.#video;
    return video !== null && !video.paused && !video.ended;
  }

  /** A new snapshot; should the page break the builder, the last one stands. */
  #buildSnapshot(): void {
    this.#builtAt = Date.now();
    try {
      const snapshot = buildSnapshot(document, location, this.#spec, {});
      this.#snapshotJson = JSON.stringify(snapshot);
      this.#snapshot = snapshot;
    } catch {
      // Kept: the previous snapshot.
    }
  }

  #sample(now: EpochMs): PlaybackSample | null {
    const video = this.#video;
    if (video === null) return null;
    return sampleOf(video, now, signalVisible(document, this.#spec?.signals?.adPlaying));
  }

  /** One report: a sample of the video (if any) and the snapshot when it is new or due. */
  #report(forceSnapshot = false): void {
    if (this.#stopped) return;
    if (this.#electionDue) this.#elect();
    const now = Date.now();
    const sample = this.#sample(now);
    const snapshotDue =
      this.#snapshot !== null &&
      (forceSnapshot ||
        this.#snapshotJson !== this.#sentJson ||
        now - this.#sentAt >= SNAPSHOT_RESEND_MS);
    const snapshot = snapshotDue ? this.#snapshot : null;
    if (sample === null && snapshot === null) return;
    if (snapshot !== null) {
      this.#sentJson = this.#snapshotJson;
      this.#sentAt = now;
    }
    if (sample !== null) {
      this.#lastSampleAt = now;
      this.#lastSampleMuted = sample.muted;
    }
    this.#reportedAt = now;
    this.#send({ v: VERSION, type: 'collector/report', isTop: this.#isTop, sample, snapshot });
  }

  #send(message: Outgoing): void {
    let answer: Promise<unknown>;
    try {
      answer = browser.runtime.sendMessage(message);
    } catch {
      this.#stop(false);
      return;
    }
    answer.then(
      (reply) => {
        if (saysStop(reply)) this.#stop(true);
      },
      () => {
        // The worker restarting answers nothing; only a script cut off from it stops.
        if (!reachesWorker()) this.#stop(false);
      },
    );
  }

  /** A media event's sample, at once — or, after a burst, once the burst has settled. */
  #eventSample(): void {
    if (this.#eventTimer !== null) return;
    const wait = this.#lastSampleAt + EVENT_GAP_MS - Date.now();
    if (wait <= 0) {
      this.#report();
      return;
    }
    this.#eventTimer = setTimeout(() => {
      this.#eventTimer = null;
      this.#report();
    }, wait);
  }

  readonly #onMedia = (event: Event): void => {
    if (this.#stopped) return;
    const target = event.target;
    if (!(target instanceof HTMLVideoElement)) return;
    const now = Date.now();
    if (ELECTION_EVENTS.has(event.type)) {
      if (now - this.#electedAt >= ELECTION_GAP_MS) this.#elect();
      else this.#electionDue = true;
    }
    if (target !== this.#video) {
      // Another video's start may be the person's new choice: the sample decides it.
      if (this.#electionDue && event.type === 'play') this.#eventSample();
      return;
    }
    switch (event.type) {
      case 'timeupdate':
        if (now - this.#timeupdateCheckedAt < TIMEUPDATE_CHECK_MS) return;
        this.#timeupdateCheckedAt = now;
        if (now - this.#lastSampleAt >= SAMPLE_INTERVAL_MS) {
          this.#buildSnapshot();
          this.#report();
        }
        return;
      case 'volumechange':
        // Only a change of muted-or-not is a sample of its own; a slider is not.
        if (this.#lastSampleMuted === (target.muted || target.volume <= 0)) return;
        this.#eventSample();
        return;
      case 'play':
        if (now - this.#builtAt >= SNAPSHOT_GAP_MS) this.#buildSnapshot();
        this.#eventSample();
        return;
      case 'emptied':
        return;
      default:
        this.#eventSample();
    }
  };

  readonly #onTick = (): void => {
    if (this.#stopped) return;
    const now = Date.now();
    this.#elect();
    if (this.#video === null) {
      // Gone: a collector that had a video, or any but the top frame that names the title.
      if ((this.#hadVideo || !this.#isTop) && now - this.#noVideoSince >= GONE_AFTER_MS) {
        this.#send({ v: VERSION, type: 'collector/gone' });
        this.#stop(true);
        return;
      }
      this.#buildSnapshot();
      if (this.#snapshotJson !== this.#sentJson || now - this.#reportedAt >= SNAPSHOT_RESEND_MS) {
        this.#report();
      }
      return;
    }
    if (!this.#playing()) return;
    this.#buildSnapshot();
    // A page that now says something else (the next episode on the same address) is reported
    // at once; otherwise every 15 s.
    if (now - this.#lastSampleAt >= SAMPLE_INTERVAL_MS || this.#snapshotJson !== this.#sentJson) {
      this.#report();
    }
  };

  readonly #onNavigation = (): void => {
    if (this.#stopped) return;
    this.#elect();
    this.#buildSnapshot();
    this.#report(true);
  };

  readonly #onPageHide = (): void => {
    // The last position before the page goes; the worker ends the sitting from it.
    this.#report();
    this.#stop(true);
  };
}

const collector: UnlistedScriptDefinition = defineUnlistedScript(() => {
  const running = runningCollector();
  if (running?.refresh() === true) return;
  running?.stop();
  new Collector().start();
});

export default collector;
