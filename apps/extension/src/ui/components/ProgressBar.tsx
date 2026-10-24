/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// How far the viewing has got: a native `<progress>` — announced with its value by every screen
// reader, and drawn without an inline style (the pages' CSP has no `'unsafe-inline'`) — beside
// the same fact in words ("31 of 48 min"), so neither the bar nor its colour carries it alone.

export function ProgressBar({
  value,
  max,
  label,
  text,
}: {
  readonly value: number;
  readonly max: number;
  /** The bar's accessible name (what it measures). */
  readonly label: string;
  /** The same progress in words, shown beside the bar and read as its value. */
  readonly text: string;
}) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  const safeValue = Number.isFinite(value) ? Math.min(Math.max(value, 0), safeMax) : 0;
  return (
    <div class="flex items-center gap-3">
      <progress
        class="beam min-w-0 flex-1"
        value={safeValue}
        max={safeMax}
        aria-label={label}
        aria-valuetext={text}
      />
      <span class="shrink-0 text-micro text-muted-foreground" aria-hidden="true">
        {text}
      </span>
    </div>
  );
}
