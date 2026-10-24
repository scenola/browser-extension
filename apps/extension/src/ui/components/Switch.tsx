/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// An on/off setting: a `<button role="switch">` with `aria-checked`, named by the row it sits in.
// On, its track is the lamp — the web app's one sanctioned use of the warm hue on a control, "a
// toggle that is on" — and its thumb travels to the inline end, so the state is the thumb's
// place as well as a colour. A busy switch (waiting on Chrome or the worker) cannot be pressed
// twice.

import type { TargetedMouseEvent } from 'preact';

export function Switch({
  checked,
  onToggle,
  labelledBy,
  describedBy,
  busy = false,
  disabled = false,
}: {
  readonly checked: boolean;
  /** Called from the click itself: a permission request inside it keeps the person's gesture. */
  readonly onToggle: (event: TargetedMouseEvent<HTMLButtonElement>) => void;
  readonly labelledBy: string;
  readonly describedBy?: string;
  readonly busy?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-busy={busy}
      disabled={disabled}
      onClick={(event) => {
        if (!busy) onToggle(event);
      }}
      class={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors duration-state ease-app disabled:opacity-50 ${checked ? 'border-lamp bg-lamp' : 'border-input bg-secondary'}`}
    >
      <span
        aria-hidden="true"
        class={`block size-5 rounded-full shadow-sm transition-[translate] duration-open ease-app ${checked ? 'translate-x-[22px] bg-primary-foreground rtl:-translate-x-[22px]' : 'translate-x-[3px] bg-foreground rtl:-translate-x-[3px]'}`}
      />
    </button>
  );
}
