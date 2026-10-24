/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Build time only: the registry's data for the worker and the content scripts. This file imports
// `@mt/services` — and so runs every module file's top-level code — in Node, at build time; what
// it returns is plain JSON, which the bundle inlines as `__MT_SITES__` (src/sites.ts). The
// dependency rule `runtime-takes-no-module-code` keeps every runtime file but the sandbox page's
// from importing either this file or the package.

import { isDeepStrictEqual } from 'node:util';

import {
  ALLOWED_CALL_NAMES,
  BUILT_IN_SITES,
  MAX_ROUTE_INPUT,
  MAX_SELECTOR_LENGTH,
  MAX_SELECTOR_VALUES,
  modulesForBuild,
} from '@mt/services';
import type { BuildMode as RegistryMode } from '@mt/services';

import type { BuildMode } from '../src/config-rules.ts';
import type { SiteData, SitesData } from '../src/sites.ts';

/** An e2e build ships what a development build ships. */
function registryMode(mode: BuildMode): RegistryMode {
  return mode === 'store' ? 'store' : 'development';
}

/**
 * The calendar day a build is made on, in UTC: `SOURCE_DATE_EPOCH` (seconds) when it is set, so
 * two builds of one commit choose the same modules, else today.
 */
export function buildDay(env: Readonly<Record<string, string | undefined>>, now: Date): string {
  const epoch = env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined && epoch !== '') {
    if (!/^\d{1,12}$/u.test(epoch)) throw new Error('SOURCE_DATE_EPOCH must be whole seconds');
    return new Date(Number(epoch) * 1000).toISOString().slice(0, 10);
  }
  return now.toISOString().slice(0, 10);
}

/**
 * Every built-in site, with its module's data where `modulesForBuild` ships the module on `today`
 * — `module: null` where it does not, so the site runs on the generic readers. Throws when the
 * result is not plain JSON (it must survive `JSON.stringify` unchanged to be inlined).
 */
export function buildSitesData(mode: BuildMode, today: string): SitesData {
  const shipped = new Set(modulesForBuild(registryMode(mode), today).map((module) => module.id));
  const sites: SiteData[] = BUILT_IN_SITES.map((site) => {
    const module = site.module;
    return {
      id: site.id,
      name: site.name,
      hosts: [...site.hosts],
      module:
        module === null || !shipped.has(module.id)
          ? null
          : {
              version: module.version,
              verified: module.verified === null ? null : { ...module.verified },
              playerRoutes: module.playerRoutes.map((route) => ({
                source: route.source,
                flags: route.flags,
              })),
              collect: plainJson(module.collect),
              allowedCalls: Object.hasOwn(ALLOWED_CALL_NAMES, module.id)
                ? [...(ALLOWED_CALL_NAMES[module.id] ?? [])]
                : [],
            },
    };
  });
  const data: SitesData = {
    builtFor: { mode, today },
    limits: {
      maxRouteInput: MAX_ROUTE_INPUT,
      maxSelectorLength: MAX_SELECTOR_LENGTH,
      maxSelectorValues: MAX_SELECTOR_VALUES,
    },
    sites,
  };
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(data)), data)) {
    throw new Error('the registry data is not plain JSON');
  }
  return data;
}

function plainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
