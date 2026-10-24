/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the build inlines into the bundle, and nothing more (src/env.d.ts, src/config.ts,
// src/sites.ts). Shared by wxt.config.ts and the test configuration, so a test sees the same
// constants a build does.

import type { ExtensionConfig } from '../src/config-rules.ts';
import type { SitesData } from '../src/sites.ts';

export function extensionDefines(
  config: ExtensionConfig,
  sites: SitesData,
): Record<string, string> {
  return {
    'import.meta.env.MT_BUILD_MODE': JSON.stringify(config.mode),
    'import.meta.env.MT_API_BASE_URL': JSON.stringify(config.apiBaseUrl),
    'import.meta.env.MT_WEB_APP_BASE_URL': JSON.stringify(config.webAppBaseUrl),
    'import.meta.env.MT_AUTH_STRATEGIES': JSON.stringify(config.authStrategies.join(',')),
    'import.meta.env.MT_TEST_APPROVE_URL': JSON.stringify(config.testApproveUrl ?? ''),
    __MT_SITES__: JSON.stringify(sites),
    // The bootstrap's one need of the registry, alone: it must stay within 2 KB.
    __MT_SHADOW_ROOT_HOSTS__: JSON.stringify(shadowRootHosts(sites)),
  };
}

/** The hosts of the sites whose shipped module sets `shadowRootPlayer` (the bootstrap's). */
function shadowRootHosts(sites: SitesData): readonly string[] {
  return sites.sites.flatMap((site) =>
    site.module?.collect.shadowRootPlayer === true ? site.hosts : [],
  );
}
