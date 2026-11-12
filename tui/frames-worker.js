// Draws the header's turntable off the main thread, so keys stay responsive,
// and returns it as the kitty commands that send it, with what it costs in
// the terminal's image memory.
import { parentPort } from 'node:worker_threads';
import * as P from './pixels.js';
import * as K from './kitty.js';

export const FRAMES = 24;
export const GAP = 75; // ms: 24 frames a turn in 1.8s is 33⅓ rpm

// The turntable `S` pixels tall, its arm `t` (0..1) through the side, as an
// animation of the label turning. Frame 1 is sent whole; each of the others
// only carries the label's box. The arm is drawn in, and never reaches the
// label, so it shows in every frame.
export function render({ id, art, S, t }) {
  const base = P.turntable(art, S, t);
  const { moving: m } = P.deckLayout(S);
  let out = K.transmit(id, base);
  for (let i = 1; i < FRAMES; i++) {
    const label = P.turnLabelOf(P.crop(base, m.x, m.y, m.w, m.h), art, S, i / FRAMES, m.x, m.y);
    out += K.frame(id, label, m.x, m.y, GAP);
  }
  // The terminal keeps every frame whole.
  return { out: out + K.firstGap(id, GAP), bytes: base.w * base.h * 4 * FRAMES };
}

parentPort?.on('message', ({ job, ...args }) => {
  try {
    const { w, h, data } = args.art;
    parentPort.postMessage({ job, ...render({ ...args, art: { w, h, data: new Uint8ClampedArray(data) } }) });
  } catch (error) {
    parentPort.postMessage({ job, error: error.message });
  }
});
