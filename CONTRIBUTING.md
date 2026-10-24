# Contributing

Thank you for helping. The most useful contribution is a streaming service: a module that reads
a service's own player, written from samples captured on it. You need an account on that service
and nothing else — no MediaTracker account and no backend.

Read [docs/architecture.md](docs/architecture.md) for how the pieces fit and the rules a change
must respect. Each rule there carries its reason: argue with it in an issue rather than around it
in code.

## Set up

You need Node 26 ([.nvmrc](.nvmrc)) and pnpm 12.6.0 (the `packageManager` in
[package.json](package.json); `npm install --global pnpm@12.6.0`).

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` starts **`tools/mock-api`** — a local stand-in for the MediaTracker routes the extension
uses, on `http://localhost:8787` — and WXT's development server, which builds the extension
against it and opens a browser with it loaded (or load `apps/extension/.output/chrome-mv3`
yourself: `chrome://extensions` → **Developer mode** → **Load unpacked**). Press **Connect** and
approve on the mock's page: the whole path, from a play to its receipt, runs on your machine.
[tools/mock-api/README.md](tools/mock-api/README.md) lists what the mock answers and how a test
makes it answer otherwise.

The installs are strict on purpose — what ships is a short, reviewed dependency list: every
version is pinned, nothing published in the last seven days installs, and no dependency runs an install
script unless `pnpm-workspace.yaml` names it with a reason. A failed install because of the age
rule is answered by pinning an older version. The one exception is a security fix that cannot
wait its seven days: `pnpm-workspace.yaml` says how its exact version is let in, and for how long.

### The checks

Each runs in CI on every pull request ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

| Command                      | What it checks                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `pnpm lint`                  | ESLint, Prettier, the package boundaries (dependency-cruiser), unused code (knip) |
| `pnpm typecheck`             | TypeScript, every package                                                         |
| `pnpm test`                  | Vitest: unit, fixture, integration and gate tests                                 |
| `pnpm size`                  | the size budgets of each bundle, after `pnpm --filter @mt/extension build:store`  |
| `pnpm i18n:check`            | the compiled catalogs, missing and unused message keys                            |
| `pnpm openapi:check`         | the API types against the committed subset of the backend's document              |
| `pnpm contrast:check`        | every colour pair the pages paint, against WCAG 2.2 AA in both themes             |
| `pnpm docs:services`         | regenerates [docs/services.md](docs/services.md) from the registry (`--check`)    |
| `pnpm module-versions:check` | a module's `version` moved wherever its fixtures or definition did                |

One file's tests: `pnpm exec vitest run --configLoader runner <path>`.

**`pnpm e2e` runs on your machine, not in CI.** Playwright drives the built extension in Chromium
against the mock API, one scenario at a time, for about half an hour. Run it before a pull
request that changes anything outside a module, and say in the pull request that it passed;
`pnpm e2e <file>` runs one spec while you work.

