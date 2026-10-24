/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path';

import type { ESLint, Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

import { annotations } from './formatter.js';

const CWD = join('/', 'repo');

function result(file: string, messages: Partial<Linter.LintMessage>[]): ESLint.LintResult {
  return {
    filePath: join(CWD, file),
    messages: messages.map((m) => ({
      ruleId: null,
      severity: 1,
      message: '',
      line: 0,
      column: 0,
      ...m,
    })),
    suppressedMessages: [],
    errorCount: 0,
    fatalErrorCount: 0,
    warningCount: 0,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
    usedDeprecatedRules: [],
  };
}

describe('lint problems as GitHub workflow commands', () => {
  it('a warning and an error, each on its line, titled by its rule', () => {
    const lines = annotations(
      [
        result('packages/core/src/a.ts', [
          { ruleId: 'complexity', severity: 1, message: 'Too complex.', line: 3, column: 8 },
          { ruleId: 'no-undef', severity: 2, message: 'Undefined.', line: 9, column: 1 },
        ]),
      ],
      CWD,
    );
    expect(lines).toEqual([
      '::warning file=packages/core/src/a.ts,line=3,col=8,title=complexity::Too complex.',
      '::error file=packages/core/src/a.ts,line=9,col=1,title=no-undef::Undefined.',
    ]);
  });

  it('escapes what the runner would read as a separator or the end of the command', () => {
    const [line] = annotations(
      [result('a,b.ts', [{ ruleId: 'x:y', message: '100% sure\nnext line' }])],
      CWD,
    );
    expect(line).toBe('::warning file=a%2Cb.ts,title=x%3Ay::100%25 sure%0Anext line');
  });

  it('a problem with no line or rule names the file and ESLint', () => {
    const [line] = annotations([result('a.ts', [{ message: 'Parsing error.' }])], CWD);
    expect(line).toBe('::warning file=a.ts,title=eslint::Parsing error.');
  });

  it('a clean file says nothing', () => {
    expect(annotations([result('a.ts', [])], CWD)).toEqual([]);
  });
});
