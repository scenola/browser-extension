/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The pages' glyphs: a few strokes each, drawn in `currentColor`, always beside words that say
// the same thing — a glyph is never the only carrier of a state, so every one is hidden from
// assistive technology.

import type { ComponentChildren } from 'preact';

export type IconName =
  | 'check'
  | 'clock'
  | 'circle'
  | 'skip'
  | 'blocked'
  | 'alert'
  | 'live'
  | 'settings'
  | 'chevron-down'
  | 'chevron-start'
  | 'chevron-end'
  | 'external'
  | 'pause'
  | 'play'
  | 'copy';

const PATHS: Readonly<Record<IconName, ComponentChildren>> = {
  check: <path d="M4.5 10.5l3.5 3.5 7.5-8" />,
  clock: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4.25l2.75 1.75" />
    </>
  ),
  circle: <circle cx="10" cy="10" r="6.5" />,
  skip: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M6.75 10h6.5" />
    </>
  ),
  blocked: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M5.1 14.9l9.8-9.8" />
    </>
  ),
  alert: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6.25v4.5M10 13.5v.25" />
    </>
  ),
  live: <path d="M5 13V9M8.33 13V6M11.66 13V8M15 13V10.5" />,
  // Three sliders, each knob at its own place: the settings that tune how it tracks.
  settings: (
    <>
      <path d="M3.5 5.5h4M11 5.5h5.5M3.5 10h8.5M15.5 10h1M3.5 14.5h1.5M8.5 14.5h8" />
      <circle cx="9.25" cy="5.5" r="1.75" />
      <circle cx="13.75" cy="10" r="1.75" />
      <circle cx="6.75" cy="14.5" r="1.75" />
    </>
  ),
  'chevron-down': <path d="M6 8l4 4 4-4" />,
  'chevron-start': <path d="M12 6l-4 4 4 4" />,
  'chevron-end': <path d="M8 6l4 4-4 4" />,
  external: (
    <path d="M8 5.5h-2.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2.5M11 4.5h4.5V9M15.5 4.5L9 11" />
  ),
  pause: <path d="M7.5 5.5v9M12.5 5.5v9" />,
  play: <path d="M7 5.5l7.5 4.5L7 14.5z" />,
  copy: (
    <>
      <rect x="7" y="7" width="8.5" height="8.5" rx="1.5" />
      <path d="M4.5 12.5v-7a1 1 0 0 1 1-1h7" />
    </>
  ),
};

/** Glyphs that point along the reading direction turn with it (RTL). */
const MIRRORED: ReadonlySet<IconName> = new Set(['chevron-start', 'chevron-end']);

export function Icon({
  name,
  class: className = '',
  size = 16,
}: {
  readonly name: IconName;
  readonly class?: string;
  readonly size?: number;
}) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
      class={`shrink-0 ${MIRRORED.has(name) ? 'rtl:-scale-x-100' : ''} ${className}`}
    >
      {PATHS[name]}
    </svg>
  );
}

/** The product's mark — the clapperboard of the toolbar icon — in `currentColor`. */
export function Mark({
  size = 20,
  class: className = '',
}: {
  readonly size?: number;
  readonly class?: string;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
      class={`shrink-0 ${className}`}
    >
      <path d="M14 28h36v18a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4z" />
      <path d="M14 28l-1.5-8.5a4 4 0 0 1 3.2-4.6l29.5-5.2a4 4 0 0 1 4.6 3.2l1.2 6.6z" />
      <path d="M22.5 26.2l6-8.2M33.5 24.2l6-8.2M44.5 22.2l5-6.8" />
    </svg>
  );
}
