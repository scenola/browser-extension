/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// A page sample holds only what a reader reads. A page that carries an image link, a description,
// its own link and a dozen other tags gives a snapshot with none of them: the Open Graph tags the
// readers use and no other, and JSON-LD cut to the fields the reader reads. A site's module that
// declared its selectors still gets exactly those, and one that declared the JSON-LD gets it
// whole.

import type { CollectSpec } from '@mt/services';
import { afterEach, describe, expect, test } from 'vitest';

import { buildSnapshot } from './snapshot';

function at(url: string): Location {
  const u = new URL(url);
  return { hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash } as Location;
}

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.title = '';
});

const PAGE = at('https://films.example/arrival');
const IMDB = 'https://www.imdb.com/title/tt2543164/';

const tag = (property: string, content: string, attribute = 'property'): string =>
  `<meta ${attribute}="${property}" content="${content}">`;

describe('Open Graph: the tags a reader reads and no other', () => {
  const TAGS = [
    tag('og:type', 'video.movie'),
    tag('og:title', 'Arrival'),
    tag('video:series', 'Some Show'),
    tag('video:release_date', '2016-11-11'),
    // A real page's others: none of them is read.
    tag('og:image', 'https://films.example/poster.jpg'),
    tag('og:url', 'https://films.example/arrival?utm_source=mail'),
    tag('og:video', 'https://films.example/stream.mp4'),
    tag('og:description', 'A linguist is hired to talk to aliens.'),
    tag('og:updated_time', '2026-10-01T10:00:00+0000'),
    tag('og:site_name', 'Fixture Films'),
    tag('og:locale', 'en_US'),
    tag('video:duration', '900'),
    tag('og:duration', '900'),
    tag('twitter:image', 'https://films.example/card.jpg', 'name'),
    tag('article:author', 'Someone'),
  ].join('');

  test('only og:type, og:title, video:series and video:release_date are gathered', () => {
    document.head.innerHTML = TAGS;
    const { openGraph } = buildSnapshot(document, PAGE, null, {});
    expect(openGraph).toEqual({
      'og:type': 'video.movie',
      'og:title': 'Arrival',
      'video:series': 'Some Show',
      'video:release_date': '2016-11-11',
    });
  });

  test('a site’s module gets the same tags when it asks for Open Graph', () => {
    document.head.innerHTML = TAGS;
    const spec: CollectSpec = { openGraph: true };
    const { openGraph } = buildSnapshot(document, PAGE, spec, {});
    expect(Object.keys(openGraph).sort()).toEqual([
      'og:title',
      'og:type',
      'video:release_date',
      'video:series',
    ]);
  });

  test('the same tags by name are read, and a name that only looks like one is not', () => {
    document.head.innerHTML =
      tag('og:title', 'Arrival', 'name') + tag('og:image:alt', 'x') + tag('og:titlex', 'y');
    const { openGraph } = buildSnapshot(document, PAGE, null, {});
    expect(openGraph).toEqual({ 'og:title': 'Arrival' });
  });

  test('nothing of a skipped tag is held anywhere in the snapshot', () => {
    document.head.innerHTML = TAGS;
    const text = JSON.stringify(buildSnapshot(document, PAGE, null, {}));
    for (const leaked of ['poster.jpg', 'utm_source', 'stream.mp4', 'aliens', 'Fixture Films']) {
      expect(text, leaked).not.toContain(leaked);
    }
  });
});

describe('JSON-LD: cut to what the reader reads', () => {
  const script = (value: unknown): string =>
    `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

  const MOVIE = {
    '@context': 'https://schema.org',
    '@type': 'Movie',
    name: 'Arrival',
    datePublished: '2016-11-11',
    image: 'https://films.example/poster.jpg',
    description: 'A linguist is hired to talk to aliens.',
    thumbnailUrl: 'https://films.example/thumb.jpg',
    embedUrl: 'https://films.example/embed/1',
    url: 'https://films.example/arrival?session=abc123',
    sameAs: [IMDB, 'https://twitter.com/arrival', 'https://films.example/arrival?token=xyz'],
  };

  test('the name, type and date stay; the image, description and links go', () => {
    document.body.innerHTML = script(MOVIE);
    const [node] = buildSnapshot(document, PAGE, null, {}).jsonLd as Record<string, unknown>[];
    expect(node).toMatchObject({ '@type': 'Movie', name: 'Arrival', datePublished: '2016-11-11' });
    for (const gone of ['image', 'description', 'thumbnailUrl', 'embedUrl']) {
      expect(node, gone).not.toHaveProperty(gone);
    }
  });

  test('sameAs and url keep only the values that hold an IMDb title id', () => {
    document.body.innerHTML = script(MOVIE);
    const text = JSON.stringify(buildSnapshot(document, PAGE, null, {}).jsonLd);
    expect(text).toContain('tt2543164');
    for (const gone of ['twitter.com', 'token=xyz', 'session=abc123', 'films.example/arrival?']) {
      expect(text, gone).not.toContain(gone);
    }
  });

  test('a url that is the IMDb title’s is kept', () => {
    document.body.innerHTML = script({ '@type': 'Movie', name: 'Arrival', url: IMDB });
    const [node] = buildSnapshot(document, PAGE, null, {}).jsonLd as Record<string, unknown>[];
    expect(JSON.stringify(node)).toContain('tt2543164');
  });

  test('a nested node is cut the same way', () => {
    document.body.innerHTML = script({
      '@type': 'TVEpisode',
      name: 'Pilot',
      image: 'https://films.example/still.jpg',
      partOfSeries: {
        '@type': 'TVSeries',
        name: 'Some Show',
        description: 'secret plot',
        sameAs: 'https://twitter.com/show',
      },
    });
    const text = JSON.stringify(buildSnapshot(document, PAGE, null, {}).jsonLd);
    expect(text).toContain('Some Show');
    expect(text).not.toContain('secret plot');
    expect(text).not.toContain('still.jpg');
    expect(text).not.toContain('twitter.com');
  });

  test('a site’s module that declared the JSON-LD gets it as it was', () => {
    document.body.innerHTML = script(MOVIE);
    const spec: CollectSpec = { jsonLd: true };
    const [node] = buildSnapshot(document, PAGE, spec, {}).jsonLd as Record<string, unknown>[];
    expect(node).toMatchObject({
      image: 'https://films.example/poster.jpg',
      description: 'A linguist is hired to talk to aliens.',
    });
  });
});

describe('what a module declared is gathered as it was', () => {
  test('its selectors and its query parameters, and the address without the page’s own query', () => {
    document.body.innerHTML = '<h1 class="title">Arrival</h1>';
    const spec: CollectSpec = { selectors: { title: { css: '.title' } }, queryParams: ['showId'] };
    const snapshot = buildSnapshot(
      document,
      at('https://tv.example/watch/1?showId=umc.cmc.1&token=secret#t:5'),
      spec,
      {},
    );
    expect(snapshot.selectors).toEqual({ title: ['Arrival'] });
    expect(snapshot.url.query).toEqual({ showId: 'umc.cmc.1' });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });
});
