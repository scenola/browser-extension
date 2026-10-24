/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The fixture "streaming" sites, routed with `context.route` so nothing leaves the
// machine. Each page is shaped like the module's synthetic fixture (the DOM its selectors read,
// the player state its paths walk — packages/services/src/services/netflix/fixtures/*), with the
// same titles: Breaking Bad S1 E2 "Cat's in the Bag...", Netflix video 70196253. Every page
// plays silence (media.ts) and exposes a small `window.e2e` for the test to drive it the way a
// person or a player would: play, mute, move on to the next episode, show the post-play screen.
//
// Every fixture is synthetic: no title, id or page here was captured from a real service.

import type { BrowserContext, Route } from '@playwright/test';

import { silentWav } from './media.ts';

/**
 * How long each fixture's media runs, in seconds. ≥ 120 s: shorter media is not counted as
 * content.
 */
export const EPISODE_SECONDS = 300;
export const FILM_SECONDS = 600;
const PREVIEW_SECONDS = 200;

/**
 * Real seconds a fixture plays at 1× before it speeds up. A tab binds to a viewing only once
 * its reading held still for two observations, and the collector samples every 15 s of real
 * time, so binding takes 15–20 s whatever the rate. At 16× from the first frame those seconds
 * would be four minutes of media nobody could cover; a person's first 20 s at 1×, then 16×, is
 * the same viewing, compressed.
 */
const BIND_SECONDS = 21;

/**
 * A sample is taken this long before the end. An element that ended reports `paused`, and the
 * coverage rule adds nothing to or from a paused sample, so the stretch between the last
 * playing sample and `ended` never counts. At 1× and a sample every 15 s that is under 15 s of
 * a viewing; at 16× it would be up to four minutes.
 */
const TAIL_SECONDS = 4;

interface NetflixEpisode {
  readonly videoId: number;
  readonly seq: number;
  readonly title: string;
}

/** Breaking Bad's first season, by Netflix's sequential episode ids. */
const BREAKING_BAD = {
  showId: 70143836,
  title: 'Breaking Bad',
  year: 2008,
  season: 1,
  episodes: [
    { videoId: 70196252, seq: 1, title: 'Pilot' },
    { videoId: 70196253, seq: 2, title: "Cat's in the Bag..." },
    { videoId: 70196254, seq: 3, title: "...And the Bag's in the River" },
    { videoId: 70196255, seq: 4, title: 'Cancer Man' },
  ] satisfies NetflixEpisode[],
};

interface NetflixFilm {
  readonly videoId: number;
  readonly title: string;
  readonly year: number;
  readonly seconds: number;
}

/** Netflix's film fixture (film.snapshot.json). */
const THE_IRISHMAN: NetflixFilm = {
  videoId: 80175798,
  title: 'The Irishman',
  year: 2019,
  seconds: FILM_SECONDS,
};

/**
 * The two titles of a case seen on a real Netflix tab (browse → watch A → watch B in one
 * document), at two lengths, so a sample of one reaching the other's viewing would show.
 */
const FILM_A: NetflixFilm = {
  videoId: 81646431,
  title: 'Fixture Film A',
  year: 2025,
  seconds: EPISODE_SECONDS,
};
const FILM_B: NetflixFilm = {
  videoId: 81646432,
  title: 'Fixture Film B',
  year: 2026,
  seconds: FILM_SECONDS,
};

const FILMS: readonly NetflixFilm[] = [THE_IRISHMAN, FILM_A, FILM_B];

/** Every Netflix video id a fixture page knows. */
const NETFLIX_IDS: readonly number[] = [
  ...BREAKING_BAD.episodes.map((e) => e.videoId),
  ...FILMS.map((f) => f.videoId),
];

