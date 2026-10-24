/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The fixture pages' own driver (site.ts, `window.e2e`), as the specs call it in the page.

export {};

declare global {
  interface Window {
    readonly e2e: {
      video(index?: number): HTMLVideoElement;
      play(index?: number, rate?: number): Promise<void>;
      watch(index?: number): Promise<void>;
      pause(index?: number): void;
      seek(seconds: number, index?: number): void;
      mute(index?: number): void;
      rate(rate: number, index?: number): void;
      ended(index?: number): Promise<void>;
      at(seconds: number, index?: number): Promise<void>;
      /** Netflix pages only: autoplay into `videoId` on the same element. */
      nextEpisode(videoId: number): Promise<void>;
      /** Netflix pages only: an in-app move to `/watch/<videoId><query>` on the same element. */
      nextTitle(videoId: number, query?: string): Promise<void>;
      /** Netflix's browse page only: Play — the billboard goes, the player mounts in place. */
      openPlayer(videoId: number, query?: string): void;
      /** Netflix pages only: the post-play screen. */
      showPostplay(): void;
    };
  }
}
