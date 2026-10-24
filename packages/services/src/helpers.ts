/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Field } from '@mt/core';

export { normalizeTitle, parseEpisodeLabel, parseEpisodeOnlyLabel } from '@mt/core';

/**
 * The API's bounds on a play, as the play constructor applies
 * them: a module clamps its reading to these rather than to a copy of the numbers.
 * `clampTitle` trims and keeps at most 200 code points; `isYear` is 1870–2200.
 */
export { EPISODE_NUMBER_MAX, MAX_SECONDS, SEASON_NUMBER_MAX, clampTitle, isYear } from '@mt/core';

/**
 * The shortest media that is content. A stated length wins over the element's,
 * so a module never states one below it: a viewing of that length is never reported.
 */
export { MIN_CONTENT_SECONDS } from '@mt/core';

/** A module's reading of one field. `confidence` is within [0, 1]; anything else throws. */
export function field<T>(value: T, confidence: number): Field<T> {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError(`confidence must be within [0, 1], got ${String(confidence)}`);
  }
  return { value, confidence, source: 'module' };
}

const MAX_JSON_PATH = 16;

/**
 * The value at `path` inside page-state JSON, or `undefined`. A module may not index an
 * object with a key it computed; this is how it reads, say, the entry of a video
 * id. It reads own data properties of plain objects and whole-number indices of arrays
 * only: never an inherited member, an accessor, or a class instance's fields.
 */
export function jsonAt(value: unknown, path: readonly (string | number)[]): unknown {
  if (path.length > MAX_JSON_PATH) return undefined;
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    if (Array.isArray(current)) {
      const items: readonly unknown[] = current;
      if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key >= items.length) {
        return undefined;
      }
      current = items[key];
      continue;
    }
    if (typeof key !== 'string') return undefined;
    const proto: unknown = Object.getPrototypeOf(current);
    if (proto !== null && Object.getPrototypeOf(proto) !== null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    current = descriptor.value;
  }
  return current;
}
