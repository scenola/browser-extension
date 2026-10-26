# Scenola - Movie & TV Tracker

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/scenola/browser-extension/badge)](https://scorecard.dev/viewer/?uri=github.com/scenola/browser-extension)

Adds the films and episodes you watch to your Scenola diary, without opening the app. Watch
a film or an episode on a streaming site; once you have watched your share of it, it is in your
diary, and your library moves as if you had marked it watched yourself.

The extension observes and reports; Scenola decides what you watched. When the
evidence agrees on exactly one title, the viewing is added and nothing asks you anything. When
it does not, Scenola asks you once, in the app, and remembers your answer for that title.

It needs a Scenola Plus account.

## What it tracks

- **Seven streaming services from the first release:** Netflix and Apple TV, each read by a
  module of its own, and Prime Video, Disney+, HBO Max, Crunchyroll and Paramount+, read by the
  generic readers until someone writes theirs. Which service is read how, and since when:
  [docs/services.md](docs/services.md).
- **Any other film or TV site you allow**, one site at a time from the popup, or every site from
  Settings. On a site without a module, a viewing starts only when the page itself says it is a
  film or an episode, or a series whose address names the episode; a course, a news clip or a
  social video is not tracked, and the popup says why.
- **Viewings that reach your line.** A viewing is added the moment you have played your
  Scenola account's share of its story: 50 %, 70 % or 90 %, chosen in Scenola for
  every connected service (70 % to begin with). At 50 %, that is as soon as half of the story has
  played, wherever you are in it; the popup says the line while it plays. The story runs from the
  end of a skipped intro to the start of the credits, so long end titles never hold a viewing
  back, and skipped time is never played. It counts across as many sittings as it took, none more
  than a week after the last, and it is added once. A film you skimmed or stopped short of the
  line is never sent as a viewing, and a trailer, a preview or an ad is never sent at all.
- **Films you start, if your Scenola account saves them** (off unless you turn it on in
  Scenola): one start once you have played past the account's line, so the film shows as
  in progress.
- **Never** YouTube, or sites on russian domains (`.ru` and `.рф`): they are blocked, whatever
  you allow.

## Install

The Chrome Web Store listing comes with the first release. Until then, build it from source.

### Build from source

You need Node 26 (see [.nvmrc](.nvmrc)) and pnpm 12.14.0 (the `packageManager` in
[package.json](package.json); `npm install --global pnpm@12.14.0` installs it).

```sh
pnpm install --frozen-lockfile
pnpm build
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick
`apps/extension/.output/chrome-mv3`.

A development build talks to a Scenola running on your own machine
(`http://localhost:8000`, the web app on `http://localhost:3000`). To try the extension with no
account and no backend, run `pnpm dev`: it starts a local stand-in for Scenola and a build
pointed at it. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

## Privacy, in short

- **What leaves your browser:** only a viewing that reached your line — its titles and years, its
  season and episode, the service's own ids for it when the page states them, when you watched it
  and how far — sent to Scenola over your connection; never the page's address, its title or your
  account name on the service. Then the extension reads back what Scenola did with it.
  Nothing else, to anyone: no analytics, no telemetry, no crash reports, no third parties, no
  catalogue lookups.
- **What stays:** what is playing, until the viewing is finished or a week passes; what was sent
  and answered, for 7 days, or 1 or 30 as you choose; your settings; and, only if you turn it on, a diagnostics log kept
  for 7 days with sign-in details removed.
- **What you can see:** every play's exact contents, under _What was sent_ in the popup.
  Settings exports what the extension keeps (all but the sign-in itself), and clears the history
  of what was sent, or everything.
- **What it can reach:** the sign-in lives where web pages and content scripts cannot read it,
  and it is bound to a key the browser will not export. Code that reads a streaming service runs
  in a sandbox with no network.

The full inventory is [docs/privacy.md](docs/privacy.md); the security model is in
[docs/architecture.md](docs/architecture.md#the-security-model).

## Verify a build

Every release publishes, beside its zip, the zip's SHA-256 and the **build fingerprint**: a
SHA-256 over the extension's code (every `.js`, `.css` and `.html` file, by path). Settings →
About shows the fingerprint of the copy you run.

1. **Where the zip came from.** Each zip carries a build-provenance attestation made by the
   release workflow. With the [GitHub CLI](https://cli.github.com/), run the command the
   release's notes give:
   `gh attestation verify <zip> --repo scenola/browser-extension --signer-workflow scenola/browser-extension/.github/workflows/release.yml`.
   It checks that this repository's release workflow made the zip, not merely someone's
   workflow somewhere.
2. **That the zip is this source.** Builds are reproducible: check out the release's commit,
   use the Node and pnpm versions its notes name, set `SOURCE_DATE_EPOCH`, `MT_API_BASE_URL` and
   `MT_WEB_APP_BASE_URL` to the values its notes give, then run
   `pnpm install --frozen-lockfile`, `pnpm --filter @mt/extension build:store` and
   `pnpm release:zip`. The SHA-256 it prints is the release's.
3. **That the copy Chrome runs is that release.** Find the installed copy's folder: open
   `chrome://version`, take the **Profile Path**, and look in its
   `Extensions/<extension id>/<version>_0` folder. Then run
   `pnpm verify:install <that folder> <the release's fingerprint> --zip <the release's zip>`.
   It recomputes the fingerprint and compares every other file with the zip, leaving aside what
   the store and Chrome add to an installed copy (`_metadata/`, and the manifest's
   `update_url`, `key` and `current_locale`).

The store's copy cannot have the zip's own SHA-256: the store adds its signature files to what
it serves. That is why the fingerprint exists.

## Contributing, security, licence

- Adding or fixing a streaming service is one folder: [CONTRIBUTING.md](CONTRIBUTING.md).
- A broken service is reported with a page sample, through the _Broken service_ issue form.
- A vulnerability is reported privately: [SECURITY.md](SECURITY.md).
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- How it is built, and the rules a change must respect: [docs/architecture.md](docs/architecture.md).

The Scenola extension is free software under the [Mozilla Public License 2.0](LICENSE).
