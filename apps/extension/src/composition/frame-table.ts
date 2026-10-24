/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The frame table: each tab's frames, with each frame's latest report, and the one
// observation a burst of them becomes. In memory only: a worker that stops loses the reports in
// flight, never a viewing — the next sample continues from the persisted tab state.

import { electFrame, identityOf, titleProviderId } from '@mt/core';
import type {
  Clock,
  EntryVerdict,
  EpochMs,
  FrameReport,
  PlaybackSample,
  ServiceReading,
  Snapshot,
} from '@mt/core';

/** Reports of one tab arriving within this window are one observation. */
const COALESCE_MS = 250;
/** A frame that sent nothing for this long is gone from the tab's observation. */
const FRAME_TTL_MS = 30_000;
/**
 * How long an observation waits for the player's own next sample (it samples every 15 s and on
 * every media event); past it, the player is taken to have stopped reporting.
 */
const PLAYER_WAIT_MS = 20_000;
/** At most this many frames of one tab are followed; later ones are ignored. */
export const MAX_FRAMES_PER_TAB = 32;

/** A sender's frame, as Chrome — never the message — says it is. */
export interface FrameOrigin {
  readonly tabId: number;
  readonly frameId: number;
  /** The frame's current document (`sender.documentId`), when Chrome says. */
  readonly documentId: string | null;
  readonly isTop: boolean;
  readonly incognito: boolean;
  readonly hostname: string;
  /** The frame's http(s) URL; `null` for a frame matched by its origin (`about:blank`, …). */
  readonly url: URL | null;
  readonly topHostname: string;
  /**
   * The tab's top frame's path now, as Chrome says it (the tab's URL), or as the top frame's last
   * report did; `null` when neither says. On a module site it decides whether a sample counts.
   */
  readonly topPathname: string | null;
}

/** One frame's latest report, as the tab's next observation will see it. */
export interface FrameEntry {
  readonly frameId: number;
  readonly documentId: string | null;
  readonly isTop: boolean;
  readonly hostname: string;
  readonly pathname: string;
  readonly receivedAt: EpochMs;
  readonly sample: PlaybackSample | null;
  readonly sampleSeq: number;
  /** The sample sequence already handed to an observation: a sample is never applied twice. */
  readonly observedSeq: number;
  readonly snapshot: Snapshot | null;
  readonly snapshotSeq: number;
  readonly snapshotPath: string;
  readonly reading: ServiceReading | null;
  readonly generic: readonly ServiceReading[];
  /** The entry rule's verdict on the snapshot, on a site without a module. */
  readonly entry: EntryVerdict | null;
}

export interface TabFrames {
  readonly tabId: number;
  readonly frames: Map<number, FrameEntry>;
  /** The top frame's host, as its own reports (or the tab's URL) say. */
  topHostname: string | null;
  /** The top frame's document: when it changes, every other frame was the previous page's. */
  topDocumentId: string | null;
  serviceId: string | null;
  incognito: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  lastReportAt: EpochMs;
  /** The last time a frame of the tab sent a sample, or a video started playing in it. */
  lastSampleAt: EpochMs;
  /** No injection into the top frame is tried before this (one was tried). */
  topRetryAt: EpochMs;
}

/**
 * A module reading without a kind keeps the identity of the frame's previous reading on the same
 * path when both carry the same own-service title id (the id is the identity): a player that hid
 * its controls still plays the title it named. What the reading says of the moment — the content
 * ended, an ad, a stated length — stays its own. The identity fields are core's one list
 * (`identityOf`).
 */
export function keepIdentity(
  reading: ServiceReading,
  previous: ServiceReading | null,
): ServiceReading {
  if (reading.kind !== undefined || previous?.kind === undefined) return reading;
  const id = titleProviderId(reading);
  if (id === undefined || id !== titleProviderId(previous)) return reading;
  return { ...reading, ...identityOf(previous) };
}

/** What a tab's observation hands on: the frames as the core takes them. */
type Observe = (table: TabFrames, frames: FrameReport[]) => Promise<void>;

export class FrameTable {
  readonly #tabs = new Map<number, TabFrames>();
  readonly #clock: Clock;
  readonly #observe: Observe;

