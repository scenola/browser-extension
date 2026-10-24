# Apple TV

The module for `tv.apple.com`. **Unverified** — `verified: null` until a maintainer has captured it
(below), so a store build does not ship it.

**The name and the id.** Apple renamed Apple TV+ to Apple TV in October 2025; the module is
called Apple TV. Its id is **`apple_tv`, and it is permanent**: it is the `provider.apple_tv`
namespace the server remembers answers under, so it stays whatever the service is called next.

**Maintainer:** Artem Kozak, who also verifies it.

## What it reads, and why

- **`url.pathname`**, through `playerRoutes`:
  `^(?:/xx)?/(episode|movie)/<slug>/(umc.cmc.<id>)`. An episode's or a film's page, where the
  long-form player opens. The `umc.cmc.*` content id in the path is the item's own id — the
  only title-level id the module states.
- **`url.query.showId`** (`queryParams: ["showId"]`): the series' content id Apple puts on an
  episode's address, stated at `level: "show"` when it is a `umc.cmc.*` id other than the
  episode's. The JSON-LD about the episode names its series too (`partOfSeries.url` / `@id`,
  below): where only one of the two names a series, that one is stated, and where they name
  different series, neither is.
- **`selectors.player`**: `[data-testid="video-player"]`, its `data-testid` attribute, hidden
  ones kept. Whether the long-form player is open: Apple plays promotional videos (a trailer in
  a page's header) outside it.
- **`selectors.playerTitle`** and **`selectors.playerSubtitle`**:
  `[data-testid="player-metadata-title"]` and `[data-testid="player-metadata-subtitle"]` inside
  the player, hidden ones kept. The player's two lines: the show, and the label with the
  episode's title (`S1, E2 · Pilot`) — in either line.
- **`selectors.contentId`**: `meta[name="apple:content_id"]`, its `content` attribute. The item
  the server rendered the page for: JSON-LD that names no item is the page's own only when this
  is the route's id.
- **`jsonLd`**: `TVEpisode` / `Episode` and `Movie` nodes, read only when they are about the
  route's item (below).
- **`mediaSession`**: a season-and-episode label in `title`, `artist` or `album`, when the
  player shows none.
- **`openGraph`**: declared for the core's generic reader; this module does not read it.
- **`signals.endOfContent`**: `[class*="up-next" i] button` and `[class*="skip-credits" i]`,
  inside the player. The end of the content: the up-next card over the credits, _Skip credits_.

Nothing else is read: `interpret` ignores `documentTitle`, `lang`, `hash`, `openGraph` and
`pageState` (a fixture needs no `pageState`).

### JSON-LD about another item is ignored

Apple's web app is a single page: after moving to another episode it can keep the JSON-LD of the
page it first loaded. A node counts only when the content ids its `url` and `@id` name are all
the route's id; a node that names none counts only when `apple:content_id` is the route's id; its
`@type` must be the route's kind. From such a node: `name` (an episode's, with a leading
`<show> - ` removed), `episodeNumber` (1–100,000), `partOfSeason` (`seasonNumber`, or a bare
number; 0–10,000), `partOfSeries.name` and `.startDate`, the series' content id in
`partOfSeries.url` / `@id` (one id; two different ones name none), a film's `datePublished` /
`dateCreated` year (1870–2200), `duration` (ISO 8601, kept only from 120 s to a week, since a
stated length wins over the element's), and IMDb ids in `sameAs`.

## What `interpret` answers

Confidence `0.95` for what JSON-LD about the item states, `0.8` for what the player or the media
session shows.

- **Not a player route** (the home page, a show's page, a clip): `null`.
- **No long-form player in the page**: `{ adPlaying: true, ids: {}, showIds: {} }`, plus the
  item's `contentDurationSeconds` when its JSON-LD states one. A trailer in the header is not the
  content, so its end is not the content's end and its length is not the title's.
- **`signals.endOfContent`, and not `signals.adPlaying`**:
  `{ contentEnded: true, ids: {}, showIds: {} }`. The up-next card shows what comes next, so
  nothing else is taken from it.
- **The player numbers an episode on a film's page, or other numbers than the route's
  JSON-LD**: Apple's player moved on (an autoplay) and left the address behind. The reading is
  the player's episode alone — `kind`, `season`, `episode`, `showTitle`, `episodeTitle` at 0.8,
  `ids: {}`, `showIds: {}` — with **no** provider id, JSON-LD or length.
- **Otherwise, an episode's page**: `kind`, `showTitle`, `season`, `episode`, `episodeTitle`,
  `showYear`, `ids`, `showIds`, `contentDurationSeconds` — each from the JSON-LD about the item
  when it states it, else from the player — and `providerIds`: the route's id at
  `level: "title"` and the series' id (the address's `showId`, the JSON-LD's, or both when they
  agree) at `level: "show"`, both with key `contentId`.
- **Otherwise, a film's page**: `kind`, `title` (the JSON-LD's, else the player's title),
  `year`, `ids`, `contentDurationSeconds`, and the route's id.

Every reading states `ids` (and an episode's `showIds`), empty when it knows none: the core's
generic JSON-LD reader takes the first node of the page whichever item it is about, and an IMDb
id is the strongest evidence there is — of another title, once the app moved on.

The label grammar reads the player's lines. A label set apart at either end of a line — by a
middle dot, a bullet, a bar or a dash with a space on each side, or by a colon and a space —
leaves the rest as the episode's title (`S1, E1 · Chapter 1: The Mandalorian`); a label run into
other text gives the numbers alone. Every text is collapsed to single spaces, trimmed and cut to
the wire's 200 code points; the module looks at no more than 1,000 characters of any text, 5
values of any selector, 200 JSON-LD nodes (20 objects) and a pathname of 2,048 characters,
whatever the snapshot holds. Anything of the wrong type is no value.

## Known gaps

- Playback started from a show's page or the home page keeps that address, which is no player
  route: this module does not track it (the generic readers still run).
- While the player's lines are not in the page, an autoplay that kept the old address cannot be
  told from the old episode.
- After the app moved to another item, the page's first JSON-LD is still there. It reaches
  nothing: this module reads only the JSON-LD about the route's item, and a module's reading
  owns the identity, so the core's generic readers fill none of the fields it
  leaves empty.
- The test ids and the up-next and credits selectors come from public prior art, not yet from a
  capture of the player.

## Verify it (the maintainer)

1. Build a development build, open Settings → **Diagnostics**, turn it on.
2. **Capture page sample** on: an episode (controls shown, then hidden); a film; the up-next card
   at an episode's end; the end of a film; an episode reached by autoplay (note whether the
   address changed); a film's page while its header trailer plays; playback started from a
   show's page (note the address).
3. Read each sample before keeping it: no account, e-mail, token or URL query beyond `showId`
   may be in it (the tool removes them; check anyway).
4. Compare each sample with the lists above — the routes, the test ids, the JSON-LD's `url` and
   `@type`, what the media session holds, the signal — and correct the definition where Apple
   differs.
5. Replace the synthetic fixtures in `fixtures/` with the captures (`"synthetic": false`), keep
   the expected readings in `definition.test.ts` true to them, bump `version`, and set
   `verified: { on: "<YYYY-MM-DD>", by: "<who>" }`. A store build drops the module again 90 days
   later unless it is verified anew.
