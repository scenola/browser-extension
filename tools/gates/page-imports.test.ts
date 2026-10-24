/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The pages take the protocol's types and its two constants, never its validators:
// `.dependency-cruiser.cjs`'s pages-take-no-protocol, run on a fixture tree laid out like
// the app. The real tree is held to it by `pnpm lint`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cruise } from 'dependency-cruiser';
import extractDepcruiseConfig from 'dependency-cruiser/config-utl/extract-depcruise-config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WORKSPACE = fileURLToPath(new URL('../..', import.meta.url));
const SRC = 'apps/extension/src';
const RULE = 'pages-take-no-protocol';

const FILES: Readonly<Record<string, string>> = {
  [`${SRC}/messaging/constants.ts`]: 'export const PROTOCOL_VERSION = 1;\n',
  [`${SRC}/messaging/schemas.ts`]: 'export const SnapshotSchema = {};\n',
  [`${SRC}/messaging/protocol.ts`]:
    "export { PROTOCOL_VERSION } from './constants';\nexport interface PopupState { x: 1 }\n",
  // A page reading a constant from the protocol: refused.
  [`${SRC}/ui/store.ts`]:
    "import { PROTOCOL_VERSION } from '../messaging/protocol';\nvoid PROTOCOL_VERSION;\n",
  // An entrypoint reaching the schemas: refused.
  [`${SRC}/entrypoints/popup/main.ts`]:
    "import { SnapshotSchema } from '../../messaging/schemas';\nvoid SnapshotSchema;\n",
  // Types from the protocol, the constants from their module: allowed.
  [`${SRC}/ui/popup/Popup.ts`]:
    "import type { PopupState } from '../../messaging/protocol';\nimport { PROTOCOL_VERSION } from '../../messaging/constants';\nexport const v: PopupState | number = PROTOCOL_VERSION;\n",
  // The UI's tests and their harness drive the worker itself: exempt.
  [`${SRC}/ui/test-harness.ts`]:
    "import { PROTOCOL_VERSION } from '../messaging/protocol';\nvoid PROTOCOL_VERSION;\n",
  [`${SRC}/ui/popup/Popup.test.tsx`]:
    "import { PROTOCOL_VERSION } from '../../messaging/protocol';\nvoid PROTOCOL_VERSION;\n",
  // The worker validates: allowed.
  [`${SRC}/composition/root.ts`]:
    "import { SnapshotSchema } from '../messaging/schemas';\nvoid SnapshotSchema;\n",
};

let sandbox = '';
let violations: readonly string[] = [];

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'mt-page-imports-'));
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(sandbox, path)), { recursive: true });
    writeFileSync(join(sandbox, path), `// fixture\n${text}`);
  }
  const config = await extractDepcruiseConfig(join(WORKSPACE, '.dependency-cruiser.cjs'));
  const result = await cruise(['apps'], {
    ...config.options,
    ruleSet: config,
    validate: true,
    baseDir: sandbox,
    tsPreCompilationDeps: true,
  });
  if (typeof result.output === 'string') throw new Error('expected an object report');
  violations = result.output.summary.violations
    .filter((v) => v.rule.name === RULE)
    .map((v) => v.from)
    .sort();
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe(RULE, () => {
  it('refuses a page or a page entrypoint importing the protocol or the schemas as values', () => {
    expect(violations).toEqual([`${SRC}/entrypoints/popup/main.ts`, `${SRC}/ui/store.ts`]);
  });
});