  constructor(clock: Clock, observe: Observe) {
    this.#clock = clock;
    this.#observe = observe;
  }

  get(tabId: number): TabFrames | undefined {
    return this.#tabs.get(tabId);
  }

  /** The tab's frames, made on first use; a closed tab's entry is a new one. */
  ensure(frame: FrameOrigin): TabFrames {
    let table = this.#tabs.get(frame.tabId);
    if (table === undefined) {
      const now = this.#clock.now();
      table = {
        tabId: frame.tabId,
        frames: new Map(),
        topHostname: null,
        topDocumentId: null,
        serviceId: null,
        incognito: frame.incognito,
        timer: null,
        lastReportAt: now,
        lastSampleAt: now,
        topRetryAt: 0,
      };
      this.#tabs.set(frame.tabId, table);
    }
    if (frame.isTop) table.topHostname = frame.hostname;
    return table;
  }

  /** The table is still the tab's: the tab neither closed nor was reset while a report waited. */
  isCurrent(table: TabFrames): boolean {
    return this.#tabs.get(table.tabId) === table;
  }

  remove(tabId: number): void {
    const table = this.#tabs.get(tabId);
    if (table?.timer != null) clearTimeout(table.timer);
    this.#tabs.delete(tabId);
  }

  clear(): void {
    for (const table of this.#tabs.values()) {
      if (table.timer !== null) clearTimeout(table.timer);
    }
    this.#tabs.clear();
  }

  tabIds(): readonly number[] {
    return [...this.#tabs.keys()];
  }

  /**
   * The tab that reported last among those whose top frame holds a snapshot. A tab whose
   * bootstrap was refused (a turned-off service) has a table and no snapshot.
   */
  latestWithSnapshot(): TabFrames | undefined {
    return [...this.#tabs.values()]
      .filter((table) => table.frames.get(0)?.snapshot != null)
      .sort((a, b) => b.lastReportAt - a.lastReportAt)[0];
  }

  /** One observation for the tab, `COALESCE_MS` after the first new sample. */
  schedule(table: TabFrames): void {
    if (table.timer !== null) return;
    table.timer = setTimeout(() => {
      table.timer = null;
      void this.#run(table);
    }, COALESCE_MS);
  }

  async #run(table: TabFrames): Promise<void> {
    if (this.#tabs.get(table.tabId) !== table) return;
    const now = this.#clock.now();
    for (const [id, entry] of table.frames) {
      if (now - entry.receivedAt > FRAME_TTL_MS) table.frames.delete(id);
    }
    const entries = [...table.frames.values()];
    const unseen = (entry: FrameEntry): boolean => entry.sampleSeq > entry.observedSeq;
    if (!entries.some((entry) => unseen(entry) && entry.sample !== null)) return;
    // An observation is a new sample of the tab's player. While another frame's sample is new
    // and the player's is not (a preview beside it, between two of the player's samples), the
    // observation waits for the player's next one: handed the old sample it would count it
    // twice; handed none, the election would give the player's viewing the other frame's.
    const latest: FrameReport[] = entries.map((entry) => ({
      frameId: entry.frameId,
      isTop: entry.isTop,
      sample: entry.sample,
      reading: entry.reading,
      generic: entry.generic,
    }));
    const predicted = (electFrame(latest) ?? electFrame(latest, { includeStopped: true }))?.player;
    const player = predicted === undefined ? undefined : table.frames.get(predicted.frameId);
    if (player !== undefined && !unseen(player) && now - player.receivedAt <= PLAYER_WAIT_MS) {
      return;
    }
    const frames: FrameReport[] = entries.map((entry) => ({
      frameId: entry.frameId,
      isTop: entry.isTop,
      // A sample an observation already saw is not seen again (it would count twice).
      sample: unseen(entry) ? entry.sample : null,
      reading: entry.reading,
      generic: entry.generic,
      entry: entry.entry ?? undefined,
    }));
    for (const entry of entries) {
      if (!unseen(entry)) continue;
      table.frames.set(entry.frameId, { ...entry, observedSeq: entry.sampleSeq });
    }
    await this.#observe(table, frames);
  }
}
