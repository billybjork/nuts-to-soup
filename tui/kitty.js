// The kitty graphics protocol, the parts the TUI uses. Images are sent once as
// zlib'd RGBA and mostly shown through Unicode placeholders: ordinary text
// cells that Ink lays out, scrolls and erases like any other character. The
// few images that overlap others (the backdrop, the turntable) are placed
// directly at a screen position.
// https://sw.kovidgoyal.net/kitty/graphics-protocol/
import zlib from 'node:zlib';
import DIACRITICS from './diacritics.js';

const apc = (ctrl, payload = '') => `\x1b_G${ctrl}${payload ? `;${payload}` : ''}\x1b\\`;
const CHUNK = 4096;

const bytes = (img) => Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);

// The payload, compressed and base64'd, split into the protocol's chunks.
// q=2 everywhere: the terminal sends no replies, so nothing lands on stdin.
function chunked(ctrl, raw) {
  const b64 = zlib.deflateSync(raw).toString('base64');
  let out = '';
  for (let i = 0; i < b64.length || i === 0; i += CHUNK) {
    const more = i + CHUNK < b64.length ? 1 : 0;
    const part = b64.slice(i, i + CHUNK);
    out += i === 0 ? apc(`${ctrl},o=z,m=${more}`, part) : apc(`m=${more},q=2`, part);
  }
  return out;
}

export const transmit = (id, img) => chunked(`a=t,q=2,f=32,i=${id},s=${img.w},v=${img.h}`, bytes(img));

// A virtual placement: the image shows wherever its placeholder cells are.
export const virtual = (id, cols, rows) => apc(`a=p,U=1,q=2,i=${id},c=${cols},r=${rows}`);

// A placement at the cursor that leaves the cursor where it was.
export const place = (id, pid, cols, rows, z) =>
  apc(`a=p,q=2,i=${id},p=${pid},c=${cols},r=${rows},z=${z},C=1`);
export const unplace = (id, pid) => apc(`a=d,d=i,q=2,i=${id},p=${pid}`);
export const free = (id) => apc(`a=d,d=I,q=2,i=${id}`);

// Animation. Each extra frame starts as a copy of frame 1 with `img` pasted
// at (x, y), so frames only carry the part that moves.
export const frame = (id, img, x, y, gap) =>
  chunked(`a=f,q=2,f=32,i=${id},s=${img.w},v=${img.h},x=${x},y=${y},c=1,z=${gap}`, bytes(img));
export const firstGap = (id, gap) => apc(`a=a,q=2,i=${id},r=1,z=${gap}`);
export const loop = (id) => apc(`a=a,q=2,i=${id},s=3,v=1`);
export const stop = (id) => apc(`a=a,q=2,i=${id},s=1`);

// --- placeholders ----------------------------------------------------------------

export const MAX_CELLS = DIACRITICS.length;
const PLACEHOLDER = '\u{10EEEE}';
const marks = DIACRITICS.map((c) => String.fromCodePoint(c));

// The image id rides in the cell's 24-bit foreground color.
export const idColor = (id) => `\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`;

// One string per row: `cols` placeholder cells, each naming its row and column.
export function cells(id, cols, rows) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    let s = idColor(id);
    for (let c = 0; c < cols; c++) s += PLACEHOLDER + marks[r] + marks[c];
    out.push(s + '\x1b[39m');
  }
  return out;
}
