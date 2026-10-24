# Privacy: what MediaTracker for Chrome keeps and sends

MediaTracker for Chrome adds the films and episodes you watch to your
MediaTracker diary. To do that it has to notice what you play. This page says
exactly what it keeps, where, whether any of it leaves your browser, and for
how long. The extension shows the same table on its settings page, under
_About_.

## In one paragraph

The extension reads a streaming page only once a video plays there. The moment
you have played your MediaTracker account's share of a film or an episode, it
sends MediaTracker a short description of it — the fields listed below,
nothing else — over your connection. If your MediaTracker account saves films
you start (a setting in MediaTracker, off unless you turn it on), it also sends
one start when you are part way into a film: the same fields, without a time.
It sends nothing anywhere else: no analytics, no telemetry, no crash reports, no
third parties. Everything else it keeps stays in your browser, and you can see
it, export it or delete it.

## What is kept, and where

| What                                                                                                           | Where it is kept                                                                               | Does it leave your browser?                         | How long                                                                           |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| What a page says is playing, and how far it has got                                                            | In memory, then in the extension's own storage in this browser while the viewing is open       | No                                                  | Until the viewing is added or skipped, 7 days without watching, or you disconnect  |
| A watched film or episode: the fields shown in _What was sent_                                                 | In this browser until it is sent; then in the local history                                    | **Yes**, to MediaTracker, over your connection      | History: 1, 7 or 30 days, as you choose (7 to begin with), or until you disconnect |
| A film you started, if your account saves starts: the fields shown in _What was sent_                          | In this browser until it is sent; then in the local history                                    | **Yes**, to MediaTracker, over your connection      | History: 1, 7 or 30 days, as you choose (7 to begin with), or until you disconnect |
| MediaTracker's answers about those plays                                                                       | The local history                                                                              | No — they come from MediaTracker                    | As long as the history, or until you disconnect                                    |
| Your account's two lines — when a viewing is added, when a film you start is saved — as MediaTracker last said | Chrome's storage for this extension                                                            | No — it comes from MediaTracker                     | Until you disconnect or clear the extension's data; a new connection reads its own |
| Your connection to MediaTracker, and its key                                                                   | The extension's own storage in this browser                                                    | The connection, to MediaTracker only. The key never | Until you disconnect, clear the extension's data, or the connection expires        |
| Which MediaTracker account the connection acts for: a code that tells accounts apart without naming anyone     | The extension's own storage, beside the connection and on each play, viewing and history entry | No — it comes from MediaTracker                     | As long as what it is on; until you disconnect or clear the extension's data       |
| Your settings                                                                                                  | Chrome's storage for this extension                                                            | No                                                  | Until you remove the extension                                                     |
| The diagnostics log, if you turn it on                                                                         | This browser, with sign-in details removed                                                     | Only if you attach it to a report yourself          | 7 days (at most 500 entries), or until you disconnect                              |

## A play belongs to one account

Each play, start, viewing and history entry is kept with a code for the
MediaTracker account it was recorded for. MediaTracker gives the extension
that code when it checks its connection: the same for every connection of
your account from this extension, different for anyone else's, and it says
nothing about who you are. The extension only compares it; it never shows it,
logs it or puts it in an export.

- **After any new connection** (signing in again, or someone else signing in
  in this browser) the extension sends nothing until MediaTracker has said
  which account the connection is for. Then it deletes, without sending,
  everything kept for another account — and anything recorded while no
  account was known, such as a film watched before you connected. If that
  check cannot be made, everything waits, unsent and not shown, and it is
  asked again.
- If the same account connects again, what waited for it is sent.
- A connection made before the extension kept these codes takes everything it
  kept as its own, the first time MediaTracker names its account.

## What a play contains

When a film or an episode counts, MediaTracker receives:

- whether it is a film or an episode;
- its title and year (for an episode, the episode's own title, the show's
  title and year, and the season and episode numbers) — as the page itself
  shows them;
- the streaming service's own ids for it, and an IMDb or TMDB id only when the
  page itself states one;
- when it counted, how long it is, how far you had played, how long its story
  is (the running time without the intro and the end credits) and how many
  seconds of the story you had played, and whether the player had reached its
  end or the service had shown its end (credits or the next-episode screen) —
  all as they were at that moment.

It is sent the moment you have played your MediaTracker account's share of the
story (50 %, 70 % or 90 %, chosen in MediaTracker; 70 % unless you change it),
wherever you are in it, and only once: what you play after that sends nothing.
Skipped time is not played, so skimming to the end sends nothing. The
extension learns the share when it checks its connection and keeps it in this
browser; it has no counting setting of its own.

It never contains the page's address, the site's name, the page's title, your
account or profile name on the streaming service, or anything else from the
page.

You can see the exact data for every play: open the toolbar button, choose a
play under _Recently_, and _What was sent_ shows the body that left your
browser and MediaTracker's answer.

## What a start contains

Your MediaTracker account can save a film you have begun as _in progress_, so
the app can remind you to finish it. You choose this in MediaTracker (after
5 %, 10 % or 20 % of a film, and never before five minutes), and it is off
until you do; the extension cannot change it. It learns your choice when it
checks its connection, and keeps it in this browser.

When you have played that much of a film's story, the extension sends one
**start**: the same fields a play would carry — film, title, year, the
service's ids, how long it and its story are, how far you played and how much
of the story — and nothing else. It carries no time and does not say whether
the film ended: it says only that you began it. When you reach the account's
share of the film, it is sent again as a play. Episodes never send a start.

