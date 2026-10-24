/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// The frame's snapshot, built from a fixture HTML page: selector values trimmed and capped at
// 300 chars, an invisible element skipped, a 6th match dropped, a malformed JSON-LD script ignored
// without throwing, `query` containing `v` only when declared. Selectors are bounded (≤ 5 values,
// ≤ 300 chars, visible only unless visibleOnly: false) and JSON-LD is parsed defensively (≤ 20
// objects, ≤ 64 KB of script text). The property-based half generates arbitrary pages.

import type { CollectSpec } from '@mt/services';
import fc from 'fast-check';
import { afterEach, describe, expect, test } from 'vitest';

import { buildSnapshot } from './snapshot';

const RUNS = { seed: 20261022, numRuns: 150 } as const;

/** A `Location` as `buildSnapshot` reads one. */
function at(url: string): Location {
  const u = new URL(url);
  return { hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash } as Location;
}

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.title = '';
});

const FIXTURE = `
  <h1 class="title">
       Breaking Bad
  </h1>
  <p class="long">${'x'.repeat(450)}</p>
  <span class="part">S1:E2</span>
  <span class="part" style="display:none">Hidden part</span>
  <span class="part">Cat's in the Bag...</span>
  <li class="many">1</li><li class="many">2</li><li class="many">3</li>
  <li class="many">4</li><li class="many">5</li><li class="many">6</li>
  <script type="application/ld+json">{ "@type": "TVEpisode", "name": "Cat's in the Bag..." </script>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"TVEpisode","name":"Cat's in the Bag...","episodeNumber":2}</script>
`;

const SPEC: CollectSpec = {
  selectors: {
    title: { css: '.title' },
    long: { css: '.long' },
    part: { css: '.part' },
    partAll: { css: '.part', visibleOnly: false },
    many: { css: '.many' },
  },
  jsonLd: true,
  queryParams: ['v'],
};

