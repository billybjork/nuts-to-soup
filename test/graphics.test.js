import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import * as K from '../tui/kitty.js';
import * as P from '../tui/pixels.js';
import { createArt, mirrors, limiter } from '../tui/art.js';
import { Gfx } from '../tui/graphics.js';
import { render, FRAMES } from '../tui/frames-worker.js';

// The TUI's own copies, so views.js and the test share one React.
const tuiModule = (name, file) => import(new URL(`../tui/node_modules/${name}/${file}`, import.meta.url));
const React = (await tuiModule('react', 'index.js')).default;
const { renderToString } = await tuiModule('ink', 'build/index.js');
const htm = (await tuiModule('htm', 'dist/htm.mjs')).default;
const { QueuePreview, queueItems } = await import('../tui/views.js');
const ui = htm.bind(React.createElement);

const APC = /\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\/g; // eslint-disable-line no-control-regex
const commands = (s) =>
  [...s.matchAll(APC)].map(([, ctrl, data]) => ({
    ...Object.fromEntries(ctrl.split(',').map((kv) => kv.split('='))),
    data,
  }));
const PLACEHOLDER = '\u{10EEEE}';
const marks = (await import('../tui/diacritics.js')).default.map((c) => String.fromCodePoint(c));

// --- kitty ------------------------------------------------------------------------

test('images go out zlib-compressed in chunks of 4096, and come back intact', () => {
  const img = P.blank(97, 61);
  img.data.set(crypto.randomBytes(img.data.length)); // incompressible, so it takes several chunks
  const cmds = commands(K.transmit(42, img));
  assert.ok(cmds.length > 1);
  assert.deepEqual(
    [cmds[0].a, cmds[0].f, cmds[0].o, cmds[0].i, cmds[0].s, cmds[0].v, cmds[0].q],
    ['t', '32', 'z', '42', '97', '61', '2'],
  );
  assert.ok(cmds.every((c, i) => c.m === (i < cmds.length - 1 ? '1' : '0')));
  assert.ok(cmds.every((c) => c.data.length <= 4096 && c.q === '2'));
  const back = zlib.inflateSync(Buffer.from(cmds.map((c) => c.data).join(''), 'base64'));
  assert.deepEqual(new Uint8Array(back), new Uint8Array(img.data.buffer));
});

test('placeholder cells carry the image id in their color and their row and column in diacritics', () => {
  const id = 0x01a2b3;
  const rows = K.cells(id, 3, 2);
  assert.equal(rows.length, 2);
  for (const [r, row] of rows.entries()) {
    assert.ok(row.startsWith('\x1b[38;2;1;162;179m') && row.endsWith('\x1b[39m'));
    const body = row.slice(row.indexOf('m') + 1, -'\x1b[39m'.length);
    assert.equal(body, [0, 1, 2].map((c) => PLACEHOLDER + marks[r] + marks[c]).join(''));
  }
  assert.equal(K.MAX_CELLS, 297);
});

test("the turntable's frames only carry the label, which is all that turns", () => {
  const art = P.blank(40, 40, [200, 40, 40, 255]);
  const S = 120;
  const { out, bytes } = render({ id: 9, art, S, t: 0.5 });
  const cmds = commands(out).filter((c) => c.a);
  const L = P.deckLayout(S);
  const frames = cmds.filter((c) => c.a === 'f');
  assert.deepEqual([cmds[0].a, cmds[0].s, cmds[0].v], ['t', String(L.w), String(L.h)]);
  assert.equal(frames.length, FRAMES - 1);
  for (const f of frames)
    assert.deepEqual(
      [f.x, f.y, f.s, f.v, f.c],
      [L.moving.x, L.moving.y, L.moving.w, L.moving.h].map(String).concat('1'),
    );
  assert.deepEqual(cmds.at(-1), { a: 'a', q: '2', i: '9', r: '1', z: '75', data: undefined });
  assert.equal(bytes, L.w * L.h * 4 * FRAMES);
  assert.ok(bytes < 8e6 * (S / 228) ** 2, 'the header turntable stays small');
});

// --- pixels -----------------------------------------------------------------------

