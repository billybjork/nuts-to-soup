import test from 'node:test';
import assert from 'node:assert/strict';

const local = {};
const session = {};
const listeners = {};
const sender = (id) => ({ tab: { id }, frameId: 0, url: 'https://www.nts.live/shows/host/episodes/current' });
const event = (name) => ({
  addListener: (fn) => {
    listeners[name] = fn;
  },
});
const storage = (data) => ({
  get: async (keys) =>
    keys == null
      ? structuredClone(data)
      : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, structuredClone(data[k])])),
  set: async (patch) => Object.assign(data, structuredClone(patch)),
  remove: async (key) => {
    delete data[key];
  },
});
// Native ports the worker opened, newest last.
const ports = [];
const connectNative = (name) => {
  const port = { name, sent: [], postMessage: (m) => port.sent.push(structuredClone(m)) };
  for (const e of ['onMessage', 'onDisconnect']) port[e] = { addListener: (fn) => (port[e].fn = fn) };
  ports.push(port);
  return port;
};
globalThis.chrome = {
  runtime: {
    onInstalled: event('installed'),
    onStartup: event('startup'),
    onMessage: event('message'),
    connectNative,
  },
  contextMenus: { onClicked: event('context') },
  alarms: { onAlarm: event('alarm') },
  tabs: { onRemoved: event('removed') },
  storage: { local: storage(local), session: storage(session), onChanged: event('storage') },
};
await import('../background.js');
const request = (msg, sender = {}) =>
  new Promise((resolve) => {
    if (!listeners.message(msg, sender, resolve)) resolve(null);
  });

test('message dispatcher ignores inherited names and reports thrown validation errors', async () => {
  assert.equal(await request({ type: 'constructor' }), null);
  assert.equal((await request({ type: 'add' })).ok, false);
});

test('end reports only affect the current episode from the player tab', async () => {
  Object.assign(local, {
    now: { alias: 'current', playbackId: 'run' },
    queue: [{ alias: 'current' }],
    settings: { autoAdvance: false },
  });
  session.playerTab = 10;
  await request({ type: 'ended', alias: 'current', playbackId: 'run' }, sender(11));
  assert.equal(local.done, undefined);
  await request({ type: 'ended', alias: 'old', playbackId: 'run' }, sender(10));
  assert.equal(local.done, undefined);
  await request({ type: 'ended', alias: 'current', playbackId: 'run' }, sender(10));
  assert.equal(local.queue.length, 0);
  const finished = local.done.current;
  await request({ type: 'ended', alias: 'current', playbackId: 'run' }, sender(10));
  assert.equal(local.done.current, finished);
});

test('progress rejects other tabs, stale sessions, and finished sessions', async () => {
  local.now = { alias: 'current', playbackId: 'new', pos: 50 };
  session.playerTab = 10;
  const progress = { type: 'progress', alias: 'current', playbackId: 'old', pos: 1, dur: 500, playing: true };
  assert.equal((await request(progress, sender(10))).ok, true);
  assert.equal(local.now.pos, 50);
  await request({ ...progress, playbackId: 'new' }, sender(11));
  assert.equal(local.now.pos, 50);
  await request({ ...progress, playbackId: 'new', pos: 100 }, sender(10));
  assert.equal(local.now.pos, 100);
  assert.equal(local['p:current'].pos, 100);
  local.now.ended = true;
  await request({ ...progress, playbackId: 'new', pos: 200 }, sender(10));
  assert.equal(local.now.pos, 100);
});

test('older playback claims cannot undo a newer selection', async () => {
  local.now = { alias: 'new', selectedAt: 200 };
  const r = await request(
    {
      type: 'nowPlaying',
      alias: 'current',
      path: '/shows/host/episodes/current',
      playbackId: 'run',
      startedAt: 100,
      pos: 1,
      dur: 500,
    },
    sender(10),
  );
  assert.equal(r.value.accepted, false);
  assert.equal(local.now.alias, 'new');
});

test('partial follows merge and complete follows replace', async () => {
  local.follows = {
    shows: [
      { alias: 'a', name: 'A' },
      { alias: 'b', name: 'B' },
    ],
    syncedAt: 5,
  };
  await request(
    { type: 'scraped', kind: 'shows', items: [{ alias: 'a', name: 'A' }], complete: false },
    sender(10),
  );
  assert.equal(local.follows.shows.length, 2);
  assert.equal(local.follows.syncedAt, 5);
  await request(
    { type: 'scraped', kind: 'shows', items: [{ alias: 'a', name: 'A' }], complete: true },
    sender(10),
  );
  assert.equal(local.follows.shows.length, 1);
});

