/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the worker runs in a page, through `chrome.scripting`: the collector, injected into the
// frame whose bootstrap saw a `play`; our state-path reader, run in the frame's MAIN world where
// the player's objects live; and the bootstrap itself, into tabs that were open before it could
// run there. Never a web-accessible resource, so a page cannot tell the extension is there. A
// frame is targeted by its document when Chrome named one, so a frame that has since navigated
// is left alone.

import type { StatePath } from '@mt/services';
import type { Browser } from 'wxt/browser';

import { readStatePath } from '../collector/state-path-reader';
import type {
  BootstrapInjector,
  CollectorInjector,
  FrameTarget,
  OpenFrame,
  PageStateReader,
} from '../composition/ports';
import { BOOTSTRAP_FILE, COLLECTOR_FILE } from '../script-files';

type Scripting = Pick<typeof Browser.scripting, 'executeScript'>;
type Tabs = Pick<typeof Browser.tabs, 'query'>;

/** A page whose reader has not answered in this long is answered for: nothing was read. */
const PAGE_STATE_DEADLINE_MS = 1_000;

/** `executeScript`'s target for one frame, by its document where known. */
function injectionTarget(target: FrameTarget): Browser.scripting.InjectionTarget {
  return target.documentId === null
    ? { tabId: target.tabId, frameIds: [target.frameId] }
    : { tabId: target.tabId, documentIds: [target.documentId] };
}

/** One of the extension's scripts into one frame, at once; `false` when it could not run there. */
async function injectFile(
  scripting: Scripting,
  target: FrameTarget,
  file: string,
): Promise<boolean> {
  try {
    // As soon as possible: for the collector, the video is playing already.
    await scripting.executeScript({
      target: injectionTarget(target),
      files: [file],
      injectImmediately: true,
    });
    return true;
  } catch {
    // The frame went away, navigated, or is a page the extension may not script.
    return false;
  }
}

export class ScriptingCollectorInjector implements CollectorInjector {
  readonly #scripting: Scripting;

  constructor(scripting: Scripting) {
    this.#scripting = scripting;
  }

  inject(target: FrameTarget): Promise<boolean> {
    return injectFile(this.#scripting, target, COLLECTOR_FILE);
  }
}

/**
 * The origin of the frame it runs in, run by `executeScript` in each frame's isolated world:
 * an `about:blank` frame answers its creator's (the manifest's `match_origin_as_fallback`), a
 * sandboxed one `"null"`. Self-contained: Chrome serialises the function.
 */
function frameOrigin(): string {
  return location.origin;
}

/** An origin the probe answered, as `URL.origin` writes one; anything else is opaque. */
function originOf(result: unknown): string | null {
  if (typeof result !== 'string' || result.length > 300) return null;
  try {
    return new URL(result).origin === result ? result : null;
  } catch {
    return null;
  }
}

/**
 * The bootstrap into the open tabs: the tabs whose URL Chrome shows this extension (the sites
 * it has access to), every frame's origin from one probe, the bootstrap file by document. The
 * worker decides which frames get it.
 */
export class ScriptingBootstrapInjector implements BootstrapInjector {
  readonly #scripting: Scripting;
  readonly #tabs: Tabs;

  constructor(scripting: Scripting, tabs: Tabs) {
    this.#scripting = scripting;
    this.#tabs = tabs;
  }

  async openTabs(
    patterns?: readonly string[],
  ): Promise<readonly { readonly tabId: number; readonly url: string }[]> {
    let tabs: readonly Browser.tabs.Tab[];
    try {
      tabs = await this.#tabs.query(patterns === undefined ? {} : { url: [...patterns] });
    } catch {
      return [];
    }
    return tabs.flatMap((tab) =>
      typeof tab.id === 'number' && tab.id >= 0 && typeof tab.url === 'string' && tab.url !== ''
        ? [{ tabId: tab.id, url: tab.url }]
        : [],
    );
  }

  async framesOf(tabId: number): Promise<readonly OpenFrame[]> {
    let results: readonly Browser.scripting.InjectionResult<unknown>[];
    try {
      results = await this.#scripting.executeScript({
        target: { tabId, allFrames: true },
        func: frameOrigin,
        injectImmediately: true,
      });
    } catch {
      // A tab the extension may not script (Chrome's own pages, a site it lost access to).
      return [];
    }
    return results.flatMap((result) =>
      typeof result.frameId === 'number' && result.frameId >= 0
        ? [
            {
              frameId: result.frameId,
              documentId: typeof result.documentId === 'string' ? result.documentId : null,
              origin: originOf(result.result),
            },
          ]
        : [],
    );
  }

  inject(target: FrameTarget): Promise<boolean> {
    return injectFile(this.#scripting, target, BOOTSTRAP_FILE);
  }
}

/**
 * Each declared path read in the frame's MAIN world by `readStatePath`, all at once; a path that
 * fails, reads as nothing or takes longer than a second is absent from the answer. A page that
 * never lets the reader finish (its main thread busy for good) delays nothing but itself.
 */
export class ScriptingPageStateReader implements PageStateReader {
  readonly #scripting: Scripting;

  constructor(scripting: Scripting) {
    this.#scripting = scripting;
  }

  async read(
    target: FrameTarget,
    paths: Readonly<Record<string, StatePath>>,
    allowedCalls: readonly string[],
    routeGroups: readonly (string | null)[],
  ): Promise<Readonly<Record<string, unknown>>> {
    const names = Object.keys(paths);
    const values = await Promise.all(
      names.map((name) => {
        const path = paths[name];
        return path === undefined
          ? Promise.resolve(null)
          : this.#readOne(target, path, allowedCalls, routeGroups);
      }),
    );
    const state: Record<string, unknown> = {};
    names.forEach((name, index) => {
      const value = values[index];
      if (value !== null && value !== undefined) state[name] = value;
    });
    return state;
  }

  async #readOne(
    target: FrameTarget,
    path: StatePath,
    allowedCalls: readonly string[],
    routeGroups: readonly (string | null)[],
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        resolve(null);
      }, PAGE_STATE_DEADLINE_MS);
    });
    try {
      const injected = this.#scripting
        .executeScript({
          target: injectionTarget(target),
          world: 'MAIN',
          func: readStatePath,
          args: [path, allowedCalls, routeGroups],
          injectImmediately: true,
        })
        .then((results) => results[0]?.result ?? null)
        .catch(() => null);
      return await Promise.race([injected, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
