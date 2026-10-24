/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// Which video of a frame is the one being watched: the largest visible one that is playing. The
// election sticks to the element that played with sound, even when paused, and a playing muted
// preview never takes over.

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { addVideo, setVideo, setViewport } from '../testing/video';
import { electVideo, forgetSounded } from './election';

/** A muted 320×180 autoplay preview, playing, at the side of the page. */
const PREVIEW = {
  width: 320,
  height: 180,
  left: 1500,
  paused: false,
  muted: true,
  currentTime: 4,
} as const;

beforeEach(() => {
  setViewport(window, 1920, 1080);
});

afterEach(() => {
  forgetSounded();
  document.body.replaceChildren();
});

describe('electVideo', () => {
  test('a visible playing 1280×720 video beats a muted 320×180 autoplay preview', () => {
    const preview = addVideo(document, PREVIEW);
    const film = addVideo(document, { width: 1280, height: 720, paused: false, currentTime: 600 });
    expect(electVideo(document)).toBe(film);
    expect(electVideo(document)).not.toBe(preview);
  });

  // the same, with the preview first in the document and larger in score order of appearance
  test('document order does not decide it', () => {
    const film = addVideo(document, { width: 1280, height: 720, paused: false, currentTime: 600 });
    addVideo(document, PREVIEW);
    expect(electVideo(document)).toBe(film);
  });

  // An element that played with sound stays elected while it is in the document, even when
  // paused. A playing muted preview beside it never takes over.
  test('after playing with sound, a paused film stays elected over a playing muted preview', () => {
    const film = addVideo(document, { width: 1280, height: 720, paused: false, currentTime: 600 });
    expect(electVideo(document)).toBe(film);
    setVideo(film, { paused: true });
    addVideo(document, { width: 1600, height: 900, paused: false, muted: true, currentTime: 2 });
    expect(electVideo(document)).toBe(film);
  });

  // Even when the preview is larger than the film.
  test('a larger muted preview never takes over from the film that played with sound', () => {
    const film = addVideo(document, { width: 640, height: 360, paused: false, currentTime: 60 });
    expect(electVideo(document)).toBe(film);
    setVideo(film, { muted: true });
    addVideo(document, { width: 1920, height: 1080, paused: false, muted: true, currentTime: 1 });
    expect(electVideo(document)).toBe(film);
  });

  // The stickiness lasts only while the element is in the document.
  test('once removed from the document, it is no longer elected', () => {
    const film = addVideo(document, { width: 1280, height: 720, paused: false, currentTime: 600 });
    expect(electVideo(document)).toBe(film);
    film.remove();
    const preview = addVideo(document, { ...PREVIEW, left: 0, currentTime: 1 });
    expect(electVideo(document)).not.toBe(film);
    expect(electVideo(document)).toBe(preview);
  });

  test('of two playing with sound, the larger visible one wins', () => {
    addVideo(document, { width: 480, height: 270, paused: false, currentTime: 30 });
    const large = addVideo(document, {
      width: 1280,
      height: 720,
      left: 500,
      paused: false,
      currentTime: 30,
    });
    expect(electVideo(document)).toBe(large);
  });

  // A hidden element is not the player.
  test('a hidden video is not elected', () => {
    const hidden = addVideo(document, {
      width: 1920,
      height: 1080,
      paused: false,
      currentTime: 30,
    });
    hidden.style.display = 'none';
    const shown = addVideo(document, { width: 640, height: 360, paused: false, currentTime: 30 });
    expect(electVideo(document)).toBe(shown);
  });

  // A reader is total — a page with no video gives no video
  test('a page without a video elects nothing', () => {
    expect(electVideo(document)).toBeNull();
  });
});
