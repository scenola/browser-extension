/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// When the frame's address changes without a new document: a single-page player moving to the
// next episode, or away from the player. The Navigation API says so as it happens; where it is
// missing, the address is compared once a second. Either way `onChange` runs once per new
// address, at most once a second — the last address always — and nothing is left running once
// `signal` aborts.

/** How often the address is compared where the Navigation API is missing. */
const URL_CHECK_MS = 1000;
/**
 * A page that changes its address faster than this (`history.replaceState` in a loop) is
 * followed at this pace: each change is a report, and on a module's site a read of the page and
 * an interpretation in the worker, so the page must not decide how many there are.
 */
const CHANGE_GAP_MS = 1000;

interface NavigationLike {
  addEventListener(
    type: string,
    listener: () => void,
    options: { readonly signal: AbortSignal },
  ): void;
}

function navigationOf(view: Window): NavigationLike | null {
  const navigation = (view as { readonly navigation?: unknown }).navigation;
  if (typeof navigation !== 'object' || navigation === null) return null;
  const add = (navigation as { readonly addEventListener?: unknown }).addEventListener;
  return typeof add === 'function' ? (navigation as NavigationLike) : null;
}

export function watchNavigation(view: Window, onChange: () => void, signal: AbortSignal): void {
  let last = view.location.href;
  let changedAt = -Infinity;
  let due: ReturnType<typeof setTimeout> | null = null;
  const report = (): void => {
    due = null;
    if (signal.aborted) return;
    const href = view.location.href;
    if (href === last) return;
    last = href;
    changedAt = Date.now();
    onChange();
  };
  const check = (): void => {
    if (signal.aborted || due !== null || view.location.href === last) return;
    const wait = changedAt + CHANGE_GAP_MS - Date.now();
    if (wait <= 0) report();
    else due = setTimeout(report, wait);
  };
  signal.addEventListener('abort', () => {
    if (due !== null) clearTimeout(due);
  });
  const navigation = navigationOf(view);
  if (navigation !== null) {
    // `navigatesuccess` for navigations the page intercepts; `currententrychange` for every
    // change of the current entry, `history.pushState` included.
    navigation.addEventListener('navigatesuccess', check, { signal });
    navigation.addEventListener('currententrychange', check, { signal });
    return;
  }
  const timer = setInterval(check, URL_CHECK_MS);
  signal.addEventListener('abort', () => {
    clearInterval(timer);
  });
}
