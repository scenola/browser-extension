/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// One section of the settings page: its heading, an optional line under it, and its cards.

import type { ComponentChildren } from 'preact';

export function Section({
  id,
  title,
  lead,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly lead?: string;
  readonly children: ComponentChildren;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} class="scroll-mt-24">
      <h2 id={`${id}-heading`} class="font-display text-display-m font-semibold tracking-[-0.01em]">
        {title}
      </h2>
      {lead === undefined ? null : (
        <p class="mt-1 max-w-[40rem] text-body-s text-muted-foreground">{lead}</p>
      )}
      <div class="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** A small heading inside a section, over a card of its own; `id` makes it an anchor. */
export function GroupTitle({
  id,
  children,
}: {
  readonly id?: string;
  readonly children: ComponentChildren;
}) {
  return (
    <h3 id={id} class="scroll-mt-24 px-1 text-body-s font-semibold text-muted-foreground">
      {children}
    </h3>
  );
}
