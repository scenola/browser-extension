/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule, { NOTICE_LINES } from './mpl-header.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const block = `/* ${NOTICE_LINES[0]}\n * ${NOTICE_LINES[1]}\n * ${NOTICE_LINES[2]} */\n`;
const lines = NOTICE_LINES.map((line) => `// ${line}\n`).join('');
const body = 'export const one = 1;\n';

const tester = new RuleTester();

tester.run('mpl-header', rule, {
  valid: [
    { code: `${block}\n${body}` },
    { code: `${lines}\n${body}` },
    { code: `${block}\n` },
    // The notice may be wrapped differently, as long as its words are the same.
    {
      code: `/*\n * This Source Code Form is subject to the terms of the Mozilla Public License,\n * v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at\n * https://mozilla.org/MPL/2.0/.\n */\n${body}`,
    },
  ],
  invalid: [
    {
      code: body,
      output: `${block}\n${body}`,
      errors: [{ message: 'MPL-2.0 notice missing' }],
    },
    {
      code: '',
      output: `${block}\n`,
      errors: [{ message: 'MPL-2.0 notice missing' }],
    },
    {
      code: `// unrelated comment\n${body}`,
      output: `${block}\n// unrelated comment\n${body}`,
      errors: [{ message: 'MPL-2.0 notice missing' }],
    },
    {
      // The notice is present but not first: a licence notice below code is not a header.
      code: `${body}${block}`,
      output: `${block}\n${body}${block}`,
      errors: [{ message: 'MPL-2.0 notice missing' }],
    },
    {
      code: `/* Copyright somebody. */\n${body}`,
      output: `${block}\n/* Copyright somebody. */\n${body}`,
      errors: [{ message: 'MPL-2.0 notice missing' }],
    },
  ],
});
