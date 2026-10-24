/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `pnpm dev`: the extension against the local mock of the MediaTracker routes, so a
// contributor needs no account and no backend. The mock's public URL is the one the extension
// is built with — a proof names it (`htu`), and `localhost` and `127.0.0.1` are different URLs —
// and it stands in for the web app too (its approval page). `pnpm dev:backend` uses the local
// backend (8000) and web app (3000) instead: the committed defaults.

import { spawn } from 'node:child_process';

import { startMockApi } from '../../../tools/mock-api/server.ts';

const MOCK_PORT = 8787;
const MOCK_URL = `http://localhost:${String(MOCK_PORT)}`;

const api = await startMockApi({ port: MOCK_PORT, publicUrl: MOCK_URL });
process.stdout.write(`Mock MediaTracker API on ${api.url}\n`);

const wxt = spawn('pnpm', ['--filter', '@mt/extension', 'dev'], {
  stdio: 'inherit',
  env: { ...process.env, MT_API_BASE_URL: MOCK_URL, MT_WEB_APP_BASE_URL: MOCK_URL },
});

const stop = (signal: NodeJS.Signals): void => {
  wxt.kill(signal);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

wxt.once('exit', (code) => {
  void api.close().finally(() => {
    process.exit(code ?? 0);
  });
});
