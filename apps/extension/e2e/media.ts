/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The media the fixture pages play: silence, as a WAV file — 8 kHz, 8-bit, mono PCM — so a
// `<video>` element has a real, finite, seekable duration and plays it in real time at up to
// 16×, with no codec and no binary fixture in the repository.

/** 8 kHz × 1 byte × 1 channel. */
const SAMPLE_RATE = 8000;
/** Unsigned 8-bit PCM is centred on 128: a run of 0x80 is silence. */
const SILENCE = 0x80;

/** A RIFF/WAVE file of `seconds` of silence (RFC 2361, the canonical 44-byte header). */
export function silentWav(seconds: number): Buffer {
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 4 * 3600) {
    throw new RangeError('silentWav takes 1 s to 4 h, in whole seconds');
  }
  const data = seconds * SAMPLE_RATE;
  const wav = Buffer.alloc(44 + data, SILENCE);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + data, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16); // the fmt chunk's size
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE, 28); // bytes a second
  wav.writeUInt16LE(1, 32); // bytes a frame
  wav.writeUInt16LE(8, 34); // bits a sample
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(data, 40);
  return wav;
}