function bmp(w, h, rows, topDown) {
  const stride = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + stride * h);
  buf.write('BM');
  buf.writeUInt32LE(54, 10);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(topDown ? -h : h, 22);
  buf.writeUInt16LE(24, 28);
  rows.forEach((row, y) =>
    row.forEach(([r, g, b], x) => buf.set([b, g, r], 54 + (topDown ? y : h - 1 - y) * stride + x * 3)),
  );
  return buf;
}

test('sips BMPs decode in either row order, padding and all', () => {
  const rows = [
    [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ],
    [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ],
  ];
  for (const topDown of [true, false]) {
    const img = P.decodeBMP(bmp(3, 2, rows, topDown));
    assert.equal(img.w, 3);
    assert.equal(img.h, 2);
    assert.deepEqual([...img.data.slice(0, 4)], [255, 0, 0, 255]);
    assert.deepEqual([...img.data.slice(20, 24)], [7, 8, 9, 255]);
  }
  assert.throws(() => P.decodeBMP(Buffer.from('nope')), /BMP/);
});

const px = (img, x, y) => [...img.data.slice((y * img.w + x) * 4, (y * img.w + x) * 4 + 4)];

test('the timeline lights what has played, marks where you are, and can single out a track', () => {
  const tracks = [
    { offset: 0, duration: 50 },
    { offset: 50, duration: 50 },
  ];
  const img = P.timeline(100, 10, { dur: 100, pos: 30, tracks, color: [10, 200, 30] });
  const mid = 5;
  assert.deepEqual(px(img, 10, mid), [10, 200, 30, 255]); // played
  assert.deepEqual(px(img, 29, 0), [255, 255, 255, 255]); // the playhead runs the full height
  assert.notDeepEqual(px(img, 70, mid).slice(0, 3), [10, 200, 30]); // not yet
  assert.equal(px(img, 70, 0)[3], 0); // and nothing above the bar

  const focus = P.timeline(100, 10, {
    dur: 100,
    pos: 0,
    tracks,
    color: [10, 200, 30],
    focus: 1,
    head: false,
  });
  assert.deepEqual(px(focus, 70, mid), [10, 200, 30, 255]);
  assert.ok(px(focus, 70, 0)[3] > 0); // a glow over the chosen track
});

test("the tonearm's stylus runs from the outer groove to the label over an episode", () => {
  const L = P.deckLayout(600);
  for (const [t, r] of [
    [0, L.R * 0.93],
    [1, L.R * P.LABEL * P.STOP],
  ]) {
    const s = P.stylus(L, t);
    assert.ok(Math.abs(Math.hypot(s.x - L.cx, s.y - L.cy) - r) < 0.5, `radius at ${t}`);
    assert.ok(Math.abs(Math.hypot(s.x - L.pivot.x, s.y - L.pivot.y) - L.arm) < 0.5, `arm length at ${t}`);
    assert.ok(s.x > L.cx, 'on the right of the record');
  }
  assert.ok(P.stylus(L, 0.5).x < P.stylus(L, 0).x);
});

test('the label box sits inside the turntable, and the arm never reaches the label', () => {
  for (const S of [60, 228, 456]) {
    const L = P.deckLayout(S);
    const { moving: m } = L;
    assert.ok(m.x >= 0 && m.y >= 0 && m.x + m.w <= L.w && m.y + m.h <= L.h);
    assert.ok(L.pivot.x + L.R * 0.16 <= L.w, 'the pivot fits');
    // Only the label is redrawn as the record turns, so an arm over it would vanish.
    const rec = P.deckRecord(S);
    const arm = P.tonearm(S, 1);
    for (let y = 0; y < arm.h; y++)
      for (let x = 0; x < arm.w; x++)
        if (Math.hypot(x + 0.5 - rec.cx, y + 0.5 - rec.cy) < rec.labelR)
          assert.equal(px(arm, x, y)[3], 0, `arm over the label at ${x},${y} (S=${S})`);
  }
});

