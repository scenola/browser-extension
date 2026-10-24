/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';
import type { PlaybackSample } from './coverage';
import { electFrame } from './frames';
import type { FrameReport } from './frames';
import type { ServiceReading } from './reading';

const sample = (over: Partial<PlaybackSample> = {}): PlaybackSample => ({
  at: 0,
  position: 10,
  duration: 3600,
  paused: false,
  ended: false,
  rate: 1,
  adPlaying: false,
  muted: false,
  visibleArea: 0.5,
  ...over,
});

const frame = (over: Partial<FrameReport> & { frameId: number }): FrameReport => ({
  isTop: false,
  sample: null,
  reading: null,
  generic: [],
  ...over,
});

const mod = <T>(value: T) => ({ value, confidence: 1, source: 'module' as const });
const gen = (title: string, confidence = 0.8): ServiceReading => ({
  title: { value: title, confidence, source: 'json-ld' },
});

test('an iframe player takes the title from the top frame module reading', () => {
  const elected = electFrame([
    frame({ frameId: 0, isTop: true, reading: { title: mod('Dune') } }),
    frame({ frameId: 7, sample: sample({ visibleArea: 0.6 }) }),
  ]);
  expect(elected?.player.frameId).toBe(7);
  expect(elected?.reading.title).toBe('Dune');
});

test('the player module reading wins per field over the top frame', () => {
  const elected = electFrame([
    frame({ frameId: 0, isTop: true, reading: { title: mod('Top'), year: mod(2001) } }),
    frame({ frameId: 3, sample: sample(), reading: { title: mod('Player') } }),
  ]);
  expect(elected?.reading).toMatchObject({ title: 'Player', year: 2001 });
});

test('generic readings of every frame are merged in', () => {
  const elected = electFrame([
    frame({ frameId: 0, isTop: true, generic: [gen('From top page')] }),
    frame({ frameId: 2, sample: sample(), generic: [gen('From frame', 0.4)] }),
  ]);
  expect(elected?.reading.title).toBe('From top page');
});

test('an unmuted player beats a larger muted autoplay preview', () => {
  const elected = electFrame([
    frame({ frameId: 0, isTop: true, sample: sample({ visibleArea: 1, muted: true }) }),
    frame({ frameId: 9, sample: sample({ visibleArea: 0.3, muted: false }) }),
  ]);
  expect(elected?.player.frameId).toBe(9);
});

test('among muted frames only, the larger still wins', () => {
  const elected = electFrame([
    frame({ frameId: 1, sample: sample({ visibleArea: 0.2, muted: true }) }),
    frame({ frameId: 2, sample: sample({ visibleArea: 0.8, muted: true }) }),
  ]);
  expect(elected?.player.frameId).toBe(2);
});

test('two playing videos: the larger wins', () => {
  const elected = electFrame([
    frame({ frameId: 1, sample: sample({ visibleArea: 0.2 }) }),
    frame({ frameId: 2, sample: sample({ visibleArea: 0.9 }) }),
  ]);
  expect(elected?.player.frameId).toBe(2);
});

test('a tie goes to the top frame, then the lowest frame id', () => {
  const tied = [
    frame({ frameId: 5, sample: sample() }),
    frame({ frameId: 2, sample: sample() }),
    frame({ frameId: 0, isTop: true, sample: sample() }),
  ];
  expect(electFrame(tied)?.player.frameId).toBe(0);
  expect(electFrame(tied.filter((f) => !f.isTop))?.player.frameId).toBe(2);
});

test('a paused or ended video is not the player; a larger paused one does not win', () => {
  const elected = electFrame([
    frame({ frameId: 1, sample: sample({ visibleArea: 1, paused: true }) }),
    frame({ frameId: 2, sample: sample({ visibleArea: 1, ended: true }) }),
    frame({ frameId: 3, sample: sample({ visibleArea: 0.1 }) }),
  ]);
  expect(elected?.player.frameId).toBe(3);
});

test('no playing sample is null', () => {
  expect(electFrame([])).toBeNull();
  expect(electFrame([frame({ frameId: 0, isTop: true, reading: { title: mod('x') } })])).toBeNull();
  expect(electFrame([frame({ frameId: 1, sample: sample({ paused: true }) })])).toBeNull();
});

test('includeStopped: a paused or ended player is elected by the same order', () => {
  const frames = [
    frame({ frameId: 0, isTop: true, reading: { title: mod('Dune') } }),
    frame({ frameId: 1, sample: sample({ visibleArea: 0.2, ended: true, muted: true }) }),
    frame({ frameId: 2, sample: sample({ visibleArea: 0.1, ended: true, paused: true }) }),
  ];
  expect(electFrame(frames)).toBeNull();
  const elected = electFrame(frames, { includeStopped: true });
  expect(elected?.player.frameId).toBe(2);
  expect(elected?.reading.title).toBe('Dune');
  expect(electFrame([frame({ frameId: 0, isTop: true })], { includeStopped: true })).toBeNull();
});

test('the player alone, with no top frame in the report', () => {
  const elected = electFrame([
    frame({ frameId: 4, sample: sample(), reading: { title: mod('A') } }),
  ]);
  expect(elected?.reading.title).toBe('A');
});

test('the input is not reordered or mutated', () => {
  const frames = [frame({ frameId: 2, sample: sample() }), frame({ frameId: 1, sample: sample() })];
  const copy = [...frames];
  electFrame(frames);
  expect(frames).toEqual(copy);
});
