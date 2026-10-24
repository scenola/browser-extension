# Netflix

The module for `netflix.com` (id `netflix`, permanent: it is the `provider.netflix` namespace
the server remembers answers under). **Unverified** — `verified: null` until a maintainer has
captured it (below), so a store build does not ship it.

**Maintainer:** Artem Kozak, who also verifies it.

## What it reads, and why

- **`url.pathname`**, through `playerRoutes`: `^/(?:xx(?:-xx)?/)?watch/(\d+)`. The player lives
  at `/watch/<video id>`, with an optional locale segment (`/gb/`, `/de-en/`). The route's
  video id is the title's own id. The show's id, a level up, comes from the player's metadata
  (below).
- **`selectors.titleHeading`**: `[data-uia="video-title"] h4`, at most 1, hidden ones kept. The
  player's title area: the show's name for an episode, the film's for a film.
- **`selectors.titleParts`**: `[data-uia="video-title"] span`, at most 4, hidden ones kept. The
  rest of the title area: the season-and-episode label (`S1:E2`), or a single-season show's
  episode-only label (`Ep. 3`, `Еп. 3`), and the episode's own title.
- **`selectors.playerVideoId`**: `[data-uia="player"]`, attribute `data-videoid`, at most 1,
  hidden ones kept. The player's root (`<div data-uia="player" data-videoid="…">`) is in the page
  whether the controls show or not, and names the video it plays. When it names another video
  than the route, a switch is under way: the reading names nothing (below).
- **`signals.endOfContent`**: `[data-uia="next-episode-seamless-button"]`,
  `[data-uia="next-episode-seamless-button-draining"]`,
  `[data-uia="watch-credits-seamless-button"]`, `.postplay`. The end of the content: the
  next-episode buttons shown over the credits (and their countdown), _Watch credits_, the
  post-play screen.
- **`signals.adPlaying`**: not declared, so always `false`. Netflix's ad markup is not known yet;
  `interpret` would not end the content while it said an ad shows.
- **`pageState.playback`**:
  `["netflix", "appContext", "state", "playerApp", { call: "getState" }, "videoPlayer", "playbackStateBySessionId"]`
  — the player's playback sessions, keyed by session id. From each session `interpret` reads
  two keys, `videoId` (a number or a digit string) and `duration` (milliseconds), and only
  from a session whose `videoId` is the route's (see _Page state_
  below).
- **`pageState.falcor`** — **seen on the real page** (2026-10-22):
  `["netflix", "falcorCache", "videos", { routeGroup: 1 }, { pick: ["summary", "runtime", "creditsOffset"] }]`,
  the server-rendered Falcor cache's entry of the route's video. Each of the three is an atom,
  `{ "$type": "atom", "value": … }`:
  - `summary.value` is an object with `type` (`"episode"` or `"movie"`), `id` (the video id, a
    number), and for an episode `season` and `episode` (numbers), beside keys not read;
  - `runtime.value` is the length in seconds;
  - `creditsOffset.value` is where the credits start, in seconds: the reading's
    `creditsStartSeconds`, where core ends the story, but only when
    `summary.value.id` is the route's.

  Whether the cache holds an entry for a video reached by in-app navigation, and not only for
  the one the document was loaded at, is not known; where it holds none, nothing is read.

- **`pageState.video`**, **`pageState.episode`** — **unverified**: the player's metadata of the
  route's video, at `…"videoPlayer", "videoMetadata", { routeGroup: 1 }, "_metadata", "video"`
  (the route's video id is capture group 1), read with the state-path steps `routeGroup`, `find`
  and `pick`:
  - `video` ends in `{ pick: ["type", "id", "title", "year", "currentEpisode", "hiddenEpisodeNumbers"] }`
    — on an episode's route the entry is the show's, so its `id` is the show's id;
  - `episode` = `…"video", "seasons", { find: { key: ["episodes", "*", "id"], routeGroup: 1 } }, "episodes", { find: { key: ["id"], routeGroup: 1 } }, { pick: ["id", "title"] }`
    — the route's episode itself.

  Where they are absent — the place is wrong, or the player has not loaded them — nothing is
  read from them (see _Page state_ below). A module reads at most four page-state entries; the
  season number the metadata gave before is now the Falcor summary's.

- **`mediaSession`**: declared for the core's generic reader; this module does not read it
  (Netflix set none in the captures so far).

Nothing else is read: `interpret` ignores `documentTitle` (always "Netflix" on the player),
`jsonLd` and `openGraph` (the player page has none), `lang`, `query`, `hash`, and every other
key of the page state.

The title-area selectors keep hidden elements (`visibleOnly: false`), but on the real page the
title area is **unmounted**, not hidden, seconds after playback starts: while the controls are
inactive the player's root carries `class="inactive …"` and holds no `[data-uia="video-title"]`
at all (only `[data-uia="video-canvas"]` and the `<video>` inside it). So the kind and the numbers
come from the Falcor summary, which is in the page whatever the controls do. No identity comes
from the DOM — the id is the route's — and the end screen, which shows the _next_ title, is read
apart (below).

## What `interpret` answers

Confidence `0.95` for every field read from the page state (the Falcor summary, the player's
metadata), `0.8` for every field read from the title area. `providerIds` is
`[{ level: "title", key: "videoId", value: <the route's digits> }]` in every reading but the
switch's. Beside it, when the player's metadata names the route's episode of a show, the show's
own id: `{ level: "show", key: "videoId", value: <its digits> }` (Netflix numbers a show as a
video), never the route's own, never on the end screen and never where the summary names
another kind: an id goes at the level it belongs to.

- **Not a player route** (`/browse`, `/title/…`, a preview on the home page), or a video id of
  more than 20 digits: `null`.
- **The player's root names another video than the route** (`playerVideoId`): a switch is under
  way, the address moved first. `{ contentEnded: false }` and nothing else: no kind, no id. When
  it names the route's video, or is absent, it changes nothing.
- **`signals.endOfContent`, and not `signals.adPlaying`**: `{ providerIds, contentEnded: true }`
  and nothing else. The end screen shows the next episode, so no title, kind or number is taken
  from it.
- **The Falcor summary names the route's video** (`summary.value.id` is the route's): it gives
  the kind — `"episode"` or `"movie"` — and, for an episode, `season` (0–10,000) and `episode`
  (1–100,000), unless `pageState.video.hiddenEpisodeNumbers` is `true`. Where the player's
  metadata names another kind, the summary's stands alone.
