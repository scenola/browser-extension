## What and why

<!-- What this changes, and why. For a module: what the samples showed. Link the issue it closes. -->

## Checklist

The full list, with the reason for each line: [CONTRIBUTING.md, _Review checklist_](../blob/main/CONTRIBUTING.md#review-checklist).

- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass; for a change outside a module, `pnpm e2e` passed on my machine (CI does not run it).
- [ ] No new readability warning: what outgrew the budget is split, not excused.
- [ ] A module change: real samples (or `"synthetic": true`), tests that assert the readings, its `version` moved, its README updated.
- [ ] Nothing new reaches the network, and nothing new is sent beyond the fields of a play.
- [ ] Untrusted input is read totally and bounded.
- [ ] No title, URL, page text or sign-in detail in any log or diagnostic.
- [ ] UI text is in `en.json` and follows the copy rules.
- [ ] A new dependency was agreed in an issue first (runtime) or has its line in `docs/architecture.md`.
- [ ] A rule someone could undo by accident is written down in `docs/architecture.md`, with its reason.