test('accents come from colorful covers only', () => {
  assert.equal(P.accent(P.blank(16, 16, [128, 128, 128, 255])), null);
  const img = P.blank(16, 16, [20, 20, 20, 255]);
  P.rect(img, 0, 0, 16, 6, [200, 40, 60, 255]);
  const c = P.accent(img);
  assert.ok(c[0] > c[1] && c[0] > c[2] && Math.max(...c) >= 190, `lifted red, got ${c}`);
  assert.equal(P.hex([255, 8, 0]), '#ff0800');
});

// --- art ----------------------------------------------------------------------------

test('a slow NTS image host falls through to the others, and what was fetched is cached', async () => {
  assert.deepEqual(mirrors('https://media2.ntslive.co.uk/resize/100x100/a.jpeg'), [
    'https://media2.ntslive.co.uk/resize/100x100/a.jpeg',
    'https://media.ntslive.co.uk/resize/100x100/a.jpeg',
    'https://media3.ntslive.co.uk/resize/100x100/a.jpeg',
  ]);
  assert.deepEqual(mirrors('https://example.com/a.png'), ['https://example.com/a.png']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nts-art-'));
  const asked = [];
  const fetch = async (url) => {
    asked.push(new URL(url).host);
    if (url.includes('//media.')) return { ok: false };
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode('jpeg').buffer };
  };
  const url = 'https://media.ntslive.co.uk/resize/400x400/b.jpeg';
  const file = await createArt({ dir, fetch }).file(url);
  assert.deepEqual(asked, ['media.ntslive.co.uk', 'media2.ntslive.co.uk']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'jpeg');
  assert.equal(await createArt({ dir, fetch }).file(url), file);
  assert.equal(asked.length, 2, 'served from the cache');
  fs.rmSync(dir, { recursive: true });
});

