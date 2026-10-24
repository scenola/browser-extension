/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The tools that read the service registry (`pnpm docs:services`, `pnpm new:service`) run in
// plain Node, which strips the types from `.ts` files but, being ESM, resolves only specifiers it
// can find as written. The packages are written for a bundler (`moduleResolution: "Bundler"`):
// `import … from './sdk'`. A resolve hook, scoped to this repository's `packages/` sources, adds
// the `.ts` (or `/index.ts`) a bundler would; every other specifier resolves as Node always does.
// Nothing is installed for this — `module.registerHooks` is Node's own.

import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

const PACKAGES = new URL('../../packages/', import.meta.url).href;
const HAS_EXTENSION = /\.(?:[cm]?[jt]sx?|json)$/u;
const SUFFIXES = ['.ts', '/index.ts'] as const;

let registered = false;

function allowBundlerSpecifiers(): void {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (parent?.startsWith(PACKAGES) === true && relative && !HAS_EXTENSION.test(specifier)) {
        for (const suffix of SUFFIXES) {
          const candidate = new URL(`${specifier}${suffix}`, parent);
          if (existsSync(candidate)) return nextResolve(candidate.href, context);
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

type Registry = typeof import('../../packages/services/src/registry.ts');
type Sdk = typeof import('../../packages/services/src/sdk.ts');

/** The service registry and the SDK, loaded from source — every module file runs. */
export async function loadServices(): Promise<{ readonly registry: Registry; readonly sdk: Sdk }> {
  allowBundlerSpecifiers();
  const [registry, sdk] = await Promise.all([
    import('../../packages/services/src/registry.ts'),
    import('../../packages/services/src/sdk.ts'),
  ]);
  return { registry, sdk };
}
