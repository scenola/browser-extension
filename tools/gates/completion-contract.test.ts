/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { buildPlay } from '../../packages/core/src/domain/play';
import { newViewing, reportVerdict } from '../../packages/core/src/domain/viewing';

// The backend repository is a sibling of this one: <parent>/extension/tools/gates -> <parent>/backend.
const PLAYS_MD = fileURLToPath(
  new URL('../../../backend/docs/integrations/plays.md', import.meta.url),
);
const present = existsSync(PLAYS_MD);

// The server counts a viewing at the account's finish line —
// a share of the story (`story_seconds`), measured by the story seconds played (`played_seconds`)
// — or at `ended: true`, which only says the title played out. The extension holds a play back by
// the same line, from the same numbers, so what it sends is what the server counts. This pins the
// server's half; the extension's is below.
describe('the completion contract with the backend', () => {
  test.skipIf(!present)(
    `plays.md counts a viewing at the account's line over the story, or at \`ended\` (${PLAYS_MD})`,
    async () => {
      const text = await readFile(PLAYS_MD, 'utf8');
      const rules = [
        /it counts once the measure reaches `ceil\(finish_threshold_percent\s*\*\s*base \/ 100\)`, or at `ended: true`/u,
        /The \*\*base\*\* is `story_seconds` when you\s+send it, else `duration_seconds`/u,
        /the \*\*measure\*\* is `played_seconds` when you\s+send it, else `furthest_position_seconds`/u,
      ];
      for (const rule of rules) {
        expect(
          rule.test(text),
          `plays.md no longer says ${String(rule)}: the extension's hold-back line would stop ` +
            'being the line the server counts by',
        ).toBe(true);
      }
    },
  );

  test.skipIf(present)(`backend repo not found at ${PLAYS_MD}: contract not checked`, () => {
    // Skipped on purpose when the sibling backend checkout is absent.
  });

  test('a viewing is sent at the line, before its story ends, with its numbers, and not `ended`', () => {
    const fresh = newViewing({
      id: 'v1',
      serviceId: null,
      reading: { kind: 'movie', title: 'Film', year: 2000, sources: ['module'] },
      at: 0,
      incognito: false,
    });
    if (fresh === null) throw new Error('expected a viewing');
    // 1000 s: the story ends at the credits estimate, 880 s; played from the start to 792 s:
    // exactly the 90 % line, ceil(0.9 × 880), with the credits still ahead.
    const v = {
      ...fresh,
      durationSeconds: 1000,
      ranges: [[0, 792] as const],
      engaged: true,
    };
    expect(reportVerdict(v, 90).kind).toBe('report');
    expect(reportVerdict({ ...v, ranges: [[0, 791]] }, 90).kind).toBe('wait');
    expect(buildPlay(v, 1, 0)).toMatchObject({
      story_seconds: 880,
      played_seconds: 792,
      furthest_position_seconds: 792,
      ended: false,
    });
  });
});