`pnpm lint` also warns where code outgrows the readability budget: a function too branched, too
deep or too long, a file too long to hold one idea. A warning does not fail the run; in CI it is
an annotation on its line. Where code goes and the budget's numbers are in
[docs/architecture.md](docs/architecture.md#files-and-folders).

### Against a local MediaTracker

`pnpm dev:backend` builds against the MediaTracker backend and web app running on your machine
(`http://localhost:8000` and `http://localhost:3000`). The backend accepts sign-ins only from the
extension ids it lists: its `MT_SCROBBLING_DEV_EXTENSION_IDS` must hold the development id,
`jhdoobobmhfplgdlhncdlemlcmcfeplg`. Every development build has that id, because the build
carries the committed public key `apps/extension/dev-key.pub`
([apps/extension/dev-extension-id.txt](apps/extension/dev-extension-id.txt) pins it).

`pnpm e2e:stack` (the maintainer's) runs one sign-in, one play and its receipt against that
backend for real. It needs `MT_TEST_USER_TOKEN`, an access token of a development account with
Plus; without it the run is skipped with a message, and CI never has one.

What it does (`apps/extension/e2e-stack/stack.spec.ts`): builds the e2e extension against the
backend, approves the sign-in through the backend's authorize route, watches the fixture Netflix
episode to its end, and waits for the extension's history to show the receipt the backend
answered. `MT_STACK_API_URL` and `MT_STACK_WEB_APP_URL` name another backend or web app.

## Add a service

A service module is one folder, `packages/services/src/services/<id>/`, and the registry entry
that attaches it. It is **data** — the
player's routes and what to collect from the page — and **one pure function**, `interpret`, that
turns the collected snapshot into a reading. It never runs in the page, a content script or the
service worker: `interpret` runs in a sandboxed worker with no network, no `chrome.*`, no page
and no document, and the module's declarations are read by our own collector.

1. **Scaffold it.** `pnpm new:service <id>` writes the folder: a `defineService` skeleton, an
   empty fixture the test loads as a JSON import, a test that fails for each sample still to
   capture, and a README to fill in. For a built-in site (`prime_video`, `disney_plus`, `hbo_max`,
   `crunchyroll`, `paramount_plus`), the name and hosts come from the registry. For any other
   service, `--host <domain>` is required (repeat it for each host; the command refuses without
   it) and `--name` is optional. A new host is a new permission in an update, so it is the
   maintainer's call: Chrome disables an extension whose update asks for a new host until
   the person accepts it. The id is permanent: it is the namespace the server remembers answers under.
2. **Capture samples** on the real service (below): an episode, a film, the end of an episode or
   a film, and a preview playing outside the player. A module is never written blind.
3. **Declare what it reads**, in this order of preference: the player's own state, where the page
   exposes it; structured data; then the visible player. Ask for nothing you do not read. A
   state path may call a zero-argument method only if `ALLOWED_CALL_NAMES` in
   `packages/services/src/sdk.ts` lists it for your module — that list is reviewed by the
   maintainer.
4. **Write `interpret`** against the samples, and turn each failing test into the reading its
   sample should give. State an id only when the page states it, at the level it belongs (an
   episode's id on the episode, a show's on the show). Never call the service's own endpoints:
   read what the page already loaded.
5. **Attach it** in `packages/services/src/registry.ts`, run `pnpm docs:services`, and open a
   pull request.

The module's files compile without the DOM's or Node's types and are linted against globals,
`eval`, `Function`, computed member access and `as any`. These rails catch mistakes; the sandbox
is what holds against a malicious module.

**Versions and verification.** Bump the module's `version` whenever a fixture or its
`definition.ts` changes — CI refuses a pull request that does not. `verified` is
`{ on: "<YYYY-MM-DD>", by: "<who>" }`, set by the person who ran the module against the real
service and captured its samples from that run. A store build ships only modules verified in the
last 90 days, so an unattended module falls back to the generic readers rather than breaking
silently.

### Capture a page sample

A fixture is a snapshot: exactly what the module receives. The capture tool records one from a
real page.

1. Build and load a development build: `pnpm build`, then `chrome://extensions` →
   **Developer mode** → **Load unpacked** → `apps/extension/.output/chrome-mv3`. Allow the site
   if it is not built in (the popup's _Track this site_).
2. Play the film or episode in its tab.
3. Open Settings → **Diagnostics** → **Capture page sample** → **Capture**, then **Save sample**.
   It saves `<service>-<date>.snapshot.json`.
4. **Read it.** The tool removes anything that looks like an account, a profile, an e-mail
   address, a token or a URL query; check anyway, and remove what it missed.
5. Save it under the module's `fixtures/` with the name its test asks for. A sample from a real
   page says `"synthetic": false`; one you wrote by hand says `"synthetic": true`.

The same tool is how a broken service is reported: a sample attached to a _Broken service_ issue
lets someone without an account fix the module.

## Review checklist

A pull request is reviewed against this list; checking it yourself first saves a round.

- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass; for a change outside a module,
      `pnpm e2e` passed on your machine too (CI does not run it).
- [ ] No new readability warning: what outgrew the budget is split, not excused.
- [ ] A module change: its samples are real captures (or say `"synthetic": true`), its tests
      assert the readings, its `version` moved, and its README says what it reads and why.
- [ ] Nothing reaches the network but the MediaTracker API, and nothing new is sent to it beyond
      the fields of a play.
- [ ] Untrusted input — page data, storage contents, server answers, messages — is read totally
      (an odd shape is "no value", never a throw) and bounded (lengths, counts, depth, the work
      done as well as the results kept).
- [ ] No title, URL, page text or sign-in detail in any log or diagnostic: ids only.
- [ ] UI text comes from `apps/extension/src/i18n/messages/en.json`, with the product's name from
      the brand constants (`apps/extension/src/brand.ts`). It never says "scrobble",
      "credential" or "DPoP", and writes "russia" and "russian" in lowercase.
- [ ] A new dependency was agreed in an issue first (runtime) or has a line in the architecture
      document (tools), and is at least seven days old.
- [ ] A rule a contributor could undo by accident is written down in
      [docs/architecture.md](docs/architecture.md), with its reason.

## Releases (the maintainer)

Versions follow semantic versioning; the version lives in `apps/extension/package.json`.

1. The repository variables `MT_API_BASE_URL` and `MT_WEB_APP_BASE_URL` hold the production
   origins (public URLs, so variables, not secrets).
2. Run `pnpm e2e` on the commit to be released: no workflow runs it, and a release is the last
   place to catch what it catches.
3. Bump the version, move [CHANGELOG.md](CHANGELOG.md)'s _Unreleased_ entries under it, merge,
   and push the tag `v<version>`. The release workflow runs every CI gate,
   makes the store build twice and the zip twice (the two must match), attests the zip and
   publishes a GitHub release with the zip, its SHA-256, the build fingerprint and the changes
   since the last tag. It refuses a tag that does not name the manifest's version.
4. Upload by hand — CI holds no store credential: unzip the
   release's zip, pack it with the offline key
   (`chrome --pack-extension=<folder> --pack-extension-key=<key.pem>`), and upload the signed
   package in the Chrome Web Store dashboard, where verified uploads accept nothing else.

## Licence

MediaTracker for Chrome is under the [Mozilla Public License 2.0](LICENSE). By contributing, you
license your contribution under it. Every source file starts with the licence notice; lint
refuses a file without it, and `pnpm exec eslint --fix <file>` adds it:

```ts
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
```

Code from projects under incompatible licences — the GPL, for one — is not taken, however
useful: other trackers are studied for facts, never copied.
