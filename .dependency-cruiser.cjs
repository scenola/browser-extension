/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The layers of the workspace. apps/extension -> {api, services, core}; api -> core;
// services -> core; core imports nothing of ours.
//
// Every `to.path` below matches two spellings of the same import: the resolved path
// (`packages/api/...`, when the package is linked) and the bare specifier (`@mt/api`),
// which is what depcruise reports when pnpm has not linked it because the importing
// package never declared it. A rule that only knew the first spelling would stay green
// on exactly the undeclared import it exists to catch.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'core-is-pure',
      comment: 'packages/core imports nothing of ours.',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^((packages/(api|services)|apps)/|@mt/(api|services|extension)(/|$))' },
    },
    {
      name: 'core-no-chrome',
      comment:
        'packages/core takes no browser-extension runtime. A bare `chrome` global is the same rule in ESLint (tools/lint/core-purity.js).',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: {
        path: '((^|/)node_modules/|^)(@types/chrome|chrome|webextension-polyfill|wxt)(/|$)',
      },
    },
    {
      name: 'api-only-core',
      comment: 'packages/api may import packages/core and nothing else of ours.',
      severity: 'error',
      from: { path: '^packages/api/' },
      to: { path: '^((packages/services|apps)/|@mt/(services|extension)(/|$))' },
    },
    {
      name: 'services-only-core',
      comment: 'packages/services may import packages/core and nothing else of ours.',
      severity: 'error',
      from: { path: '^packages/services/' },
      to: { path: '^((packages/api|apps)/|@mt/(api|extension)(/|$))' },
    },
    {
      name: 'no-unresolvable-in-packages',
      comment:
        'An import in packages/ that cannot be resolved is undeclared or misspelled; it must not hide from the layer rules.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { couldNotResolve: true },
    },
    {
      name: 'runtime-takes-no-module-code',
      comment:
        "Service-module code runs only in the interpretation sandbox's worker: importing @mt/services runs every module file, so nothing the extension ships may import it — the service worker, the content scripts and the pages, the sandbox page included, read the registry as build-generated data (src/sites.ts) — except for types, which compile away, and the sandbox's worker itself (src/entrypoints/sandbox/interpret-worker.ts), which has no document whose resource hints could reach the network. Being the only way in, a direct import is also the only transitive one: core and api may not import services either.",
      severity: 'error',
      from: {
        path: '^apps/extension/src/',
        pathNot: '^apps/extension/src/entrypoints/sandbox/interpret-worker\\.ts$',
      },
      to: {
        path: '^(packages/services/|@mt/services(/|$))',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'only-the-sandbox-starts-its-worker',
      comment:
        "The sandbox's worker holds every module: only the sandbox page may reach it, and only to start it as a worker (`?worker&inline`, which the page's own test holds to). Another shipped file importing it would run the modules in that file's bundle; a test, which ships nothing, may load it to drive it.",
      severity: 'error',
      from: {
        path: '^apps/extension/src/',
        pathNot: '^apps/extension/src/(entrypoints/sandbox/main\\.ts|.+\\.test\\.ts)$',
      },
      to: { path: '^apps/extension/src/entrypoints/sandbox/interpret-worker\\.ts$' },
    },
    {
      name: 'runtime-takes-no-build-code',
      comment:
        'What the extension ships never imports what runs at build time (build/, wxt.config.ts, tools/): build/sites-data.ts imports every service module, and a runtime file reaching it would carry them past runtime-takes-no-module-code.',
      severity: 'error',
      from: { path: '^apps/extension/src/' },
      to: { path: '^(apps/extension/(build/|wxt\\.config)|tools/)' },
    },
    {
      name: 'pages-take-no-protocol',
      comment:
        "The extension's pages read the protocol's types and its two constants (src/messaging/constants.ts), never its validators: a value import of protocol.ts or schemas.ts brings valibot's schemas and, through the wire bounds, the whole registry's data into every page. Validation is the worker's. The UI's tests and their harness, which drive the worker itself, are exempt.",
      severity: 'error',
      from: {
        path: '^apps/extension/src/(ui|entrypoints/(popup|options|welcome))/',
        pathNot: '(\\.test\\.tsx?|/test-harness\\.ts)$',
      },
      to: {
        path: '^apps/extension/src/messaging/(protocol|schemas)\\.ts$',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'no-unresolvable-in-app',
      comment:
        'An import in the extension that cannot be resolved must not hide from the rules above.',
      severity: 'error',
      from: { path: '^apps/extension/' },
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: '(^|/)node_modules/' },
    // `tsc -b` writes declarations to each package's dist/; the layers are a property of the
    // sources. (A source `.d.ts`, such as the generated API types, is not emitted there, so a
    // declaration that imports one would be reported unresolvable for nothing.) WXT's build
    // output (.output/) and its scratch directory (.wxt/) are not sources either.
    exclude: { path: '(^|/)(dist|\\.output|\\.wxt)/' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
  },
};
