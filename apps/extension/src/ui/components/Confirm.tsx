/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The second step of an act that cannot be undone from here (*Clear all local data*,
// *Disconnect*): it says what will happen, in place, and asks again. Its words take the focus
// when it opens, Escape or *Cancel* close it and hand the focus back, and the act's button says
// the act's own name. An act that can keep something first (*Send first, then disconnect*) offers
// that as the first, preferred button.

import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef } from 'preact/hooks';

import { t } from '../../i18n/t';
import { Button } from './Button';

export function Confirm({
  children,
  action,
  first,
  busy,
  onConfirm,
  onCancel,
}: {
  /** What will happen, in words. */
  readonly children: ComponentChildren;
  /** The act's name, on its button. */
  readonly action: string;
  /** The preferred way to do it, shown before the act's own button. */
  readonly first?: { readonly action: string; readonly onConfirm: () => void } | undefined;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const id = useId();
  const text = useRef<HTMLDivElement>(null);
  useEffect(() => {
    text.current?.focus();
  }, []);
  return (
    <div
      role="group"
      aria-labelledby={id}
      class="mt-3 rounded-2xl border border-border bg-background p-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <div id={id} ref={text} tabIndex={-1} class="text-body-s outline-none">
        {children}
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        {first === undefined ? null : (
          <Button variant="primary" size="sm" disabled={busy} onClick={first.onConfirm}>
            {first.action}
          </Button>
        )}
        <Button variant="danger" size="sm" disabled={busy} onClick={onConfirm}>
          {action}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
