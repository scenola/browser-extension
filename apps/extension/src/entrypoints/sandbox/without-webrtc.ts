/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A way out of a page that no policy closes: WebRTC. `default-src 'none'` stops every fetch,
// socket and load, and the offscreen document's `frame-src 'self'` keeps the frame from
// navigating away, but a peer connection's STUN and TURN requests go to whatever server code in
// the page names — a TURN user name could carry the snapshot — and Chrome knows no directive for
// them. The modules run in the page's worker, which has no WebRTC at all (interpret-worker.ts);
// the page runs only its own code, and holds none either: every WebRTC global is deleted here,
// in its first import. A frame created in the page is another opaque origin, whose globals the
// page cannot reach to fetch them back.

const WEBRTC = /^(?:webkit)?RTC/u;

for (const name of Object.getOwnPropertyNames(globalThis)) {
  if (WEBRTC.test(name)) Reflect.deleteProperty(globalThis, name);
}
