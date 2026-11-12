// Images in the TUI, when the terminal speaks the kitty graphics protocol.
//
// Most images are shown with Unicode placeholders (<Img>), so Ink treats them
// as text. Images that overlap others are overlays, placed at a screen
// position after each frame Ink writes. Everything here no-ops gracefully:
// without graphics, `gfx` is null and the views fall back to text.
import { Worker } from 'node:worker_threads';
import React, { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import htm from 'htm';
import * as K from './kitty.js';
import { createArt } from './art.js';
import { accent, hex } from './pixels.js';

const ui = htm.bind(React.createElement);
const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';
const ESC = '\x1b';
const DA1 = new RegExp(`${ESC}\\[\\?[\\d;]*c`); // primary device attributes
const CELL = new RegExp(`${ESC}\\[6;(\\d+);(\\d+)t`); // cell size, height;width

// Asks the terminal whether it shows kitty graphics, and its cell size, before
// Ink takes over stdin. Null when it doesn't answer, or graphics are off.
export async function detect({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  if (env.NTS_GRAPHICS === '0' || env.TMUX || env.STY || !stdin.isTTY || !stdout.isTTY) return null;
  const reply = await new Promise((resolve) => {
    let got = '';
    const done = () => {
      clearTimeout(timer);
      stdin.off('data', on);
      stdin.setRawMode(false);
      stdin.pause();
      resolve(got);
    };
    // Primary device attributes come last: every terminal answers those.
    const on = (d) => {
      got += d.toString('latin1');
      if (DA1.test(got)) done();
    };
    const timer = setTimeout(done, 800);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', on);
    stdout.write('\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[16t\x1b[c');
  });
  if (!reply.includes('\x1b_Gi=31;OK')) return null;
  const cell = CELL.exec(reply);
  const ch = cell ? +cell[1] : 16;
  const cw = cell ? +cell[2] : 8;
  // Rex (and some others) report cells in points: draw at 2x for Retina.
  const scale = ch < 24 ? 2 : 1;
  return { cw: cw * scale, ch: ch * scale };
}

export class Gfx {
  constructor({
    cw,
    ch,
    write,
    art = createArt(),
    workerUrl = new URL('./frames-worker.js', import.meta.url),
  }) {
    this.cw = cw;
    this.ch = ch;
    this.write = write;
    this.art = art;
    this.workerUrl = workerUrl;
    this.nextId = 1;
    this.images = new Map(); // key -> { id, ready, failed, used }
    this.slots = new Map(); // name -> { id, sig }
    this.overlays = new Map(); // name -> [{ id, pid, row, col, cols, rows, z }]
    this.pids = new Map();
    this.gone = '';
    this.version = 0;
    this.listeners = new Set();
    this.turn = 0;
    this.jobs = new Map();
  }

  // Cells for a square `rows` tall, and the pixels for a box of cells.
  sq = (rows, ratio = 1) => Math.max(1, Math.round((rows * this.ch * ratio) / this.cw));
  px = (cols, rows) => [cols * this.cw, rows * this.ch];

  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  snapshot = () => this.version;
  changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  id() {
    return this.nextId++;
  }

  // An image made once by `make()` (async, returning RGBA) and shown through
  // placeholders at cols x rows. Returns its entry; `ready` once it's sent.
  image(key, cols, rows, make) {
    let e = this.images.get(key);
    if (!e) {
      e = { id: this.id(), ready: false, used: this.turn };
      this.images.set(key, e);
      Promise.resolve()
        .then(make)
        .then((img) => {
          if (this.images.get(key) !== e) return;
          this.write(K.transmit(e.id, img) + K.virtual(e.id, cols, rows));
          e.bytes = img.w * img.h * 4;
          e.ready = true;
          this.changed();
        })
        .catch(() => {
          e.failed = true;
          this.changed();
        });
    }
    e.used = this.turn;
    return e;
  }

  // An image whose pixels change in place (a timeline): made now, and sent
  // again whenever `sig` changes.
  slot(name, cols, rows, sig, make) {
    let e = this.slots.get(name);
    if (!e) this.slots.set(name, (e = { id: this.id() }));
    if (e.sig !== sig) {
      e.sig = sig;
      const img = make();
      // Sending it again drops its direct placements: put them back.
      this.write(K.transmit(e.id, img) + K.virtual(e.id, cols, rows) + this.placements());
      e.bytes = img.w * img.h * 4;
    }
    return { id: e.id, ready: true };
  }

  // Marks an entry this render still shows, so sweep() keeps it.
  keep(e) {
    if (e) e.used = this.turn;
    return e;
  }

  // The turntable, which the frame worker draws (`job` is { url, S, t }; see
  // frames-worker.js), shown through placeholders at `cells`.
  turntable(key, job, cells) {
    let e = this.images.get(key);
    if (!e) {
      e = { id: this.id(), ready: false, used: this.turn, spinning: false };
      this.images.set(key, e);
      this.art
        .image(job.url, 400)
        .then((art) => this.work({ ...job, id: e.id, art }))
        .then(({ out, bytes }) => {
          if (this.images.get(key) !== e) return;
          this.write(out + K.virtual(e.id, cells.cols, cells.rows));
          e.bytes = bytes;
          e.ready = true;
          this.changed();
        })
        .catch(() => {
          e.failed = true;
          this.changed();
        });
    }
    e.used = this.turn;
    return e;
  }

  // Sets an animation turning, or holds it still where it is.
  spin(e, playing) {
    if (!e?.ready || e.spinning === playing) return;
    e.spinning = playing;
    this.write(playing ? K.loop(e.id) : K.stop(e.id));
  }

  work(args) {
    if (!this.worker) {
      this.worker = new Worker(this.workerUrl);
      this.worker.unref();
      this.worker.on('message', ({ job, error, ...result }) => {
        const p = this.jobs.get(job);
        this.jobs.delete(job);
        if (error) p?.reject(new Error(error));
        else p?.resolve(result);
      });
    }
    const job = this.id();
    const { w, h, data } = args.art;
    const copy = data.slice();
    return new Promise((resolve, reject) => {
      this.jobs.set(job, { resolve, reject });
      this.worker.postMessage({ job, ...args, art: { w, h, data: copy.buffer } }, [copy.buffer]);
    });
  }

  // Overlays: images at fixed screen positions, re-placed after every frame.
  overlay(name, list) {
    const old = this.overlays.get(name) || [];
    const next = (list || []).map((o, i) => {
      const k = `${name}:${i}`;
      if (!this.pids.has(k)) this.pids.set(k, this.pids.size + 1);
      return { ...o, pid: this.pids.get(k) };
    });
    for (const o of old)
      if (!next.some((n) => n.id === o.id && n.pid === o.pid)) this.gone += K.unplace(o.id, o.pid);
    if (next.length) this.overlays.set(name, next);
    else this.overlays.delete(name);
    // Placed now: Ink only writes when its text changes, which may be never
    // while paused.
    if (JSON.stringify(old) !== JSON.stringify(next)) this.write(this.placements());
  }

  placements() {
    let s = this.gone;
    this.gone = '';
    if (!this.overlays.size) return s;
    s += '\x1b7';
    for (const list of this.overlays.values())
      for (const o of list) s += `\x1b[${o.row};${o.col}H` + K.place(o.id, o.pid, o.cols, o.rows, o.z);
    return s + '\x1b8';
  }

  // Wraps stdout.write so overlays land in the same synchronized update as
  // each frame Ink writes. Returns the original write, for protocol output.
  hook(stdout) {
    const write = stdout.write.bind(stdout);
    let inSync = false;
    stdout.write = (chunk, ...rest) => {
      if (typeof chunk !== 'string' || (!this.overlays.size && !this.gone)) return write(chunk, ...rest);
      if (chunk === BSU) {
        inSync = true;
        return write(chunk, ...rest);
      }
      if (chunk.endsWith(ESU)) {
        inSync = false;
        return write(chunk.slice(0, -ESU.length) + this.placements() + ESU, ...rest);
      }
      return write(inSync ? chunk : chunk + this.placements(), ...rest);
    };
    this.unhook = () => (stdout.write = write);
    return write;
  }

  // Called once per render: frees the images the last few renders didn't
  // use, oldest first, while there are too many or they take too much of
  // the terminal's image memory (Rex evicts past about 128 MB).
  sweep({ limit = 250, budget = 48e6 } = {}) {
    this.turn++;
    const all = [...this.images.values(), ...this.slots.values()];
    let bytes = all.reduce((n, e) => n + (e.bytes || 0), 0);
    let count = this.images.size;
    if (count <= limit && bytes <= budget) return;
    const stale = [...this.images]
      .filter(([, e]) => e.used < this.turn - 2)
      .sort((a, b) => a[1].used - b[1].used);
    let out = '';
    for (const [key, e] of stale) {
      if (count <= limit && bytes <= budget) break;
      this.images.delete(key);
      out += K.free(e.id);
      count--;
      bytes -= e.bytes || 0;
    }
    if (out) this.write(out);
  }

  dispose() {
    let out = '';
    for (const e of this.images.values()) out += K.free(e.id);
    for (const e of this.slots.values()) out += K.free(e.id);
    this.write(out);
    this.unhook?.();
    this.worker?.terminate();
  }
}

// --- React ------------------------------------------------------------------------

const Ctx = createContext(null);
export const GfxProvider = ({ gfx, children }) => ui`<${Ctx.Provider} value=${gfx}>${children}<//>`;

// The Gfx, or null without graphics. Re-renders when an image becomes ready.
export function useGfx() {
  const gfx = useContext(Ctx);
  useSyncExternalStore(gfx ? gfx.subscribe : noop, gfx ? gfx.snapshot : zero);
  return gfx;
}
const noop = () => () => {};
const zero = () => 0;

// An image entry's placeholder cells, or blank space of the same size.
export function Img({ e, cols, rows }) {
  if (!e?.ready) return ui`<${Box} width=${cols} height=${rows} flexShrink=${0} />`;
  return ui`<${Box} flexDirection="column" width=${cols} height=${rows} flexShrink=${0}>
    ${K.cells(e.id, cols, rows).map((line, i) => ui`<${Text} key=${i}>${line}<//>`)}
  <//>`;
}

// The cover's accent color (hex), or `fallback` until it's known (or for a
// grey cover).
const accents = new Map();
export function useAccent(gfx, url, fallback = 'green') {
  useEffect(() => {
    if (!gfx || !url || accents.has(url)) return;
    accents.set(url, null);
    gfx.art
      .image(url, 64)
      .then((img) => {
        const c = accent(img);
        accents.set(url, c && hex(c));
        gfx.changed();
      })
      .catch(() => {});
  }, [gfx, url]);
  return (url && accents.get(url)) || fallback;
}
