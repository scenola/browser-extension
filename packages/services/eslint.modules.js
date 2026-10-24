/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The modules' lint guard rail, imported by the root eslint.config.js.
//
// A service module runs in a sandboxed page with no network, no `chrome.*` and no page:
// that sandbox is the boundary, and nothing here claims to stop an attacker. These rules
// turn the accidents — and the obvious escapes — into lint errors, so a module that tries
// one is conspicuous in review. src/guard-rails.test.ts proves each rule fires on a file in
// test/forbidden/ and stays quiet on test/control/.

import ts from 'typescript';

/** Where modules live, and the guard rails' own specimens and control. */
const MODULE_FILES = [
  'packages/services/src/services/**/*.ts',
  'packages/services/test/forbidden/**/*.ts',
  'packages/services/test/control/**/*.ts',
];

/** The specimens must fail; only src/guard-rails.test.ts lints them (`ignore: false`). */
const SPECIMENS = 'packages/services/test/forbidden/**';

/** The value globals a module may name. `undefined` is not a capability. */
const ALLOWED_GLOBALS = [
  'Math',
  'Number',
  'String',
  'JSON',
  'RegExp',
  'Array',
  'Object',
  'Date',
  'undefined',
];

/**
 * Every other value global the ES2023 library and ESLint's ES2023 environment declare.
 * The globals outside them (`document`, `fetch`, `chrome`, Node's) are `no-undef` errors.
 * src/guard-rails.test.ts reads the globals a module file can see from ESLint's own scope
 * analysis and fails on one that is neither allowed nor listed here.
 */
const RESTRICTED_GLOBALS = [
  // Code from text, and the global object itself.
  'eval',
  'Function',
  'globalThis',
  // Concurrency, reflection, memory: nothing a pure reading of a snapshot needs.
  'Promise',
  'Proxy',
  'Reflect',
  'Symbol',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'FinalizationRegistry',
  'Atomics',
  'SharedArrayBuffer',
  'ArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'Map',
  'Set',
  'BigInt',
  'Boolean',
  'Intl',
  // Errors: `interpret` answers `null` rather than throwing.
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  // Functions on the global object; Number and String have the parsing ones.
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'unescape',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'Infinity',
  'NaN',
  // The global object's inherited members, which a bare name reaches: `constructor` leads
  // to Function as surely as `globalThis.constructor` does.
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
];

const GLOBALS_MESSAGE = `services-globals: a module sees only ${ALLOWED_GLOBALS.slice(0, -1).join(
  ', ',
)}; it is pure and runs in a sandbox.`;

const PROTOTYPE_MESSAGE =
  'services-prototype: a module reads data, not the prototype chain, which leads to Function.';

/** @typedef {import('eslint').Rule.Node} Node */

/** @param {Node} node */
const isLiteralKey = (node) =>
  node.type === 'Literal' || (node.type === 'TemplateLiteral' && node.expressions.length === 0);

/**
 * @param {import('typescript').Type} type
 * @param {(part: import('typescript').Type) => boolean} test
 */
const everyPart = (type, test) => (type.isUnion() ? type.types.every(test) : test(type));

/**
 * A key the code computes can name anything an object holds, its prototype's members
 * included (`value[key]` with `key = "constructor"`). Allowed: a literal key, and a
 * number-typed key into an array, a tuple or a string. A module reads an object by a
 * computed key through `jsonAt` (src/helpers.ts), which reads own data only.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const computedAccess = {
  meta: {
    type: 'problem',
    docs: { description: 'Refuse computed member access with a non-literal key on an object.' },
    schema: [],
    messages: {
      computed:
        'services-computed-access: a computed key may index only an array or a string by a number; read an object with jsonAt.',
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (services?.program == null || services.esTreeNodeToTSNodeMap == null) {
      throw new Error(
        'services/computed-access needs type information (parserOptions.projectService)',
      );
    }
    const checker = services.program.getTypeChecker();
    /** @param {Node} node */
    const typeOf = (node) =>
      checker.getNonNullableType(
        checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node)),
      );
    /** @param {Node} node */
    const isNumber = (node) =>
      everyPart(typeOf(node), (part) => (part.flags & ts.TypeFlags.NumberLike) !== 0);
    /** @param {Node} node */
    const isIndexable = (node) =>
      everyPart(
        typeOf(node),
        (part) =>
          checker.isArrayType(part) ||
          checker.isTupleType(part) ||
          (part.flags & ts.TypeFlags.StringLike) !== 0,
      );
    return {
      MemberExpression(node) {
        if (!node.computed || isLiteralKey(node.property)) return;
        if (node.object.type !== 'Super' && isNumber(node.property) && isIndexable(node.object)) {
          return;
        }
        context.report({ node: node.property, messageId: 'computed' });
      },
      'ObjectPattern > Property[computed=true]'(node) {
        if (!isLiteralKey(node.key)) context.report({ node: node.key, messageId: 'computed' });
      },
    };
  },
};

/** @type {import('eslint').Linter.Config[]} */
export const servicesModulesConfig = [
  { ignores: [SPECIMENS] },
  {
    files: MODULE_FILES,
    // `/* eslint-disable */` in a module changes nothing.
    linterOptions: { noInlineConfig: true },
    languageOptions: {
      ecmaVersion: 2023,
      // The scope analysis's globals, pinned: a DOM `lib` in a tsconfig cannot reach here.
      parserOptions: { lib: ['es2023'] },
    },
    plugins: { services: { rules: { 'computed-access': computedAccess } } },
    rules: {
      'no-undef': ['error', { typeof: true }],
      'no-restricted-globals': [
        'error',
        ...RESTRICTED_GLOBALS.map((name) => ({ name, message: GLOBALS_MESSAGE })),
      ],
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'services-dynamic-import: a module loads no code at run time.',
        },
        {
          selector: 'TSAsExpression > TSAnyKeyword.typeAnnotation',
          message: 'services-any: `as any` switches the compiler off; narrow the value.',
        },
        {
          selector: 'TSTypeAssertion > TSAnyKeyword.typeAnnotation',
          message: 'services-any: `<any>` switches the compiler off; narrow the value.',
        },
      ],
      'no-restricted-properties': [
        'error',
        { property: 'constructor', message: PROTOTYPE_MESSAGE },
        { property: '__proto__', message: PROTOTYPE_MESSAGE },
        ...[
          'getPrototypeOf',
          'setPrototypeOf',
          'getOwnPropertyDescriptor',
          'getOwnPropertyDescriptors',
          'defineProperty',
          'defineProperties',
        ].map((property) => ({ object: 'Object', property, message: PROTOTYPE_MESSAGE })),
      ],
      'services/computed-access': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // `@ts-nocheck` and friends would switch tsconfig.modules.json off for a file.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-check': false, 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true },
      ],
    },
  },
];