test('invalid commands leave storage unchanged', async () => {
  const before = structuredClone(local);
  for (const msg of [
    { type: 'jump', alias: 'x', path: '/shows/a/episodes/x', offset: -1 },
    { type: 'settings', settings: { autoAdvance: 'false' } },
    { type: 'remove', aliases: [null] },
    { type: 'reorder', aliases: ['x', 'x'], moved: 1, from: 0 },
  ]) {
    assert.equal((await request(msg)).ok, false);
  }
  assert.deepEqual(local, before);
});

test('foreign episode URLs are rejected before any fetch', async () => {
  const r = await request({ type: 'add', urls: ['https://example.com/shows/a/episodes/x'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /No NTS/);
});

test('stale reorder requests fail rather than pinning an obsolete queue', async () => {
  local.now = null;
  local.queue = [{ alias: 'a' }];
  local.eps = { a: { alias: 'a', show: 'h', path: '/shows/h/episodes/a', date: 1, genres: [], moods: [] } };
  const r = await request({ type: 'reorder', aliases: ['gone'], moved: 0, from: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /queue changed/);
  assert.equal(local.queue[0].rank, undefined);
});

test('concurrent sync requests open one tab and duplicate scrape results do not skip pages', async () => {
  let creates = 0;
  const updates = [];
  chrome.alarms.create = async () => {};
  chrome.alarms.clear = async () => {};
  chrome.tabs.create = async () => {
    creates++;
    return { id: 42 };
  };
  chrome.tabs.update = async (id, patch) => {
    updates.push({ id, ...patch });
  };
  chrome.tabs.remove = async () => {};
  await Promise.all([request({ type: 'sync' }), request({ type: 'sync' })]);
  assert.equal(creates, 1);
  const msg = { type: 'scraped', kind: 'shows', items: [], complete: false };
  await Promise.all([request(msg, sender(42)), request(msg, sender(42))]);
  assert.equal(session.syncTab.step, 1);
  assert.equal(updates.length, 1);
  assert.match(updates[0].url, /favourites\/episodes$/);
  delete session.syncTab;
});

test('a lost load reply never resends the load command', async () => {
  local.now = null;
  local.eps = {
    a: {
      alias: 'a',
      show: 'h',
      path: '/shows/h/episodes/a',
      date: 1,
      genres: [],
      moods: [],
      src: 'https://soundcloud.com/a',
    },
  };
  chrome.tabs.query = async () => [{ id: 10 }];
  const sent = [];
  chrome.tabs.sendMessage = async (_id, msg) => {
    sent.push(msg.type);
    if (msg.type === 'load') throw new Error('Port closed');
    return { ready: true };
  };
  const r = await request({ type: 'play', alias: 'a' });
  assert.equal(r.ok, false);
  assert.deepEqual(sent, ['ping', 'load']);
});

test('failed pause does not falsely mark playback paused', async () => {
  local.now = { alias: 'a', playing: true };
  chrome.tabs.sendMessage = async (_id, msg) => (msg.type === 'ping' ? { ready: true } : { paused: false });
  const r = await request({ type: 'toggle', play: false });
  assert.equal(r.ok, false);
  assert.equal(local.now.playing, true);
});

test('failed skip preserves the previous episode and its queue membership', async () => {
  local.now = { alias: 'old', pos: 10 };
  local.eps.old = {
    alias: 'old',
    show: 'other',
    path: '/shows/other/episodes/old',
    src: 'audio',
    genres: [],
    moods: [],
  };
  local.queue = [{ alias: 'old' }, { alias: 'a' }];
  chrome.tabs.sendMessage = async (_id, msg) => {
    if (msg.type === 'load') throw new Error('Lost tab');
    return { ready: true };
  };
  const r = await request({ type: 'skip' });
  assert.equal(r.ok, false);
  assert.equal(local.now.alias, 'old');
  assert.equal(
    local.queue.some((q) => q.alias === 'old'),
    true,
  );
  assert.equal(local.dismissed?.old, undefined);
});

test('a new playback session can replay a finished episode without accepting old end reports', async () => {
  local.now = { alias: 'a', selectedAt: 10, ended: true, playbackId: 'old-run' };
  local.eps = { a: { path: '/shows/h/episodes/a', genres: [], moods: [], detail: true, tracks: [] } };
  local.queue = [];
  local.saved = [];
  local.history = [];
  const r = await request(
    {
      type: 'nowPlaying',
      alias: 'a',
      path: '/shows/h/episodes/a',
      playbackId: 'replay',
      startedAt: 20,
      pos: 0,
      dur: 500,
    },
    sender(10),
  );
  assert.equal(r.value.accepted, true);
  assert.equal(local.now.playbackId, 'replay');
  await request({ type: 'ended', alias: 'a', playbackId: 'old-run' }, sender(10));
  assert.equal(local.now.ended, undefined);
});

test('concurrent polls share a request and preserve detailed cached metadata', async (t) => {
  local.now = null;
  local.queue = [];
  local.seen = [];
  local.saved = [];
  local.history = [];
  local.eps = {
    a: {
      alias: 'a',
      path: '/shows/h/episodes/a',
      show: 'h',
      name: 'Detailed',
      src: 'audio',
      detail: true,
      tracks: [],
      genres: [],
      moods: [],
    },
  };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({ results: [{ article: { path: '/shows/h/episodes/a' }, title: 'Search' }] }),
    };
  });
  const results = await Promise.all([request({ type: 'poll' }), request({ type: 'poll' })]);
  assert.equal(
    results.every((r) => r.ok),
    true,
  );
  assert.equal(calls, 1);
  assert.equal(local.queue.length, 1);
  assert.equal(local.eps.a.src, 'audio');
  assert.equal(local.eps.a.name, 'Detailed');
});

