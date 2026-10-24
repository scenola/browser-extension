/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Exhibit A notice, as the three lines every source file opens with.
export const NOTICE_LINES = /** @type {const} */ ([
  'This Source Code Form is subject to the terms of the Mozilla Public',
  'License, v. 2.0. If a copy of the MPL was not distributed with this',
  'file, You can obtain one at https://mozilla.org/MPL/2.0/.',
]);

const HEADER = `/* ${NOTICE_LINES[0]}\n * ${NOTICE_LINES[1]}\n * ${NOTICE_LINES[2]} */\n\n`;

/** Words only: how a notice is wrapped or which comment style carries it does not matter. */
function words(/** @type {string[]} */ commentValues) {
  return commentValues
    .flatMap((value) => value.split('\n'))
    .map((line) => line.replace(/^\s*\*?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Require the MPL-2.0 Exhibit A notice at the top of a source file.' },
    fixable: 'code',
    schema: [],
    messages: { missing: 'MPL-2.0 notice missing' },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      Program() {
        const firstToken = sourceCode.ast.tokens[0];
        const leading = sourceCode
          .getAllComments()
          .filter(
            (comment) =>
              firstToken === undefined || (comment.range?.[1] ?? Infinity) <= firstToken.range[0],
          );
        const present = words(leading.map((comment) => comment.value)).startsWith(
          words([NOTICE_LINES.join('\n')]),
        );
        if (present) return;
        context.report({
          loc: { line: 1, column: 0 },
          messageId: 'missing',
          fix: (fixer) => fixer.insertTextBeforeRange([0, 0], HEADER),
        });
      },
    };
  },
};

export default rule;
