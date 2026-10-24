/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Every control is a capsule (the web app's `Button`): `primary` is the filled ink — one per
// card or screen — `secondary` a quiet fill, `ghost` nothing until hovered, `danger` the one
// destructive act. A press scales a little; a disabled control says so to assistive technology
// and keeps its place.

import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: 'bg-primary text-primary-foreground hover:opacity-90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
  ghost: 'text-foreground hover:bg-secondary',
  // The theme's inverse ink on the red: 5.7:1 dark, 5.0:1 light. The tokens' own
  // destructive-foreground clears only 3.1:1 on the dark red.
  danger: 'bg-destructive text-primary-foreground hover:opacity-90',
};

const SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: 'min-h-8 px-3 text-body-s gap-1.5',
  md: 'min-h-10 px-4 text-body-s gap-2',
  lg: 'min-h-12 px-6 text-body gap-2',
};

/** The shared shape: a capsule, the press, the disabled look. */
const CAPSULE =
  'inline-flex shrink-0 items-center justify-center rounded-full font-medium whitespace-nowrap select-none ' +
  'transition-[background-color,opacity,scale] duration-state ease-app active:scale-[0.97] ' +
  'disabled:pointer-events-none disabled:opacity-50';

type NativeButton = Omit<ButtonHTMLAttributes, 'size' | 'class' | 'className'>;

export function Button({
  variant = 'secondary',
  size = 'md',
  class: className = '',
  type = 'button',
  children,
  ...rest
}: NativeButton & {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly class?: string;
  readonly children?: ComponentChildren;
}) {
  return (
    <button
      {...rest}
      type={type}
      class={`${CAPSULE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    >
      {children}
    </button>
  );
}

/** A round control that is only a glyph: its words are its `label`, said and shown on hover. */
export function IconButton({
  label,
  class: className = '',
  children,
  ...rest
}: Omit<NativeButton, 'aria-label' | 'title'> & {
  readonly label: string;
  readonly class?: string;
  readonly children: ComponentChildren;
}) {
  return (
    <button
      {...rest}
      type="button"
      aria-label={label}
      title={label}
      class={`${CAPSULE} size-9 text-foreground hover:bg-secondary ${className}`}
    >
      {children}
    </button>
  );
}
