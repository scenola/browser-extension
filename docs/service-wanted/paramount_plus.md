# Service wanted: Paramount+

_For a maintainer to open as a **Service wanted** issue (labels: `service wanted`)._

- **Service:** Paramount+ — `paramountplus.com`
- **Id:** `paramount_plus`, permanent: it is the `provider.paramount_plus` namespace Scenola
  remembers answers under, whatever the service is called next.
- **Countries:** several. Write down the country your samples come from: players differ by
  region.

## What happens today

The Scenola extension tracks `paramountplus.com` from its first release, so the site needs no
permission prompt. With no module, the **generic readers** read it: structured data on the page
(JSON-LD), the media session, Open Graph, the page title and the page's address. A viewing
starts only when the page itself says it is a film or an episode — or a series whose address
names the episode — and what they can tell depends on what the player page states.

## What a module would add

- The title, the season and the episode from the player itself, not from whatever the page
  states.
- The end of the content: the credits or the next-episode screen, so a film watched to the
  credits counts as finished.
- The service's own title id, at the level it belongs to (a title or a show), when the page
  states it.

## How to write it

You need an account on Paramount+ and a Chrome you can load a development build into.

1. `pnpm install`, then `pnpm new:service paramount_plus`: the module's folder, with a
   skeleton, a test that fails for each sample still to capture, and a README to fill in.
2. Load the development build (CONTRIBUTING.md, _Capture a page sample_) and capture samples
   on an episode, a film, the end of an episode, and a preview playing outside the player.
   Read each one before saving it.
3. Declare what the module reads (`collect`) and turn each sample into a reading
   (`interpret`). The module runs in a sandbox with no network and no page: it sees the sample
   only.
4. Attach it in `packages/services/src/registry.ts`, run `pnpm test` and
   `pnpm docs:services`, and open a pull request with the review checklist of CONTRIBUTING.md.
