/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The welcome page, opened once, on install: three steps, each one screen — Connect,
// Where to track, Done. The steps are a sequence, so they are numbered; the heading of each new
// step takes the focus, so a screen reader hears where it is.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { t } from '../../i18n/t';
import { Mark } from '../components/Icon';
import type { UiAsk, UiConnection } from '../store';
import { StepConnect } from './StepConnect';
import { StepDone } from './StepDone';
import { StepWhere } from './StepWhere';

type Step = 1 | 2 | 3;
const STEPS: readonly Step[] = [1, 2, 3];

export function Welcome({ ui }: { readonly ui: UiConnection }) {
  const [step, setStep] = useState<Step>(1);
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  const send = useCallback((ask: UiAsk) => ui.send(ask), [ui]);
  const connection = ui.state.value?.connection ?? null;

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.querySelector<HTMLElement>('h1')?.focus();
  }, [step]);

  return (
    <div class="min-h-dvh bg-background">
      <header class="mx-auto flex max-w-[44rem] items-center gap-2.5 px-6 pt-8">
        <Mark size={24} />
        <span class="font-display text-display-s font-semibold tracking-[-0.01em]">
          {t('common.extension')}
        </span>
      </header>

      <main ref={main} class="mx-auto max-w-[44rem] px-6 pt-[10vh] pb-16 [&_h1]:outline-none">
        <nav aria-label={t('welcome.steps_label')} class="mb-6">
          <p class="text-body-s font-medium text-muted-foreground">
            {t('welcome.step_of', { step, total: STEPS.length })}
          </p>
          <ol class="mt-2 flex gap-1.5" aria-hidden="true">
            {STEPS.map((n) => (
              <li
                key={n}
                class={`h-1 w-10 rounded-full transition-colors duration-open ease-app ${n <= step ? 'bg-primary' : 'bg-border'}`}
              />
            ))}
          </ol>
        </nav>

        <div key={step}>
          {step === 1 ? (
            <StepConnect
              connection={connection}
              send={send}
              onDone={() => {
                setStep(2);
              }}
            />
          ) : step === 2 ? (
            <StepWhere
              onDone={() => {
                setStep(3);
              }}
              onBack={() => {
                setStep(1);
              }}
            />
          ) : (
            <StepDone
              onBack={() => {
                setStep(2);
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}