describe('buildSnapshot on a fixture page', () => {
  test('selector values are trimmed and capped at 300 characters', () => {
    document.body.innerHTML = FIXTURE;
    const s = buildSnapshot(document, at('https://www.example.com/watch?v=1'), SPEC, {});
    expect(s.selectors.title).toEqual(['Breaking Bad']);
    expect(s.selectors.long).toEqual(['x'.repeat(300)]);
  });

  test('an invisible element is skipped, unless visibleOnly is false', () => {
    document.body.innerHTML = FIXTURE;
    const s = buildSnapshot(document, at('https://www.example.com/'), SPEC, {});
    expect(s.selectors.part).toEqual(['S1:E2', "Cat's in the Bag..."]);
    expect(s.selectors.partAll).toEqual(['S1:E2', 'Hidden part', "Cat's in the Bag..."]);
  });

  test('a 6th match is dropped', () => {
    document.body.innerHTML = FIXTURE;
    const s = buildSnapshot(document, at('https://www.example.com/'), SPEC, {});
    expect(s.selectors.many).toEqual(['1', '2', '3', '4', '5']);
  });

  test('a malformed JSON-LD script is ignored without a throw', () => {
    document.body.innerHTML = FIXTURE;
    const s = buildSnapshot(document, at('https://www.example.com/'), SPEC, {});
    expect(s.jsonLd).toEqual([
      {
        '@context': 'https://schema.org',
        '@type': 'TVEpisode',
        name: "Cat's in the Bag...",
        episodeNumber: 2,
      },
    ]);
  });

  // `query` holds only the parameters a module declared.
  test('query holds the declared parameters only', () => {
    document.body.innerHTML = FIXTURE;
    const url = 'https://www.example.com/watch?v=abc&t=42&token=secret';
    expect(buildSnapshot(document, at(url), SPEC, {}).url.query).toEqual({ v: 'abc' });
    expect(buildSnapshot(document, at(url), { selectors: {} }, {}).url.query).toEqual({});
    expect(buildSnapshot(document, at(url), null, {}).url.query).toEqual({});
  });

  // The generic inputs are always collected, on a site without a module too.
  test('without a module the generic inputs are still collected', () => {
    document.head.innerHTML =
      '<meta property="og:type" content="video.movie"><meta property="og:title" content="Arrival">';
    document.body.innerHTML =
      '<script type="application/ld+json">{"@type":"Movie","name":"Arrival"}</script>';
    document.title = 'Arrival (2016)';
    const s = buildSnapshot(document, at('https://films.example/arrival'), null, {});
    expect(s.jsonLd).toEqual([{ '@type': 'Movie', name: 'Arrival' }]);
    expect(s.openGraph).toEqual({ 'og:type': 'video.movie', 'og:title': 'Arrival' });
    expect(s.documentTitle).toBe('Arrival (2016)');
    expect(s.selectors).toEqual({});
  });

  // Signals are read by the visibility of their selectors.
  test('a signal is true only while its element is visible', () => {
    document.body.innerHTML =
      '<div class="postplay">Next episode</div><div class="ad" style="display:none"></div>';
    const spec: CollectSpec = { signals: { endOfContent: '.postplay', adPlaying: '.ad' } };
    expect(buildSnapshot(document, at('https://www.example.com/'), spec, {}).signals).toEqual({
      endOfContent: true,
      adPlaying: false,
    });
  });

  test('at most 20 JSON-LD objects are kept', () => {
    document.body.innerHTML = Array.from(
      { length: 25 },
      (_, i) => `<script type="application/ld+json">{"@type":"Thing","n":${String(i)}}</script>`,
    ).join('');
    const s = buildSnapshot(document, at('https://www.example.com/'), null, {});
    expect(s.jsonLd.length).toBeLessThanOrEqual(20);
  });

  test('JSON-LD beyond 64 KB of script text is not kept', () => {
    const big = JSON.stringify({ '@type': 'Thing', pad: 'p'.repeat(40_000) });
    document.body.innerHTML = [big, big, big]
      .map((text) => `<script type="application/ld+json">${text}</script>`)
      .join('');
    const s = buildSnapshot(document, at('https://www.example.com/'), null, {});
    expect(s.jsonLd.length).toBe(1);
  });
});