- **The player's metadata names the route's video** (`pageState.video`, see above; a film's
  `id` is the route's, a show's `currentEpisode` or its found episode is):
  - `type: "movie"`: `kind: "movie"`, `title`, and `year` (1870–2200). From the title area,
    only a `title` it leaves out.
  - `type: "show"`: `kind: "episode"`, `showTitle`; and, when the route's episode was found
    (`pageState.episode.id` is the route's), `episodeTitle`. From the title area, only the
    episode fields it leaves out — never a film title — and no numbers at all when Netflix hides
    them. A show's `year` is not taken: whether it is the show's first year or its latest
    season's is not known.
  - Any other `type`, or an entry about another video: nothing from the metadata.
- **`creditsStartSeconds`** = the Falcor `creditsOffset` (seconds, 0 to a week) when the
  summary names the route's video, in every reading but the end screen's. It ends nothing of
  its own: core ends the story there, and where Netflix states none, at the position the end
  screen first showed.

The rest of this list is what the title area answers on its own, or for what the state leaves
out.

- **A part of the title area is a label the grammar reads**: `kind: "episode"`; `showTitle` =
  the heading (unless it is a label itself); `season` (0–10,000) and `episode` (1–100,000) from
  the label; `episodeTitle` = the first part after the label that is no label, or the only other
  part.
  - A season-and-episode label (`S1:E2`) wins wherever it is.
  - Failing one, a part that is an **episode-only** label (a single-season show's `Ep. 3`,
    `Еп. 3`, `Folge 3`, `第3集`) gives `episode` and no `season`. The whole part must
    be the label, so a number inside a title is never read as one.
- **In every reading but the end screen's**: `contentDurationSeconds` = the route's session's
  `duration` in whole seconds, when exactly one length is stated for the route's video and it is
  from 120 s to a week; failing that, the Falcor `runtime` (seconds), within the same bounds.
- **A heading and no parts**: `kind: "movie"`, `title` = the heading.
- **A heading and parts, none a label the grammar reads**: `kind: "episode"`, `showTitle` = the
  heading, no numbers — never a film of the show's name.
- **Nothing in the title area** (the controls are not in the page):
  `{ providerIds, contentEnded: false }` — a reading that names nothing of its own, which the
  core gives to the viewing the tab is on when its id is that viewing's.

Every text is collapsed to single spaces, trimmed and cut to the wire's 200 code points
(`clampTitle`); the module looks at no more than 1,000 characters of any text, 5 values of any
selector and a pathname of 2,048 characters, whatever the snapshot holds. Anything of the wrong
type is no value.

## Page state

A module reads the player's own state first, where the page exposes it, and the SDK allows
Netflix one call, `getState` (from `netflix.appContext.state.playerApp`).

**Read: the playback sessions.** `videoPlayer.playbackStateBySessionId` is small — one entry
for the video that plays and, at most, a preview or two — so the path lands on it whole, within
the reader's depth 6 and 32 KB. Each session names its video, so the one for the route's video
is the only one read: the previous episode's or a preview's says nothing about this title. Its
`duration` is the service's own statement of the length, which wins over the element's (whose
stream may run on past the content). Netflix's player counts milliseconds; a value in seconds
would come out under 120 s and be dropped, never misread. `interpret` looks at no more than 16
sessions; the object is enumerated whole first, so the reader's 32 KB bound is what bounds that
work.

**Read, seen on the real page: the Falcor cache.** `netflix.falcorCache.videos` is keyed by
video id; `{ routeGroup: 1 }` takes the route's, and `{ pick: [...] }` keeps its three atoms, so
the entry is small whatever else the cache holds. The summary states the kind and the numbers
of the route's video; `runtime` its length; `creditsOffset` where its credits begin. These come
from the server's rendering of the page, so they are there before the player has loaded and
while its controls are hidden.

**Read, unverified: the video metadata.** Titles and a film's year are in the video metadata
**of the route's video id**, which no static path reaches within the reader's bounds: a path
ending at `videoPlayer` (or at the whole metadata map) lands on every season of every video the
player loaded, cut at depth 6 and 32 KB at an unpredictable key. The two entries above reach it
with three bounded state-path steps instead:

- `{ routeGroup: 1 }` takes the key from the route — the video id — so no other video's
  metadata is read;
- `{ find: … }` finds, among at most 256 seasons and 256 episodes each, the episode whose `id`
  is the route's;
- `{ pick: [...] }` keeps the few keys read, so the entries are small whatever the show's
  length.

The place — `videoPlayer.videoMetadata[<video id>]._metadata.video` — and the shape
(`video.type`, `video.id`, `video.title`, `video.year`, `video.currentEpisode`,
`video.hiddenEpisodeNumbers`, `seasons[].seq`, `seasons[].episodes[]`, `episodes[].id`,
`.seq`, `.title`) are what public prior art reports for Netflix's metadata, **not yet seen in
the page state itself**. Where either is wrong, the entries read as nothing and the module
answers from the title area, as before. A maintainer confirms both in DevTools on a player page
(`/watch/<id>`) with this line, which prints **key names only, never values**:

```js
(() => {
  const id = location.pathname.match(/watch\/(\d+)/)[1];
  const vp = netflix.appContext.state.playerApp.getState().videoPlayer;
  const v = vp.videoMetadata?.[id]?._metadata?.video;
  const s = v?.seasons?.[0];
  return {
    videoPlayer: Object.keys(vp),
    metadataKeyIsRouteId: vp.videoMetadata ? Object.keys(vp.videoMetadata).includes(id) : null,
    video: v ? Object.keys(v) : null,
    season: s ? Object.keys(s) : null,
    episode: s?.episodes?.[0] ? Object.keys(s.episodes[0]) : null,
  };
})();
```

On a film, `season` and `episode` print `null`. If `videoMetadata` is not among
`videoPlayer`'s keys, or `video` prints `null`, the place differs: find the key under
`videoPlayer` that holds per-video entries and correct `ROUTE_VIDEO` in `definition.ts`.

## Known gaps

- Until the metadata is confirmed (or wherever it is absent), the titles come from the title
  area alone:
  - with the controls never shown, an episode has its kind and numbers (the Falcor summary)
    and no show title, so it is not sent until the title area was seen once; the viewing keeps
    what a reading lacks;
  - a single-season show's episode, read from the title area, has an episode number and no
    season, and is sent that way;
  - a film has no year.
- Whether the Falcor cache holds the summary of a video reached by in-app navigation is not
  known. Where it holds none, and neither the metadata nor the controls are in the page, a
  snapshot names no kind. The worker then keeps the identity the frame's previous reading of
  the same id on the same path had, so a title area seen once is enough; one
  never seen names nothing.
- **The show's own id comes from the player's metadata alone**, whose place is unverified: the
  Falcor summary, seen on the real page, names no show. Where the metadata is absent, an
  episode's play carries no show id, so the server can remember an answer by the episode's id
  and by its titles, not by the show. The show's id is wanted whenever the state has it.
- A trailer opened from a title's page plays on its own `/watch/<id>` and reads like a film.

## Verify it (the maintainer)

1. Build a development build, open Settings → **Diagnostics**, turn it on.
2. With the controls shown (move the mouse), **Capture page sample** on: an episode of a
   multi-season show; an episode of a single-season show; a film; the end of an episode, once
   _Next episode_ shows over the credits; the end of a film (the post-play screen); a trailer.
   Capture each episode a second time with the controls hidden.
3. Read each sample before keeping it: no profile, account, e-mail, token or URL query may be
   in it (the tool removes them; check anyway).
4. Compare each sample with the lists above — the selectors' values, the signal, the route, the
   sessions' `videoId` and `duration` (milliseconds?), `pageState.falcor`
   (present after an in-app navigation too?), and `pageState.video` / `.episode` (present on an
   episode and a film?) — and correct the
   definition where Netflix differs; run the DevTools line above where the metadata is absent.
5. Replace the synthetic fixtures in `fixtures/` with the captures (`"synthetic": false`), keep
   the expected readings in `definition.test.ts` true to them, bump `version`, and set
   `verified: { on: "<YYYY-MM-DD>", by: "<who>" }`. A store build drops the module again 90 days
   later unless it is verified anew.