test('tracklist failures preserve fetched detail and schedule retry rather than marking missing', async (t) => {
  local.now = null;
  local.queue = [];
  local.seen = [];
  local.saved = [];
  local.history = [];
  local.eps = {};
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/tracklist')) return { ok: false, status: 503 };
    return {
      ok: true,
      json: async () =>
        url.includes('/search/')
          ? { results: [{ article: { path: '/shows/h/episodes/retry' } }] }
          : {
              episode_alias: 'retry',
              show_alias: 'h',
              name: 'Fetched',
              audio_sources: [{ source: 'soundcloud', url: 'audio' }],
            },
    };
  });
  assert.equal((await request({ type: 'poll' })).ok, true);
  for (let i = 0; i < 30 && !local.eps.retry?.retryAt; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(local.eps.retry.detail, true);
  assert.equal(local.eps.retry.src, 'audio');
  assert.equal(local.eps.retry.tracks, undefined);
  assert.ok(local.eps.retry.retryAt > Date.now());
  await new Promise((resolve) => setImmediate(resolve));
});

// The bridge to the terminal: tui/host.js on the other end of a native port.
const native = async (msg, id = 1) => {
  const port = ports.at(-1);
  const before = port.sent.length;
  port.onMessage.fn({ id, msg });
  for (let i = 0; i < 50 && port.sent.length === before; i++) await new Promise((r) => setImmediate(r));
  return port.sent.at(-1);
};

test('the native host is sent the whole store when it connects', () => {
  assert.equal(ports.length, 1);
  assert.equal(ports[0].name, 'com.billybjork.nuts_to_soup');
  assert.equal(ports[0].sent[0].type, 'state');
  assert.equal(typeof ports[0].sent[0].data, 'object');
});

test('native commands reach the panel handlers and reply with their id', async () => {
  local.settings = { autoAdvance: true };
  const r = await native({ type: 'settings', settings: { autoAdvance: false } }, 7);
  assert.deepEqual(r, { id: 7, ok: true, value: null });
  assert.equal(local.settings.autoAdvance, false);
  const bad = await native({ type: 'toggle' }, 8);
  assert.equal(bad.id, 8);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Invalid toggle/);
  assert.equal((await native({ type: 'constructor' }, 9)).ok, false);
});

test('native cannot send content-script messages', async () => {
  session.playerTab = undefined;
  const before = structuredClone(local);
  for (const msg of [
    {
      type: 'nowPlaying',
      alias: 'a',
      path: '/shows/h/episodes/a',
      playbackId: 'x',
      startedAt: 9e12,
      pos: 0,
      dur: 1,
    },
    { type: 'progress', alias: 'a', playbackId: 'x', pos: 1, dur: 2, playing: true },
    { type: 'ended', alias: 'a', playbackId: 'x' },
    { type: 'scraped', kind: 'signedOut' },
    { type: 'isSyncTab' },
    { type: 'refreshStream', index: 0 },
  ]) {
    const r = await native(msg);
    assert.equal(r.ok, false, msg.type);
    assert.match(r.error, /NTS page/);
  }
  assert.deepEqual(local, before);
});

test('storage changes are forwarded to the native host as deltas', () => {
  const port = ports.at(-1);
  listeners.storage(
    { 'p:a': { oldValue: { pos: 1 }, newValue: { pos: 6 } }, gone: { oldValue: 1 } },
    'local',
  );
  listeners.storage({ syncTab: { newValue: {} } }, 'session');
  assert.deepEqual(port.sent.at(-1), { type: 'delta', set: { 'p:a': { pos: 6 } }, removed: ['gone'] });
});

test('a disconnected native port reconnects with backoff', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const count = ports.length;
  ports.at(-1).onDisconnect.fn();
  t.mock.timers.tick(999);
  assert.equal(ports.length, count);
  t.mock.timers.tick(1);
  assert.equal(ports.length, count + 1);
  ports.at(-1).onDisconnect.fn();
  t.mock.timers.tick(1999);
  assert.equal(ports.length, count + 1);
  t.mock.timers.tick(1);
  assert.equal(ports.length, count + 2);
});