const html = (head: string, body: string, script = ''): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head>` +
  `<body style="margin:0;background:#111;color:#eee;font:16px sans-serif">${body}` +
  `<script>${DRIVER}${script}</script></body></html>`;

/** The page's own driver: what the test asks the page to do, in the page's world. */
const DRIVER = `
window.e2e = {
  video(index = 0) { return document.querySelectorAll('video')[index]; },
  async play(index = 0, rate = 16) {
    const v = this.video(index);
    if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
    v.playbackRate = rate;
    await v.play();
  },
  /**
   * Plays as a person would, compressed: ${String(BIND_SECONDS)} s at 1× (the tab binds), then 16×;
   * ${String(TAIL_SECONDS)} s before the end a change of rate (16× → 15×) is a sample of its own,
   * so one lands just before \`ended\`.
   */
  async watch(index = 0) {
    const v = this.video(index);
    await this.play(index, 1);
    await this.at(v.currentTime + ${String(BIND_SECONDS)}, index);
    const tail = () => {
      if (v.duration - v.currentTime <= ${String(TAIL_SECONDS)}) {
        v.removeEventListener('timeupdate', tail);
        if (v.playbackRate === 16) v.playbackRate = 15;
      }
    };
    v.addEventListener('timeupdate', tail);
    this.rate(16, index);
  },
  pause(index = 0) { this.video(index).pause(); },
  seek(seconds, index = 0) { this.video(index).currentTime = seconds; },
  mute(index = 0) { this.video(index).muted = true; },
  rate(rate, index = 0) { this.video(index).playbackRate = rate; },
  ended(index = 0) { return new Promise((r) => { const v = this.video(index); if (v.ended) r(); else v.addEventListener('ended', () => r(), { once: true }); }); },
  at(seconds, index = 0) {
    return new Promise((r) => {
      const v = this.video(index);
      const check = () => { if (v.currentTime >= seconds) { v.removeEventListener('timeupdate', check); r(); } };
      v.addEventListener('timeupdate', check); check();
    });
  },
};`;

function media(seconds: number): string {
  return `/e2e-media/${String(seconds)}.wav`;
}

function video(seconds: number, attrs = ''): string {
  return `<video src="${media(seconds)}" preload="auto" ${attrs} style="display:block;width:1120px;height:630px;background:#000"></video>`;
}

// ── Netflix ─────────────────────────────────────────────────────────────────────────────────

/** How long a Netflix video's media runs. */
function netflixSeconds(videoId: number): number {
  return FILMS.find((f) => f.videoId === videoId)?.seconds ?? EPISODE_SECONDS;
}

/** The player's state as the module's paths walk it (the Netflix README's _Page state_). */
function netflixState(videoId: number): string {
  const episodes = BREAKING_BAD.episodes;
  const episode = episodes.find((e) => e.videoId === videoId);
  const film = FILMS.find((f) => f.videoId === videoId);
  const metadata: Record<string, unknown> = {};
  if (episode !== undefined) {
    const video = {
      type: 'show',
      id: BREAKING_BAD.showId,
      title: BREAKING_BAD.title,
      year: BREAKING_BAD.year,
      currentEpisode: videoId,
      hiddenEpisodeNumbers: false,
      seasons: [{ seq: BREAKING_BAD.season, episodes }],
    };
    for (const e of episodes) metadata[String(e.videoId)] = { _metadata: { video } };
  } else if (film !== undefined) {
    metadata[String(film.videoId)] = {
      _metadata: {
        video: {
          type: 'movie',
          id: film.videoId,
          title: film.title,
          year: film.year,
          hiddenEpisodeNumbers: false,
        },
      },
    };
  }
  const session = {
    videoId,
    duration: netflixSeconds(videoId) * 1000,
    currentTime: 0,
    paused: false,
    playing: true,
  };
  return JSON.stringify({
    videoPlayer: { playbackStateBySessionId: { c0ffee01: session }, videoMetadata: metadata },
  });
}

function netflixTitleArea(videoId: number): string {
  const episode = BREAKING_BAD.episodes.find((e) => e.videoId === videoId);
  if (episode === undefined) {
    const film = FILMS.find((f) => f.videoId === videoId);
    return `<div data-uia="video-title"><h4>${film?.title ?? ''}</h4></div>`;
  }
  return (
    `<div data-uia="video-title"><h4>${BREAKING_BAD.title}</h4>` +
    `<span>S${String(BREAKING_BAD.season)}:E${String(episode.seq)}</span>` +
    `<span>${episode.title}</span></div>`
  );
}

/** The player's script, shared by a player page and the browse page that mounts one. */
function netflixScript(videoId: number | null): string {
  const byId = (render: (id: number) => unknown) =>
    JSON.stringify(Object.fromEntries(NETFLIX_IDS.map((id) => [id, render(id)])));
  return `
