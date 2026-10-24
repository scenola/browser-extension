/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A `<video>` in happy-dom with the state a real one reports. happy-dom lays nothing out and plays
// nothing, so its box and its media state are set on the element itself (own properties shadow
// the prototype's getters).

export interface VideoState {
  readonly width: number;
  readonly height: number;
  readonly left?: number;
  readonly top?: number;
  readonly paused?: boolean;
  readonly ended?: boolean;
  readonly muted?: boolean;
  readonly volume?: number;
  readonly duration?: number;
  readonly currentTime?: number;
  readonly playbackRate?: number;
}

/** Sets (or changes) the element's state; anything not given keeps its value. */
export function setVideo(video: HTMLVideoElement, state: Partial<VideoState>): void {
  const define = (name: string, value: unknown): void => {
    Object.defineProperty(video, name, { value, configurable: true, writable: true });
  };
  for (const name of [
    'paused',
    'ended',
    'muted',
    'volume',
    'duration',
    'currentTime',
    'playbackRate',
  ] as const) {
    if (state[name] !== undefined) define(name, state[name]);
  }
  if (state.width !== undefined || state.height !== undefined) {
    const left = state.left ?? 0;
    const top = state.top ?? 0;
    const width = state.width ?? 0;
    const height = state.height ?? 0;
    define('getBoundingClientRect', () => ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    }));
  }
}

/** A video in `doc`'s body with `state` (paused, unmuted, volume 1 unless said). */
export function addVideo(doc: Document, state: VideoState): HTMLVideoElement {
  const video = doc.createElement('video');
  doc.body.append(video);
  setVideo(video, { paused: true, ended: false, muted: false, volume: 1, ...state });
  return video;
}

/** The frame's viewport, as a layout-less happy-dom window reports it. */
export function setViewport(view: Window, width: number, height: number): void {
  Object.defineProperty(view, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(view, 'innerHeight', { value: height, configurable: true });
}