A start shows under _Recently_ as _Started_, and _What was sent_ shows its
body like any play's.

## What MediaTracker can and cannot do with the connection

The connection can **add** viewings to your diary, save a film you started as
in progress when your account asks for that, and read back MediaTracker's
answers about the plays it sent. It cannot read your library, your diary or
anything else in your account. MediaTracker decides what each play is; a wrong
one is fixed in MediaTracker, from the play's link.

The connection is bound to a key that your browser created and will not let
anything — not even the extension — copy out. Someone who copied the
connection without the key could not use it.

## Where it reads, and where it never does

- It reads a page only after a video starts playing there, and only on the
  built-in services, on sites you allowed, or on any site if you turned on
  _Also track films and episodes on other sites_.
- On a site without its own module, it starts a viewing only when the page says
  it is a film or an episode, or a series whose address names the episode.
  Anything else — a course, a news clip, a social video — is not tracked, and
  nothing about it is sent. The tab keeps only why, on this device — a word
  such as "the page names nothing", never a title or an address — so the
  toolbar button's popup can say it while the video plays. The address itself
  never leaves the browser; only the season and episode it names go into a
  play.
- It never reads YouTube, or sites on russian domains (`.ru` and `.рф`),
  whatever you allowed. Sites you exclude in the settings are never read either.
- In incognito windows it reads nothing unless you turn that on in the
  settings (Chrome must allow the extension in incognito too). If you do, a
  film or an episode watched there is treated like any other: it is sent once
  it reaches your line, and what the extension keeps about it — the open
  viewing, the history, the diagnostics log if it is on — is kept in the same
  storage as everything else, for the same times. Closing the incognito
  window does not delete it; _Clear all local data_ or disconnecting does.

## Your controls

All of these are on the extension's settings page:

- **Pause tracking** (from the toolbar button) for an hour, until the next
  morning, or until you turn it back on.
- **Skip** (from the toolbar button) a viewing you would rather not add.
- **Turn off** any built-in service, **exclude** any site, and **remove** any
  site you allowed.
- **Keep history for** 1, 7 or 30 days (7 to begin with): plays already sent,
  and MediaTracker's answers, leave this browser after that long.
- **Clear history**: deletes the plays already sent and MediaTracker's answers
  from this browser, after asking you first — what _Recently_ and _What was
  sent_ show. Your diary in MediaTracker is not touched, and plays not sent
  yet, what you are watching now, your settings and the connection stay.
- **Export my extension data**: a JSON file of your settings, open viewings,
  history and plays waiting to be sent. It never contains the connection, its
  key, or the code for your account.
- **Clear all local data**: deletes everything the extension keeps in this
  browser, its connection included, after asking you first. Your diary in
  MediaTracker is not touched.
- **Disconnect from this browser**: your account leaves this browser, with
  everything the extension kept for it. See below.

## Disconnecting

What the extension records belongs to the MediaTracker account it was
recorded for, and to no one else who might connect in this browser later. So
_Disconnect from this browser_ removes the account and all of it:

- the connection and its key, so they can never be used again;
- the plays and starts not sent yet;
- the local history (_Recently_, _What was sent_ and MediaTracker's answers);
- what you are watching now, viewings you skipped, and what each tab was
  playing;
- your account's two lines, and what MediaTracker last said about the
  connection;
- the diagnostics log, since it tells what happened while that account was
  connected. If diagnostics are on, they stay on and a new log starts.

It keeps what belongs to the browser rather than to an account: your tracked
sites, _Also track films and episodes on other sites_, incognito tracking, a
pause, and whether diagnostics are on.

It asks first, and says how many plays have not been sent yet. While the
connection works, you can **send them first** (the extension then tries for at
most 10 seconds, disconnects, and says how many went and how many could not
and were deleted) or **delete them** with the rest. Without a working
connection nothing can be sent, so they are deleted.

Plays already sent are in your MediaTracker account, not in this browser:
disconnecting does not remove them. Remove them, or the connection itself, in
MediaTracker under _Connected services_.

The connection is forgotten first, so nothing is sent once you have chosen to
disconnect, apart from the plays you asked to send first. If the browser stops
in the middle, the rest is removed the next time the extension starts, and in
any case before another account can connect.

## Diagnostics and page samples

Both are for reporting a service that is not tracked correctly, and both stay
in your browser unless you attach them to a report yourself.

- The **diagnostics log** is off by default. When on, it records what the
  extension did as short event names and ids — never a title, an address, page
  text or anything you could sign in with — and keeps them 7 days.
- **Capture page sample** records what the extension reads on the page that
  played last, with accounts, profiles, e-mail addresses, tokens, sign-in
  details and address queries removed. It is shown to you before you save it.
- The extension takes from a page only what it reads: the few Open Graph tags
  that say what the page is (its type, its title, its series, its release
  date), and from the page's structured data only the fields that name a film
  or an episode. It never takes the page's image links, its description or
  its own link, so a sample holds none of them either. (A built-in service's
  module that reads the structured data itself gets it as the page states it.)
- Above the sample, the settings page says what it holds, part by part, which
  parts were read this time, how many things of each kind were removed (the
  file says so too), and where it goes: nowhere. The file is saved only when
  you press _Save sample_; attached to a public issue, anyone can read it.

## Changes

Anything new the extension keeps or sends will be listed here, on the settings
page's _About_, and in the store listing, in the same release.
