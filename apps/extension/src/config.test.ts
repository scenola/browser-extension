/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The build's configuration (`config.ts`): the development defaults a
// bundle carries, and what a build in each mode refuses. The test configuration inlines what a
// development build inlines (apps/extension/vitest.config.ts), so `config.ts` here is that build's.

import { describe, expect, test } from 'vitest';

import { API_BASE_URL, AUTH_STRATEGIES, WEB_APP_BASE_URL } from './config';
import { resolveConfig } from './config-rules';

const STORE_URLS = {
  MT_API_BASE_URL: 'https://api.example.com',
  MT_WEB_APP_BASE_URL: 'https://app.example.com',
};

describe('the development defaults', () => {
  // Only local development values are committed: http://localhost:8000, http://localhost:3000 and
  // ["pkce_dpop"].
  test('a development bundle carries localhost:8000, localhost:3000 and pkce_dpop', () => {
    expect(import.meta.env.MT_BUILD_MODE).toBe('development');
    expect(API_BASE_URL).toBe('http://localhost:8000');
    expect(WEB_APP_BASE_URL).toBe('http://localhost:3000');
    expect([...AUTH_STRATEGIES]).toEqual(['pkce_dpop']);
  });

  // The same defaults, from an environment that sets nothing.
  test('resolveConfig with nothing set gives the same defaults', () => {
    const config = resolveConfig('development', {});
    expect(config.mode).toBe('development');
    expect(config.apiBaseUrl).toBe('http://localhost:8000');
    expect(config.webAppBaseUrl).toBe('http://localhost:3000');
    expect([...config.authStrategies]).toEqual(['pkce_dpop']);
  });

  // The build-time variables are MT_API_BASE_URL, MT_WEB_APP_BASE_URL and MT_AUTH_STRATEGIES.
  test('a set variable replaces its default', () => {
    const config = resolveConfig('development', {
      MT_API_BASE_URL: 'http://localhost:8787',
      MT_WEB_APP_BASE_URL: 'http://localhost:8787',
      MT_AUTH_STRATEGIES: 'pkce_dpop,personal_token',
    });
    expect(config.apiBaseUrl).toBe('http://localhost:8787');
    expect(config.webAppBaseUrl).toBe('http://localhost:8787');
    expect([...config.authStrategies]).toEqual(['pkce_dpop', 'personal_token']);
  });
});

describe('a store build', () => {
  // A build fails when the mode is store and either URL is localhost; the error says
  // `store builds need MT_API_BASE_URL`.
  test('refuses the committed localhost API URL', () => {
    expect(() =>
      resolveConfig('store', { MT_WEB_APP_BASE_URL: STORE_URLS.MT_WEB_APP_BASE_URL }),
    ).toThrow('store builds need MT_API_BASE_URL');
    expect(() =>
      resolveConfig('store', { ...STORE_URLS, MT_API_BASE_URL: 'http://localhost:8000' }),
    ).toThrow('store builds need MT_API_BASE_URL');
  });

  // Localhost is refused whatever its scheme.
  test('refuses an https localhost API URL', () => {
    expect(() =>
      resolveConfig('store', { ...STORE_URLS, MT_API_BASE_URL: 'https://localhost:8443' }),
    ).toThrow('store builds need MT_API_BASE_URL');
    expect(() =>
      resolveConfig('store', { ...STORE_URLS, MT_WEB_APP_BASE_URL: 'https://localhost' }),
    ).toThrow();
  });

  // Either URL being localhost fails a store build.
  test('refuses a localhost web app URL', () => {
    expect(() =>
      resolveConfig('store', { ...STORE_URLS, MT_WEB_APP_BASE_URL: 'http://localhost:3000' }),
    ).toThrow();
  });

  // A store build talks to a named public service: no address of any kind, no name only a local
  // resolver answers.
  test.each([
    'https://127.0.0.1',
    'https://10.0.0.5',
    'https://192.168.1.10',
    'https://172.20.0.1',
    'https://169.254.169.254',
    'https://100.64.0.1',
    'https://93.184.216.34',
    'https://[::1]',
    'https://[::ffff:7f00:1]',
    'https://[fd00::1]',
    'https://api.localhost',
    'https://nas.local',
    'https://api.internal',
    'https://router.home.arpa',
    'https://api.test',
    'https://intranet',
    'https://scenolaxyz.onion',
    'https://api.home.alt',
    'https://mt.lan',
    'https://nas.home',
    'https://api.corp',
    'https://box.localdomain',
  ])('refuses %s', (url) => {
    expect(() => resolveConfig('store', { ...STORE_URLS, MT_API_BASE_URL: url })).toThrow(
      'store builds need MT_API_BASE_URL',
    );
    expect(() => resolveConfig('store', { ...STORE_URLS, MT_WEB_APP_BASE_URL: url })).toThrow(
      'store builds need MT_WEB_APP_BASE_URL',
    );
  });

  // A public name passes, however many labels it has.
  test.each(['https://api.scenola.app', 'https://a.b.example.com', 'https://example.org'])(
    'accepts %s',
    (url) => {
      expect(resolveConfig('store', { ...STORE_URLS, MT_API_BASE_URL: url }).apiBaseUrl).toBe(url);
    },
  );

  // A store build fails when the strategies hold anything but pkce_dpop: store builds ship
  // without personal tokens or the test sign-in.
  test.each(['pkce_dpop,personal_token', 'personal_token', 'test', 'pkce_dpop,test'])(
    'refuses MT_AUTH_STRATEGIES=%s',
    (strategies) => {
      expect(() =>
        resolveConfig('store', { ...STORE_URLS, MT_AUTH_STRATEGIES: strategies }),
      ).toThrow();
    },
  );

  // pkce_dpop alone is the store's strategy.
  test('accepts public URLs with pkce_dpop', () => {
    const config = resolveConfig('store', { ...STORE_URLS, MT_AUTH_STRATEGIES: 'pkce_dpop' });
    expect(config.mode).toBe('store');
    expect(config.apiBaseUrl).toBe('https://api.example.com');
    expect(config.webAppBaseUrl).toBe('https://app.example.com');
    expect([...config.authStrategies]).toEqual(['pkce_dpop']);
  });
});

describe('the build modes', () => {
  // A build is "development", "store" or "e2e".
  test.each(['development', 'e2e'])('%s builds with nothing set', (mode) => {
    expect(resolveConfig(mode, {}).mode).toBe(mode);
  });

  // There is no fourth mode.
  test.each(['production', 'staging', ''])('"%s" is not a build mode', (mode) => {
    expect(() => resolveConfig(mode, {})).toThrow();
  });

  // The test sign-in is for e2e builds only.
  test('the test sign-in is refused outside an e2e build', () => {
    expect(() => resolveConfig('development', { MT_AUTH_STRATEGIES: 'test' })).toThrow();
  });
});