describe('buildSnapshot on arbitrary pages (property-based)', () => {
  const CLASSES = ['a', 'b', 'c', 'd'] as const;

  const element = fc.record({
    cls: fc.constantFrom(...CLASSES),
    text: fc.oneof(
      fc.string({ maxLength: 40 }),
      fc.string({ maxLength: 1_500 }),
      fc.constantFrom('', '   ', '\n\t x \n'),
    ),
    hidden: fc.boolean(),
    attr: fc.option(fc.string({ maxLength: 600 }), { nil: undefined }),
  });

  /** JSON-LD script text: arbitrary text, or a JSON object carrying its own id, of any size. */
  const script = fc.oneof(
    fc.string({ maxLength: 200 }),
    fc
      .record({ id: fc.integer({ min: 0, max: 1_000_000 }), pad: fc.nat({ max: 50_000 }) })
      .map(({ id, pad }) => JSON.stringify({ '@type': 'Thing', mtId: id, pad: 'p'.repeat(pad) })),
    fc.jsonValue().map((value) => JSON.stringify(value)),
  );

  const meta = fc.record({
    name: fc.oneof(
      fc.constantFrom('og:type', 'og:title', 'video:series'),
      fc.string({ maxLength: 80 }).map((s) => `og:${s}`),
    ),
    content: fc.string({ maxLength: 1_200 }),
    as: fc.constantFrom('property', 'name'),
  });

  const selectorSpec = fc.record(
    {
      css: fc.constantFrom(...CLASSES.map((c) => `.${c}`), 'li', '[data-x]', ':::not css', ''),
      attr: fc.constantFrom('data-x', 'title'),
      visibleOnly: fc.boolean(),
      max: fc.integer({ min: -3, max: 12 }),
    },
    { requiredKeys: ['css'] },
  );

  const page = fc.record({
    elements: fc.array(element, { maxLength: 40 }),
    scripts: fc.array(script, { maxLength: 30 }),
    metas: fc.array(meta, { maxLength: 40 }),
    selectors: fc.dictionary(fc.string({ minLength: 1, maxLength: 40 }), selectorSpec, {
      maxKeys: 20,
    }),
    params: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 10 }),
      fc.string({ maxLength: 20 }),
      { maxKeys: 8 },
    ),
    declared: fc.array(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 10 }),
    title: fc.string({ maxLength: 3_000 }),
  });

  type Page = typeof page extends fc.Arbitrary<infer T> ? T : never;

  function render(p: Page): void {
    document.head.replaceChildren();
    document.body.replaceChildren();
    for (const e of p.elements) {
      const el = document.createElement('span');
      el.className = e.cls;
      el.textContent = e.text;
      if (e.attr !== undefined) {
        el.setAttribute('data-x', e.attr);
        el.setAttribute('title', e.attr);
      }
      if (e.hidden) el.style.display = 'none';
      document.body.append(el);
    }
    for (const text of p.scripts) {
      const el = document.createElement('script');
      el.type = 'application/ld+json';
      el.textContent = text;
      document.body.append(el);
    }
    for (const m of p.metas) {
      const el = document.createElement('meta');
      el.setAttribute(m.as, m.name);
      el.setAttribute('content', m.content);
      document.head.append(el);
    }
    document.title = p.title;
  }

  function locationOf(params: Readonly<Record<string, string>>): Location {
    const search = new URLSearchParams(params).toString();
    return at(`https://www.example.com/watch${search === '' ? '' : `?${search}`}`);
  }

  // It never throws; ≤ 5 values per selector, each ≤ 300 characters; `query` holds declared
  // params only
  test('never throws, and keeps every selector within 5 values of 300 characters', () => {
    fc.assert(
      fc.property(page, (p) => {
        render(p);
        const spec = {
          selectors: p.selectors,
          jsonLd: true,
          queryParams: p.declared,
        } as CollectSpec;
        const s = buildSnapshot(document, locationOf(p.params), spec, {});
        for (const values of Object.values(s.selectors)) {
          expect(values.length).toBeLessThanOrEqual(5);
          for (const value of values) expect(value.length).toBeLessThanOrEqual(300);
        }
        for (const name of Object.keys(s.url.query)) expect(p.declared).toContain(name);
      }),
      RUNS,
    );
  });

  // JSON-LD is limited to ≤ 20 objects and ≤ 64 KB examined — every kept object comes from
  // script text that, summed, stays within 64 KB
  test('JSON-LD keeps at most 20 objects, from at most 64 KB of script text', () => {
    fc.assert(
      fc.property(page, (p) => {
        render(p);
        const s = buildSnapshot(document, locationOf(p.params), null, {});
        expect(s.jsonLd.length).toBeLessThanOrEqual(20);
        const kept = s.jsonLd
          .map((value) =>
            typeof value === 'object' && value !== null
              ? (value as { mtId?: unknown }).mtId
              : undefined,
          )
          .filter((id): id is number => typeof id === 'number');
        const sources = p.scripts.filter((text) =>
          kept.some((id) => text.includes(`"mtId":${String(id)},`)),
        );
        const examined = sources.reduce((sum, text) => sum + text.length, 0);
        expect(examined).toBeLessThanOrEqual(64 * 1024);
        expect(JSON.stringify(s.jsonLd).length).toBeLessThanOrEqual(64 * 1024);
      }),
      RUNS,
    );
  });

  // The protocol bounds the collector builds within (a snapshot is never refused for what the
  // page holds): every snapshot is plain JSON.
  test('the snapshot is plain JSON', () => {
    fc.assert(
      fc.property(page, (p) => {
        render(p);
        const s = buildSnapshot(document, locationOf(p.params), { selectors: p.selectors }, {});
        expect(JSON.parse(JSON.stringify(s))).toEqual(s);
      }),
      { ...RUNS, numRuns: 60 },
    );
  });
});
