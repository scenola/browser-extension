/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The toolbar marks, rendered at build time: each SVG under
// `apps/extension/assets/icons/` becomes a PNG per size, `<mark>-<size>.png`. The build copies
// them into the extension's `icons/`; nothing rendered is committed.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Resvg } from '@resvg/resvg-js';

/** One SVG at one square size, as PNG bytes. Fonts are never loaded: the marks have no text. */
function renderPng(svg: string, size: number): Uint8Array {
  if (!Number.isInteger(size) || size < 1 || size > 1024) {
    throw new RangeError('an icon size is a whole number of pixels, 1 to 1024');
  }
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: false },
    background: 'rgba(0, 0, 0, 0)',
  });
  return resvg.render().asPng();
}

/**
 * Renders `<srcDir>/<mark>.svg` at every size into `outDir`, answering the file names written
 * (`mark-filled-16.png`, …) in mark then size order.
 */
export async function renderIcons(
  srcDir: string,
  outDir: string,
  marks: readonly string[],
  sizes: readonly number[],
): Promise<readonly string[]> {
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const mark of marks) {
    const svg = await readFile(join(srcDir, `${mark}.svg`), 'utf8');
    for (const size of sizes) {
      const name = `${mark}-${String(size)}.png`;
      await writeFile(join(outDir, name), renderPng(svg, size));
      written.push(name);
    }
  }
  return written;
}
