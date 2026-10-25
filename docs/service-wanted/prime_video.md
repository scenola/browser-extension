# Service wanted: Prime Video

_For a maintainer to open as a **Service wanted** issue (labels: `service wanted`)._

- **Service:** Prime Video — `primevideo.com`
- **Id:** `prime_video`, permanent: it is the `provider.prime_video` namespace Scenola
  remembers answers under, whatever the service is called next.
- **Countries:** many. Write down the country your samples come from: players differ by region.

## What happens today

The Scenola extension tracks `primevideo.com` from its first release, so the site needs no
permission prompt. With no module, the **generic readers** read it: structured data on the page
(JSON-LD), the media session, Open Graph, the page title and the page's address. A viewing
starts only when the page itself says it is a film or an episode — or a series whose address
names the episode — and what they can tell depends on what the player page states.

Only `primevideo.com` is a Prime Video host here. Amazon's own shops also play Prime Video on
their regional domains, but a host permission cannot be limited to a path, so asking for
`amazon.*` would mean whole stores. Someone who watches on an Amazon domain can turn on _Track
this site_ there.

## What a module would add

- The title, the season and the episode from the player itself, not from whatever the page
  states.
- The end of the content: the credits or the next-episode screen, so a film watched to the
  credits counts as finished.
- The service's own title id, at the level it belongs to (a title or a show), when the page
  states it.

## How to write it

You need an account on Prime Video and a Chrome you can load a development build into.

1. `pnpm install`, then `pnpm new:service prime_video`: the module's folder, with a skeleton, a
   test that fails for each sample still to capture, and a README to fill in.
2. Load the development build (CONTRIBUTING.md, _Capture a page sample_) and capture samples
   on an episode, a film, the end of an episode, and a preview playing outside the player.
   Read each one before saving it.
3. Declare what the module reads (`collect`) and turn each sample into a reading
   (`interpret`). The module runs in a sandbox with no network and no page: it sees the sample
   only.
4. Attach it in `packages/services/src/registry.ts`, run `pnpm test` and
   `pnpm docs:services`, and open a pull request with the review checklist of CONTRIBUTING.md.
