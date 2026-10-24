/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A raised surface, and the inset rows it groups — the settings page's grammar, after Apple's
// grouped lists: a section is a heading and a card of rows divided by hairlines.

import type { ComponentChildren } from 'preact';

export function Card({
  children,
  class: className = '',
}: {
  readonly children: ComponentChildren;
  readonly class?: string;
}) {
  return (
    <div class={`rounded-[20px] border border-border bg-card text-card-foreground ${className}`}>
      {children}
    </div>
  );
}

/**
 * One row of a card: what it is (`title`, and a line of `detail` under it) at the start, its
 * control at the end. Rows after the first are divided by a hairline.
 */
export function Row({
  title,
  detail,
  control,
  children,
  id,
}: {
  readonly title: ComponentChildren;
  readonly detail?: ComponentChildren;
  readonly control?: ComponentChildren;
  readonly children?: ComponentChildren;
  readonly id?: string;
}) {
  return (
    <div class="border-t border-border px-5 py-4 first:border-t-0">
      <div class="flex items-center gap-4">
        <div class="min-w-0 flex-1">
          <div id={id} class="scroll-mt-24 text-body-s font-medium">
            {title}
          </div>
          {detail === undefined ? null : (
            <div class="mt-0.5 text-caption text-muted-foreground">{detail}</div>
          )}
        </div>
        {control === undefined ? null : <div class="flex shrink-0 items-center">{control}</div>}
      </div>
      {children}
    </div>
  );
}
