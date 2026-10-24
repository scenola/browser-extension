/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Which `<video>` of a frame is the one being watched: a score — the visible
// area, playing over paused, sound over silence — and one rule above it: an element that played
// with sound stays elected while it is in the document, even when paused, so a muted preview
// that starts beside a paused film never takes it over. Another element playing with sound
// while it does not is the person's new choice, and wins.
//
// The memory of "played with sound" is kept here, in the collector's module (one per injected
// collector): every election sees every candidate, so an element is marked the first time an
// election sees it playing with sound.

/** Videos looked at per election: a page with more is a catalogue of previews. */
const MAX_CANDIDATES = 64;
/** Shadow roots searched, and elements walked looking for them (a module's `shadowRootPlayer`). */
const MAX_SHADOW_ROOTS = 16;
const MAX_ELEMENTS_WALKED = 5000;
/** An element smaller than this on either side is not a player. */
const MIN_SIDE_PX = 2;

/** The element that last played with sound; held weakly, so a removed one can be collected. */
let sounded: WeakRef<HTMLVideoElement> | null = null;

/** Playing, unmuted and audible: the element the person is listening to. */
function playsWithSound(video: HTMLVideoElement): boolean {
  return !video.paused && !video.ended && !video.muted && video.volume > 0;
}

/** Whether an element is rendered and not hidden by CSS, as far as the browser says. */
export function isVisible(element: Element): boolean {
  try {
    const check = (element as { readonly checkVisibility?: unknown }).checkVisibility;
    if (typeof check === 'function') {
      return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const view = element.ownerDocument.defaultView;
    if (view === null) return false;
    const style = view.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  } catch {
    return false;
  }
}

/** The element's box clipped to its frame's viewport, in px, with the viewport's area. */
function clipped(element: Element): { readonly area: number; readonly viewport: number } | null {
  try {
    const doc = element.ownerDocument;
    const view = doc.defaultView;
    const width = doc.documentElement.clientWidth || (view?.innerWidth ?? 0);
    const height = doc.documentElement.clientHeight || (view?.innerHeight ?? 0);
    const rect = element.getBoundingClientRect();
    if (rect.width < MIN_SIDE_PX || rect.height < MIN_SIDE_PX) return null;
    const w = Math.max(0, Math.min(rect.right, width) - Math.max(rect.left, 0));
    const h = Math.max(0, Math.min(rect.bottom, height) - Math.max(rect.top, 0));
    const area = w * h;
    const viewport = width * height;
    return Number.isFinite(area) && Number.isFinite(viewport) ? { area, viewport } : null;
  } catch {
    return null;
  }
}

/** The share of its frame's viewport an element covers, 0–1. */
export function visibleShare(element: Element): number {
  const box = clipped(element);
  if (box === null || box.viewport <= 0) return 0;
  return Math.min(Math.max(box.area / box.viewport, 0), 1);
}

/**
 * How likely an element is the main player: playing outweighs everything, then progress, sound
 * and size; an ended one is pushed back. `null` for no player.
 */
function score(video: HTMLVideoElement): number | null {
  if (!isVisible(video)) return null;
  const box = clipped(video);
  if (box === null) return null;
  const playing = !video.paused && !video.ended;
  return (
    Math.log10(box.area + 1) * 10 +
    (playing ? 1000 : 0) +
    (video.currentTime > 0 ? 50 : 0) +
    (!video.muted && video.volume > 0 ? 20 : 0) -
    (video.ended ? 500 : 0)
  );
}

function shadowRootOf(element: Element): ShadowRoot | null {
  if (element.shadowRoot !== null) return element.shadowRoot;
  // `chrome.dom` hands a content script closed roots too; it is absent anywhere else.
  const chrome = (globalThis as { readonly chrome?: { readonly dom?: unknown } }).chrome;
  const dom = chrome?.dom as { readonly openOrClosedShadowRoot?: unknown } | undefined;
  if (dom === undefined || typeof dom.openOrClosedShadowRoot !== 'function') return null;
  try {
    const root: unknown = (
      dom as { openOrClosedShadowRoot(element: Element): unknown }
    ).openOrClosedShadowRoot(element);
    return root instanceof ShadowRoot ? root : null;
  } catch {
    return null;
  }
}

/** The shadow roots in `doc`, at most 16, found among at most 5,000 elements. */
export function shadowRootsOf(doc: Document): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
  let walked = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    walked += 1;
    if (walked > MAX_ELEMENTS_WALKED || roots.length >= MAX_SHADOW_ROOTS) break;
    const root = shadowRootOf(node as Element);
    if (root !== null) roots.push(root);
  }
  return roots;
}

/** The frame's `<video>` elements, at most 64; inside shadow roots too when `shadow`. */
function videosOf(doc: Document, shadow = false): HTMLVideoElement[] {
  const found: HTMLVideoElement[] = [];
  const add = (scope: ParentNode): void => {
    let list: NodeListOf<HTMLVideoElement>;
    try {
      list = scope.querySelectorAll('video');
    } catch {
      return;
    }
    for (let i = 0; i < list.length && found.length < MAX_CANDIDATES; i += 1) {
      const video = list[i];
      if (video !== undefined) found.push(video);
    }
  };
  add(doc);
  if (shadow) {
    for (const root of shadowRootsOf(doc)) {
      if (found.length >= MAX_CANDIDATES) break;
      add(root);
    }
  }
  return found;
}

/** The candidate with the highest score, or `null` when none is a player. */
function best(candidates: readonly HTMLVideoElement[]): HTMLVideoElement | null {
  let winner: HTMLVideoElement | null = null;
  let top = -Infinity;
  for (const video of candidates) {
    const s = score(video);
    if (s !== null && s > top) {
      top = s;
      winner = video;
    }
  }
  return winner;
}

/**
 * The video being watched in `doc`, or `null`:
 *
 * 1. the element that last played with sound, while it still does;
 * 2. else the best-scored visible element playing with sound — which becomes the one that
 *    played with sound;
 * 3. else the element that last played with sound, while it is in the document: paused, muted,
 *    ended or hidden;
 * 4. else the best-scored visible element, a muted preview included.
 */
export function electVideo(
  doc: Document,
  options?: { readonly shadow?: boolean },
): HTMLVideoElement | null {
  const kept = sounded?.deref() ?? null;
  const stays = kept?.isConnected === true && kept.ownerDocument === doc ? kept : null;
  if (stays !== null && playsWithSound(stays)) return stays;
  const candidates = videosOf(doc, options?.shadow === true);
  const audible = best(candidates.filter(playsWithSound));
  if (audible !== null) {
    sounded = new WeakRef(audible);
    return audible;
  }
  if (stays !== null) return stays;
  sounded = null;
  return best(candidates);
}

/** Forgets the element that played with sound (the collector stopped). */
export function forgetSounded(): void {
  sounded = null;
}
