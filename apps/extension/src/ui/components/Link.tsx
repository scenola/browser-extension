/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A link out of the extension — to the web app, the source, the licence. It opens a tab of its
// own, sends no referrer (an extension page's URL names the extension), and carries the external
// glyph so the person knows they are leaving. Words only from `t()`; the URL from `WEB_ROUTES`
// or the root's `href`, never spelled here.

import type { ComponentChildren } from 'preact';

import { Icon } from './Icon';

export function Link({
  href,
  children,
  class: className = '',
  quiet = false,
}: {
  readonly href: string;
  readonly children: ComponentChildren;
  readonly class?: string;
  /** Secondary text colour, for a link that sits in a line of metadata. */
  readonly quiet?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      class={`inline-flex items-center gap-1 rounded-sm font-medium underline decoration-1 underline-offset-[3px] decoration-transparent transition-colors duration-state ease-app hover:decoration-current ${quiet ? 'text-muted-foreground hover:text-foreground' : 'text-foreground'} ${className}`}
    >
      <span>{children}</span>
      <Icon name="external" size={14} />
    </a>
  );
}