test('the limiter never runs more than n jobs at once', async () => {
  const run = limiter(2);
  let active = 0;
  let peak = 0;
  const job = () =>
    run(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
  await Promise.all(Array.from({ length: 7 }, job));
  assert.equal(peak, 2);
});

// --- graphics runtime -----------------------------------------------------------------

function fakeStdout() {
  const out = [];
  return { out, write: (chunk) => out.push(chunk) && true };
}

test("overlays go up at once, are re-placed inside each of Ink's frames, and come down once", () => {
  const stdout = fakeStdout();
  const gfx = new Gfx({ cw: 10, ch: 20, write: null, art: {} });
  gfx.write = gfx.hook(stdout);
  stdout.write('plain'); // nothing to place yet
  assert.deepEqual(stdout.out, ['plain']);
  const place = /^\x1b7\x1b\[3;1H\x1b_Ga=p,q=2,i=5,p=1,c=80,r=6,z=-1,C=1\x1b\\\x1b8$/; // eslint-disable-line no-control-regex
  gfx.overlay('backdrop', [{ id: 5, row: 3, col: 1, cols: 80, rows: 6, z: -1 }]);
  assert.match(stdout.out[1], place); // without waiting for Ink
  gfx.overlay('backdrop', [{ id: 5, row: 3, col: 1, cols: 80, rows: 6, z: -1 }]);
  assert.equal(stdout.out.length, 2, 'unchanged, so not sent again');
  stdout.write('\x1b[?2026h');
  stdout.write('frame');
  stdout.write('\x1b[?2026l');
  assert.deepEqual(stdout.out.slice(2, 4), ['\x1b[?2026h', 'frame']);
  assert.ok(stdout.out[4].endsWith('\x1b[?2026l'));
  assert.match(stdout.out[4].slice(0, -'\x1b[?2026l'.length), place);
  stdout.write('unsynced');
  assert.match(stdout.out[5], /^unsynced\x1b7/); // eslint-disable-line no-control-regex

  gfx.overlay('backdrop', null);
  assert.equal(stdout.out[6], '\x1b_Ga=d,d=i,q=2,i=5,p=1\x1b\\');
  stdout.write('after');
  assert.equal(stdout.out[7], 'after');
});

test('a timeline sent again is placed again, since sending drops its placements', () => {
  const stdout = fakeStdout();
  const gfx = new Gfx({ cw: 10, ch: 20, write: null, art: {} });
  gfx.write = gfx.hook(stdout);
  const img = () => ({ w: 4, h: 2, data: new Uint8ClampedArray(32) });
  const tl = gfx.slot('now', 4, 1, 'a', img);
  gfx.overlay('header', [{ id: tl.id, row: 7, col: 20, cols: 4, rows: 1, z: 1 }]);
  const n = stdout.out.length;
  gfx.slot('now', 4, 1, 'a', img);
  assert.equal(stdout.out.length, n, 'unchanged, so not sent');
  gfx.slot('now', 4, 1, 'b', img);
  const sent = stdout.out.slice(n).join('');
  assert.ok(sent.indexOf(`a=t,q=2,f=32,i=${tl.id}`) < sent.indexOf(`a=p,q=2,i=${tl.id},p=1,c=4,r=1,z=1`));
});

test('an image is sent once when ready, and freed when no render has used it for a while', async () => {
  const sent = [];
  const gfx = new Gfx({ cw: 10, ch: 20, write: (s) => sent.push(s), art: {} });
  let changed = 0;
  gfx.subscribe(() => changed++);
  const a = gfx.image('a', 2, 1, async () => P.blank(20, 20));
  assert.equal(a.ready, false);
  assert.equal(
    gfx.image('a', 2, 1, () => assert.fail('made twice')),
    a,
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(a.ready, true);
  assert.equal(changed, 1);
  const cmds = commands(sent.join(''));
  assert.deepEqual(
    cmds.filter((c) => c.a).map((c) => c.a + c.i),
    [`t${a.id}`, `p${a.id}`],
  );
  assert.equal(cmds.find((c) => c.a === 'p').U, '1');

  const failed = gfx.image('broken', 1, 1, async () => {
    throw new Error('no');
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(failed.failed, true);

  sent.length = 0;
  for (let i = 0; i < 4; i++) gfx.sweep({ limit: 1 }); // 'a' unused for several renders
  assert.match(sent.join(''), new RegExp(`a=d,d=I,q=2,i=(${a.id}|${failed.id})`));
  assert.equal(gfx.images.size, 1);
});

// --- views ----------------------------------------------------------------------------

test('a preview that overflows keeps its title and drops lines from the bottom', () => {
  const ep = (alias, extra = {}) => ({
    alias,
    show: 'show',
    path: `/shows/show/episodes/${alias}`,
    name: alias.toUpperCase(),
    date: 1,
    genres: [],
    moods: [],
    ...extra,
  });
  const tracks = Array.from({ length: 30 }, (_, i) => ({ artist: 'A', title: `Track ${i}`, offset: i * 60 }));
  const s = { eps: {}, progress: {}, follows: { shows: [] }, queue: [], done: {} };
  const card = { key: 'x', alias: 'x', ep: ep('x', { tracks }), stack: [], why: [] };
  const out = renderToString(
    ui`<${QueuePreview} gfx=${null} s=${s} card=${card} width=${40} height=${8} />`,
    { columns: 60 },
  );
  const lines = out.split('\n');
  assert.equal(lines.length, 8);
  assert.match(lines[0], /X/);
  assert.match(lines.at(-1), /Track 1\b/);
});

test('the queue only asks for the thumbnails of cards on screen', () => {
  const asked = [];
  const gfx = {
    cw: 10,
    ch: 20,
    sq: (r) => r * 2,
    px: (c, r) => [c * 10, r * 20],
    image: (key) => (asked.push(key), { ready: false }),
  };
  const ep = (i) => ({
    alias: `e${i}`,
    show: 's',
    name: `E${i}`,
    image: `https://x/${i}.jpg`,
    genres: [],
    moods: [],
  });
  const cards = Array.from({ length: 500 }, (_, i) => ({
    key: `e${i}`,
    alias: `e${i}`,
    ep: ep(i),
    stack: [],
    why: [],
  }));
  const s = { progress: {}, eps: {} };
  const items = queueItems({ gfx, s, cards, focus: 0, dense: false });
  assert.equal(asked.length, 0, 'none while building the list');
  items.slice(0, 3).forEach((it) => it.render());
  assert.equal(asked.length, 3);
});
