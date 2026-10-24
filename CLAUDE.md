# MediaTracker for Chrome

A Chrome MV3 extension (WXT, TypeScript, Preact) that reads what a streaming page is playing and
reports finished viewings to MediaTracker. pnpm workspace: `packages/core` (pure domain and use
cases), `packages/api` (the MediaTracker protocol), `packages/services` (service modules and the
registry), `apps/extension` (the only package that knows `chrome`), `tools/` (mock API, OpenAPI
subset, i18n, release, gates). How it fits together and the rules behind it:
@docs/architecture.md. Setup and every check: @CONTRIBUTING.md.

## Commands

- One test file: `pnpm exec vitest run --configLoader runner <path>`. Without
  `--configLoader runner` the workspace config fails to load.
- Before a commit: `pnpm lint && pnpm typecheck && pnpm test`. Run the tests of the package you
  changed while you work; the full suite takes a few minutes.
- Size budgets measure the **store** build and refuse a development one:
  `MT_API_BASE_URL=https://api.example.org MT_WEB_APP_BASE_URL=https://app.example.org pnpm --filter @mt/extension build:store && pnpm size`
  (any public https stand-ins work).
- `pnpm e2e` takes about 30 minutes: run it in the background, and run single specs with
  `pnpm e2e <file>` while iterating. It builds into `.output/e2e/`, separate from the
  development build in `.output/chrome-mv3/`.
- After editing `apps/extension/src/i18n/messages/en.json`: `pnpm i18n:compile`. After changing
  the registry: `pnpm docs:services`. After the backend's API changes: `pnpm openapi:sync` (needs
  the backend checkout beside this repo). Never hand-edit `*/generated/*` or
  `tools/openapi/openapi.subset.json`.

## Rules that are easy to break

Each has its reason in `docs/architecture.md`; a test or gate usually fails when one is broken.

- `packages/core` stays pure: no `chrome`, `window`, `document` or `fetch`. Browser work goes in an
  adapter behind a port in `apps/extension/src/platform/`, with an in-memory twin for tests.
- The extension never identifies a title. A play carries what the page stated; ids only when the
  page states them, never looked up. No catalogue data enters the extension.
- Nothing leaves the browser but the documented play fields. A new field changes
  `docs/privacy.md`, the About inventory and its test in the same change.
- Service-module code runs only in the sandbox: a module is data plus one pure `interpret`
  function. A next-episode or post-play screen declares `contentEnded`.
- One edit point per rule: `buildPlay` is the only play constructor; the registry, the message
  protocol and the block list each exist once. Extend them; never add a second.
- Nothing is sent and no receipt is read until the connection's `account_key` is read. The key is
  compared whole and never parsed, logged, shown or exported.
- The service worker can stop at any moment: state lives in storage, never only in memory. Writes
  that must not double (the outbox) follow the existing order under `ViewingLock`.
- A store build may not contain development-only code. Gate it on
  `import.meta.env.MT_BUILD_MODE`, read where it is tested; `config.ts` has no build-mode
  constant, since one read from another module does not fold an `import()` out of the bundle.
- Never loosen a gate, a budget, a lint rule or an allowlist to make a check pass. If a check
  fires, the change is what needs fixing.

## Writing code here

- Read the module you change and its neighbours first, and match their naming and structure.
- Comments explain _why_, in plain sentences. No references to internal documents, issue or review
  ids, and no section numbers.
- Tests use the in-memory ports and the fixtures; expected values come from the rule being tested,
  never from running the code and copying its output.
- Product copy is English, only in `en.json`, short and plain.
- Dependencies are pinned and reviewed: nothing published in the last seven days installs, and an
  install script needs a reasoned entry in `pnpm-workspace.yaml`. A new dependency gets a line in
  the Dependencies section of `docs/architecture.md`.
- Commits: Conventional Commits (`feat(core): …`, `fix(extension): …`), small and coherent. No AI
  attribution lines.

## Gotchas

- YouTube and `.ru`/`.рф` hosts are blocked by design (`packages/core/src/domain/blocked-sites.ts`);
  do not add exceptions.
- Development builds share one extension id, from the committed `apps/extension/dev-key.pub`; a
  local MediaTracker backend accepts sign-ins only from ids it lists.
- `pnpm dev` runs against the mock API (`tools/mock-api`, port 8787); `pnpm dev:backend` against a
  local MediaTracker on ports 8000 and 3000.
