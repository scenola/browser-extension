/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What every part of the composition root shares: the answers a `ui` request gets, the log and
// the guard around a step that must not stop the rest, the listeners told that what the pages
// show may have changed, and a reading in the words a play is shown by.

import { playLabel } from '@mt/core';
import type { MergedReading, PlayBody } from '@mt/core';

import { PROTOCOL_VERSION } from '../messaging/protocol';
import type { UiResponse } from '../messaging/protocol';
import type { DiagnosticsLog } from '../platform/diagnostics';
import { isRecord } from '../values';

/**
 * Something plays for this long after its last sample (a player samples every 15 s): the popup
 * says why it goes nowhere, and the icon shows a viewing recorded, only within it.
 */
export const PLAYING_WINDOW_MS = 30_000;

export const ok = (data?: unknown): UiResponse =>
  data === undefined ? { ok: true } : { ok: true, data };
export const fail = (error: string): UiResponse => ({ ok: false, error });
export const errorName = (error: unknown): string =>
  error instanceof Error ? error.name.slice(0, 64) : typeof error;

/** The local diagnostics log, and the guard that logs a failed step by name and goes on. */
export class Steps {
  readonly #diagnostics: DiagnosticsLog;

  constructor(diagnostics: DiagnosticsLog) {
    this.#diagnostics = diagnostics;
  }

  log(event: string, detail: Readonly<Record<string, unknown>>): Promise<void> {
    return this.#diagnostics.log(event, detail);
  }

  /** Runs a step whose failure must not stop the rest; the failure is logged by name. */
  async guard(step: string, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error: unknown) {
      void this.log('step.failed', { step, error: errorName(error) });
    }
  }
}

/** Who is told that what `uiState` answers may have changed (the open pages, via the router). */
export class Listeners {
  readonly #listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A page that went away has nothing to update.
      }
    }
  }
}

/** What the page says is playing, in the play's own words (`playLabel`). */
export function readingLabel(r: MergedReading): string {
  if (r.kind === undefined) return '';
  const body: PlayBody = {
    kind: r.kind,
    watched_at: '',
    ...(r.title === undefined ? {} : { title: r.title }),
    ...(r.showTitle === undefined ? {} : { show: { title: r.showTitle } }),
    ...(r.season === undefined ? {} : { season_number: r.season }),
    ...(r.episode === undefined ? {} : { episode_number: r.episode }),
  };
  return playLabel(body) ?? '';
}

/** Why a message was refused, for the log: another version, or another shape. */
export function refusedWhy(raw: unknown): string {
  const version = isRecord(raw) ? raw.v : undefined;
  return version !== undefined && version !== PROTOCOL_VERSION ? 'version' : 'shape';
}
