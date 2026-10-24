/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// One choice of a few, all in view: a capsule of capsules, the chosen one filled with the primary
// ink. To assistive technology it is a radio group (WAI-ARIA's pattern): one tab stop, the arrow
// keys move the choice, and the choice is `aria-checked` as well as a fill. Named by the row it
// sits in.

import type { TargetedKeyboardEvent } from 'preact';

export interface Choice<T> {
  readonly value: T;
  readonly label: string;
}

/** The arrow keys' steps through the choices, in reading order. */
const STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

const SEGMENT =
  'min-h-7 rounded-full px-3 text-body-s font-medium whitespace-nowrap select-none ' +
  'transition-colors duration-state ease-app disabled:opacity-50';

export function Segmented<T extends string | number>({
  choices,
  value,
  onChoose,
  labelledBy,
  describedBy,
  disabled = false,
}: {
  readonly choices: readonly Choice<T>[];
  readonly value: T | null;
  readonly onChoose: (value: T) => void;
  readonly labelledBy: string;
  readonly describedBy?: string;
  readonly disabled?: boolean;
}) {
  const chosen = choices.findIndex((choice) => choice.value === value);
  // With nothing chosen yet, the first choice is the group's tab stop.
  const tabStop = chosen === -1 ? 0 : chosen;

  const move = (event: TargetedKeyboardEvent<HTMLButtonElement>, from: number): void => {
    const step = STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    // Left and right follow the page's direction: in a right-to-left page, left is forward.
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const across = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const to = (from + (rtl && across ? -step : step) + choices.length) % choices.length;
    const target = choices[to];
    if (target === undefined) return;
    (event.currentTarget.parentElement?.children[to] as HTMLElement | undefined)?.focus();
    onChoose(target.value);
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      class="inline-flex shrink-0 rounded-full bg-secondary p-0.5"
    >
      {choices.map((choice, index) => {
        const checked = index === chosen;
        return (
          <button
            key={String(choice.value)}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              if (!checked) onChoose(choice.value);
            }}
            onKeyDown={(event) => {
              move(event, index);
            }}
            class={`${SEGMENT} ${checked ? 'bg-primary text-primary-foreground' : 'text-secondary-foreground hover:bg-accent'}`}
          >
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}
