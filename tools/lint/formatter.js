/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The ESLint formatter `pnpm lint` uses: ESLint's own `stylish` output and, under GitHub
// Actions, one workflow command per problem as well. A readability warning does not fail the
// run, so without the command it would sit unread in the log; with it, it shows on the line
// that raised it in the pull request's diff.

import { relative, sep } from 'node:path';

import { ESLint } from 'eslint';

/** A workflow command's message, escaped as the runner reads it back. */
const escapeData = (/** @type {string} */ value) =>
  value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

/** A workflow command's property, where `:` and `,` also separate. */
const escapeProperty = (/** @type {string} */ value) =>
  escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');

/**
 * One `::error` or `::warning` command per problem, its file relative to `cwd`.
 * @param {import('eslint').ESLint.LintResult[]} results
 * @param {string} cwd
 */
export function annotations(results, cwd) {
  return results.flatMap((result) => {
    const file = relative(cwd, result.filePath).split(sep).join('/');
    return result.messages.map((message) => {
      const level = message.severity === 2 ? 'error' : 'warning';
      const where = [`file=${escapeProperty(file)}`];
      if (message.line > 0) where.push(`line=${message.line}`, `col=${message.column}`);
      where.push(`title=${escapeProperty(message.ruleId ?? 'eslint')}`);
      return `::${level} ${where.join(',')}::${escapeData(message.message)}`;
    });
  });
}

/** @type {import('eslint').ESLint.FormatterFunction} */
export default async function format(results, context) {
  const stylish = await new ESLint({ cwd: context.cwd }).loadFormatter('stylish');
  const text = await stylish.format(results, context);
  if (process.env.GITHUB_ACTIONS !== 'true') return text;
  return [text, ...annotations(results, context.cwd)].filter(Boolean).join('\n');
}
