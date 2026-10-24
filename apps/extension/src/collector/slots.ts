/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// How the bootstrap and the collector of one frame find each other. Both run in the extension's
// isolated world of the frame, which shares the DOM with the page but not its JavaScript
// globals: what is kept on the isolated world's global object is out of the page's reach. The
// keys are symbols, so no element id or name in the page can stand in for them (`window.<id>`
// named access only ever yields string-keyed properties).
//
// Each `executeScript` of the collector runs its file afresh, so a module-scoped variable cannot
// say whether a collector already runs in the frame; the slot on the global can. A slot may
// have been left by an older build of the extension (an update leaves its scripts running in
// open pages), so what is read from one is checked before it is used.

import { browser } from 'wxt/browser';

/** Whether this script can still reach the worker: a reloaded or updated extension cuts it off. */
export function reachesWorker(): boolean {
  try {
    return typeof browser.runtime.id === 'string';
  } catch {
    return false;
  }
}

/** What a running collector offers a later injection into its frame. */
export interface RunningCollector {
  /** Reports at once; `false` when this collector can no longer reach the worker. */
  refresh(): boolean;
  /** Stops it and removes every listener it added. */
  stop(): void;
}

const COLLECTOR: unique symbol = Symbol.for('mediatracker.collector');
const BOOTSTRAP: unique symbol = Symbol.for('mediatracker.bootstrap');
const BOOTSTRAP_ALIVE: unique symbol = Symbol.for('mediatracker.bootstrap-alive');

interface Slots {
  [COLLECTOR]?: unknown;
  /** Arms the bootstrap's `play` listener again (after the collector stopped). */
  [BOOTSTRAP]?: unknown;
  /** Whether that bootstrap can still reach the worker (its extension was not reloaded). */
  [BOOTSTRAP_ALIVE]?: unknown;
}

const slots = globalThis as unknown as Slots;

function isRunningCollector(value: unknown): value is RunningCollector {
  if (typeof value !== 'object' || value === null) return false;
  const { refresh, stop } = value as { readonly refresh?: unknown; readonly stop?: unknown };
  return typeof refresh === 'function' && typeof stop === 'function';
}

/** The collector running in this frame, if any. */
export function runningCollector(): RunningCollector | null {
  const running = slots[COLLECTOR];
  return isRunningCollector(running) ? running : null;
}

export function setRunningCollector(running: RunningCollector): void {
  slots[COLLECTOR] = running;
}

/** Empties the slot, when it still holds `running` (a later collector may have taken it). */
export function clearRunningCollector(running: RunningCollector): void {
  if (slots[COLLECTOR] === running) slots[COLLECTOR] = undefined;
}

/**
 * The bootstrap's re-arm, set by the bootstrap of this frame, and how it tells whether it can
 * still reach the worker. A bootstrap without the second (an older build's) counts as cut off.
 */
export function setBootstrapArm(arm: () => void, alive?: () => boolean): void {
  slots[BOOTSTRAP] = arm;
  slots[BOOTSTRAP_ALIVE] = alive;
}

/**
 * A bootstrap already runs in this frame and can still reach the worker: a second injection adds
 * nothing. One a reloaded or updated extension left behind says it cannot.
 */
export function liveBootstrap(): boolean {
  const alive = slots[BOOTSTRAP_ALIVE];
  if (typeof alive !== 'function') return false;
  try {
    return (alive as () => unknown)() === true;
  } catch {
    return false;
  }
}

/** Arms the frame's bootstrap again, when there is one (a frame injected without one has none). */
export function rearmBootstrap(): void {
  const arm = slots[BOOTSTRAP];
  if (typeof arm === 'function') (arm as () => void)();
}