let state = ${videoId === null ? '{}' : netflixState(videoId)};
window.netflix = { appContext: { state: { playerApp: { getState: () => state } } } };
const states = ${byId(netflixState)};
const areas = ${byId(netflixTitleArea)};
const media = ${byId((id) => media(netflixSeconds(id)))};
// Netflix's autoplay and its in-app navigation: the same <video> element, the next title's
// address (history.pushState), title area and stream.
window.e2e.nextTitle = async (nextId, query = '') => {
  document.querySelector('.postplay')?.remove();
  history.pushState({}, '', '/watch/' + nextId + query);
  state = JSON.parse(states[nextId]);
  document.getElementById('title-area').innerHTML = areas[nextId];
  const v = window.e2e.video();
  const muted = v.muted;
  v.src = media[nextId] + '?title=' + nextId;
  v.muted = muted;
  await window.e2e.watch();
};
window.e2e.nextEpisode = (nextId) => window.e2e.nextTitle(nextId);
// The browse page's Play: the billboard goes, the address becomes the player's (pushState), and
// the player mounts with its title area — one document throughout.
window.e2e.openPlayer = (id, query = '') => {
  document.getElementById('billboard')?.remove();
  history.pushState({}, '', '/watch/' + id + query);
  state = JSON.parse(states[id]);
  const player = document.getElementById('player-root');
  player.innerHTML = '<div id="title-area">' + areas[id] + '</div>' +
    '<video src="' + media[id] + '" preload="auto" style="display:block;width:1120px;height:630px;background:#000"></video>';
};
// The post-play screen over the credits (the module's endOfContent signal, '.postplay').
window.e2e.showPostplay = () => {
  const screen = document.createElement('div');
  screen.className = 'postplay';
  screen.style.cssText = 'position:fixed;inset:auto 0 0 auto;width:320px;height:180px;background:#222';
  screen.textContent = 'Next';
  document.body.append(screen);
};
`;
}

function netflixPlayer(videoId: number): string {
  return html(
    '<title>Netflix</title>',
    `<div id="title-area">${netflixTitleArea(videoId)}</div>${video(netflixSeconds(videoId))}`,
    netflixScript(videoId),
  );
}

/**
 * Netflix's browse page: a billboard trailer that plays with sound (not a player route, so it
 * starts nothing), and a Play button that becomes the player without loading a document.
 */
function netflixBrowse(): string {
  return html(
    '<title>Netflix</title>',
    `<div id="billboard">${video(PREVIEW_SECONDS)}` +
      `<button id="play" type="button" onclick="window.e2e.openPlayer(${String(FILM_A.videoId)}, '?trackId=1')">Play</button></div>` +
      '<div id="player-root"></div>',
    netflixScript(null),
  );
}

// ── Sites without a module ─────────────────────────────────────────────────────────────────

/** Arrival (2016), IMDb tt2543164: a page that says it is a film, in JSON-LD. */
const ARRIVAL_JSON_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Movie',
  name: 'Arrival',
  datePublished: '2016-11-11',
  sameAs: 'https://www.imdb.com/title/tt2543164/',
});

function genericFilm(extra = ''): string {
  return html(
    `<title>Arrival — Fixture Films</title><script type="application/ld+json">${ARRIVAL_JSON_LD}</script>`,
    `<h1>Arrival</h1>${extra}`,
  );
}

function genericPage(path: string): string | null {
  switch (path) {
    case '/film':
      return genericFilm(video(EPISODE_SECONDS));
    case '/clip':
      // A video that is not a film or an episode by its own account (ignored).
      return html(
        '<title>A clip — Fixture Films</title><meta property="og:type" content="video.other"><meta property="og:title" content="A clip">',
        `<h1>A clip</h1>${video(EPISODE_SECONDS)}`,
      );
    case '/trailer':
      // A header trailer: muted autoplay, as Chrome's autoplay policy makes them.
      return genericFilm(video(EPISODE_SECONDS, 'muted autoplay playsinline'));
    case '/film-and-preview':
      // The film, and a smaller muted preview beside it.
      return genericFilm(
        video(FILM_SECONDS) +
          `<video src="${media(PREVIEW_SECONDS)}" preload="auto" muted playsinline style="display:block;width:320px;height:180px"></video>`,
      );
    default:
      return null;
  }
}

/** YouTube's watch page, saying it is a film: only the block list keeps it out. */
function youtubeWatch(): string {
  return html(
    `<title>Arrival - YouTube</title><script type="application/ld+json">${ARRIVAL_JSON_LD}</script><meta property="og:type" content="video.movie">`,
    video(EPISODE_SECONDS),
  );
}

// ── routing ────────────────────────────────────────────────────────────────────────────────

const wavs = new Map<number, Buffer>();

function wav(seconds: number): Buffer {
  let found = wavs.get(seconds);
  if (found === undefined) {
    found = silentWav(seconds);
    wavs.set(seconds, found);
  }
  return found;
}

/**
 * The media, with byte ranges (RFC 9110 §14): Chrome seeks a stream by asking for the bytes at
 * the new position, and without a `206` a seek lands wherever the download has got to — a skim
 * would quietly become a viewing.
 */
async function serveMedia(route: Route, pathname: string): Promise<boolean> {
  const match = /^\/e2e-media\/(\d+)\.wav$/u.exec(pathname);
  if (match === null) return false;
  const body = wav(Number(match[1]));
  const range = /^bytes=(\d+)-(\d*)$/u.exec(route.request().headers().range ?? '');
  if (range === null) {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(body.length),
        'Accept-Ranges': 'bytes',
      },
      body,
    });
    return true;
  }
  const start = Number(range[1]);
  const end = range[2] === '' || range[2] === undefined ? body.length - 1 : Number(range[2]);
  if (start >= body.length || end < start) {
    await route.fulfill({
      status: 416,
      headers: { 'Content-Range': `bytes */${String(body.length)}` },
    });
    return true;
  }
  const last = Math.min(end, body.length - 1);
  await route.fulfill({
    status: 206,
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(last - start + 1),
      'Content-Range': `bytes ${String(start)}-${String(last)}/${String(body.length)}`,
      'Accept-Ranges': 'bytes',
    },
    body: body.subarray(start, last + 1),
  });
  return true;
}

function netflixPage(pathname: string): string | null {
  if (pathname === '/browse') return netflixBrowse();
  const watch = /^\/watch\/(\d+)$/u.exec(pathname);
  return watch === null ? null : netflixPlayer(Number(watch[1]));
}

const SITES = /^https:\/\/(?:www\.netflix\.com|fixture\.example|www\.youtube\.com)\//u;

export async function routeSites(context: BrowserContext): Promise<void> {
  await context.route(SITES, async (route) => {
    const url = new URL(route.request().url());
    if (await serveMedia(route, url.pathname)) return;
    let body: string | null = null;
    if (url.hostname === 'www.netflix.com') {
      body = netflixPage(url.pathname);
    } else if (url.hostname === 'fixture.example') {
      body = genericPage(url.pathname);
    } else if (url.pathname === '/watch') {
      body = youtubeWatch();
    }
    if (body === null) {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not a fixture' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });
}

export const NETFLIX = {
  episode: (videoId = 70196253) => `https://www.netflix.com/watch/${String(videoId)}`,
  film: () => `https://www.netflix.com/watch/${String(THE_IRISHMAN.videoId)}`,
  browse: 'https://www.netflix.com/browse',
  filmA: FILM_A,
  filmB: FILM_B,
};

export const GENERIC = {
  film: 'https://fixture.example/film',
  clip: 'https://fixture.example/clip',
  trailer: 'https://fixture.example/trailer',
  filmAndPreview: 'https://fixture.example/film-and-preview',
};

export const YOUTUBE = 'https://www.youtube.com/watch?v=x';
