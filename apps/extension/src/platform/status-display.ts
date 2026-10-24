/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The toolbar icon (core's `StatusDisplay`): the mark, the badge and the tooltip, for one tab or
// as every tab's default. The tooltip always says the state in words; the badge is never the
// only carrier of meaning. A tab that closed meanwhile is not an error.

import type { Status, StatusDisplay } from '@mt/core';
import type { Browser } from 'wxt/browser';

import { tCore } from '../i18n/worker-words';

type Action = Pick<
  typeof Browser.action,
  'setIcon' | 'setBadgeText' | 'setBadgeBackgroundColor' | 'setBadgeTextColor' | 'setTitle'
>;

const MARK: Readonly<Record<Status['icon'], string>> = {
  outline: 'mark-outline',
  recording: 'mark-recording',
  'filled-check': 'mark-check',
  dimmed: 'mark-dimmed',
};

/** The toolbar's sizes (the manifest's `action.default_icon`, build/manifest.ts). */
const SIZES = [16, 24, 32] as const;

/**
 * The badge cannot read CSS: these are the Projection tokens (src/ui/tokens.css) in sRGB — the
 * lamp of the dark room with the room's ink on it, and the paper's destructive red with white,
 * the pairs that hold contrast on the toolbar.
 */
interface BadgeColours {
  readonly background: string;
  readonly text: string;
}

const BADGE: Readonly<Record<'lamp' | 'danger', BadgeColours>> = {
  lamp: { background: '#eec474', text: '#0f0d0b' },
  danger: { background: '#cc272b', text: '#ffffff' },
};

function iconPaths(icon: Status['icon']): Record<string, string> {
  const mark = MARK[icon];
  return Object.fromEntries(
    SIZES.map((size) => [String(size), `icons/${mark}-${String(size)}.png`]),
  );
}

/** What one target (a tab, or every tab's default) shows, as last set. */
interface Shown {
  readonly icon: Status['icon'];
  readonly badgeText: string;
  readonly badgeTone: 'lamp' | 'danger' | null;
  readonly title: string;
}

/** Tabs whose shown state is remembered; past it the oldest is forgotten (and set in full). */
const MAX_REMEMBERED = 1024;

/**
 * Only what changed is set: the status is refreshed after every observation, and a service
 * worker's `setIcon(path)` fetches and decodes the PNGs each time. What a target shows is
 * remembered in memory — a restarted worker sets everything once — and a tab's is forgotten when
 * Chrome resets it: when the tab loads another page or closes (`forget`, wired in
 * background.ts). A show that failed is forgotten too, so the next one sets everything again.
 */
export class ActionStatusDisplay implements StatusDisplay {
  readonly #action: Action;
  readonly #shown = new Map<number | null, Shown>();

  constructor(action: Action) {
    this.#action = action;
  }

  /** The tab's own icon, badge and tooltip were reset by Chrome (a new page) or it closed. */
  forget(tabId: number): void {
    this.#shown.delete(tabId);
  }

  async show(tabId: number | null, s: Status): Promise<void> {
    const target = tabId === null ? {} : { tabId };
    const next: Shown = {
      icon: s.icon,
      badgeText: s.badge?.text ?? '',
      badgeTone: s.badge?.tone ?? null,
      title: await tCore(s.tooltip.key, s.tooltip.params),
    };
    const last = this.#shown.get(tabId);
    // Forgotten until it has all been set: a failure part-way leaves nothing to trust.
    this.#shown.delete(tabId);
    try {
      if (last?.icon !== next.icon) {
        await this.#action.setIcon({ ...target, path: iconPaths(next.icon) });
      }
      if (last?.badgeText !== next.badgeText) {
        await this.#action.setBadgeText({ ...target, text: next.badgeText });
      }
      if (next.badgeTone !== null && last?.badgeTone !== next.badgeTone) {
        const colours = BADGE[next.badgeTone];
        await this.#action.setBadgeBackgroundColor({ ...target, color: colours.background });
        await this.#action.setBadgeTextColor({ ...target, color: colours.text });
      }
      if (last?.title !== next.title) await this.#action.setTitle({ ...target, title: next.title });
    } catch (error: unknown) {
      // A tab closed between the observation and the update has nothing left to show on.
      if (tabId === null) throw error;
      return;
    }
    this.#shown.set(tabId, next);
    if (this.#shown.size > MAX_REMEMBERED) {
      const oldest = this.#shown.keys().next().value;
      if (oldest !== undefined) this.#shown.delete(oldest);
    }
  }
}
