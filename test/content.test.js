import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');

function page() {
  const messages = [],
    clicked = [],
    intervals = [],
    listeners = {},
    observers = [];
  let command,
    now = 100000;
  const root = { dataset: {} };
  class Audio {}
  const audio = Object.assign(new Audio(), {
    src: 'audio',
    currentTime: 100,
    duration: 1000,
    paused: false,
    readyState: 4,
  });
  const document = {
    documentElement: root,
    querySelector: (selector) =>
      selector === '.footer-player--episode-player'
        ? {
            querySelector: (selector) =>
              selector.startsWith('a[') ? { href: 'https://www.nts.live/shows/h/episodes/a' } : null,
          }
        : null,
    querySelectorAll: (selector) => (selector === 'audio' ? [audio] : []),
    body: { append() {} },
    createElement: () => {
      const el = { attributes: {}, setAttribute: (k, v) => (el.attributes[k] = v), remove() {} };
      el.click = () => clicked.push(el);
      return el;
    },
    addEventListener: (name, fn) => {
      listeners[name] = fn;
    },
  };
  const context = vm.createContext({
    document,
    window: { addEventListener() {} },
    URL,
    AbortController,
    HTMLAudioElement: Audio,
    crypto: { randomUUID: () => 'session' },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    localStorage: {
      getItem: () => JSON.stringify({ episodeAlias: 'a', currentPositionS: audio.currentTime }),
    },
    location: { pathname: '/' },
    MutationObserver: class {
      constructor(fn) {
        observers.push(fn);
      }
      observe() {}
      disconnect() {}
    },
    PerformanceObserver: class {
      observe() {}
      disconnect() {}
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {
        sendMessage: async (msg) => {
          messages.push(msg);
          return { ok: true, value: { accepted: true } };
        },
        onMessage: {
          addListener: (fn) => {
            command = fn;
          },
          removeListener: (fn) => {
            if (command === fn) command = null;
          },
        },
      },
      storage: { local: { get: async () => ({}) } },
    },
  });
  vm.runInContext(source, context);
  return {
    messages,
    clicked,
    audio,
    root,
    observers,
    listeners,
    context,
    tick: () => {
      now += 6000;
      intervals.find((i) => i.ms === 2000).fn();
    },
    command: (msg) => new Promise((resolve) => command(msg, {}, resolve)),
  };
}

test('content reports session-bound progress through the worker', async () => {
  const p = page();
  p.tick();
  assert.equal(p.messages[0].type, 'nowPlaying');
  assert.equal(p.messages[0].playbackId, 'session');
  p.tick();
  assert.equal(p.messages.at(-1).type, 'progress');
  assert.equal(p.messages.at(-1).pos, 100);
  assert.equal(p.messages.at(-1).playbackId, 'session');
  p.audio.paused = true;
  p.tick();
  assert.equal(p.messages.at(-1).playing, false);
});

test('unrelated audio end events and retired scripts cannot complete an episode', () => {
  const p = page();
  p.tick();
  p.listeners.ended({ target: {} });
  assert.equal(
    p.messages.some((m) => m.type === 'ended'),
    false,
  );
  p.root.dataset.ntsq = 'replacement';
  p.listeners.ended({ target: p.audio });
  p.tick();
  assert.equal(p.messages.length, 1);
  p.observers[0]();
});

test('the archive audio ending reports the playback identity exactly once', () => {
  const p = page();
  p.tick();
  p.listeners.ended({ target: p.audio });
  p.listeners.ended({ target: p.audio });
  assert.equal(p.messages.filter((m) => m.type === 'ended').length, 1);
  assert.equal(p.messages.at(-1).playbackId, 'session');
});

// NTS's one click listener acts only on buttons with its play-button class.
// When NTS renamed it (from mixcloud-btn), every load silently did nothing.
test('loading an episode presses a button NTS treats as play', async (t) => {
  const p = page();
  t.after(() => (p.root.dataset.ntsq = 'retired')); // ends its wait to start: this clock stands still
  p.command({
    type: 'load',
    ep: { alias: 'b', path: '/shows/h/episodes/b', src: 'https://soundcloud.com/x' },
  });
  const [b] = p.clicked;
  assert.equal(b.className.split(' ').includes('episode-play-btn'), true);
  assert.equal(b.attributes['data-permalink'], '/shows/h/episodes/b');
  assert.equal(b.attributes['data-src'], 'https://soundcloud.com/x');
});
