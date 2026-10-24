/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The one line that says what will happen to what is playing: a glyph and the words, in a polite
// live region, so a change ("Added at 70 %" to "Added") is announced without taking the person's
// focus. The words carry the state; the glyph only repeats it.

import type { ComponentChildren } from 'preact';

import { Icon } from './Icon';
import type { IconName } from './Icon';

export function StatusLine({
  icon,
  tone = 'plain',
  children,
}: {
  readonly icon: IconName;
  /** `muted` for a state the person need not act on; `plain` otherwise. */
  readonly tone?: 'plain' | 'muted';
  readonly children: ComponentChildren;
}) {
  return (
    <p
      aria-live="polite"
      class={`flex min-w-0 items-center gap-2 text-body-s ${tone === 'muted' ? 'text-muted-foreground' : 'text-foreground'}`}
    >
      <Icon name={icon} />
      <span class="min-w-0">{children}</span>
    </p>
  );
}
