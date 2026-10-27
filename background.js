import {
  NTS,
  LATEST_MAX_OFFSET,
  fetchLatest,
  fetchEpisode,
  fetchTracks,
  fetchShow,
  parsePath,
  trackAt,
} from './lib/nts.js';
import { load, save, isDone } from './lib/store.js';
import { buildProfile, orderQueue, stackKey } from './lib/rank.js';

const POLL_MINUTES = 30;
const SYNC_MINUTES = 24 * 60;
const PAGE = 60;
// My NTS pages visited, in order, during a sync.
const SYNC_PAGES = ['/my-nts/favourites/shows', '/my-nts/favourites/episodes', '/my-nts/history'];

// --- lifecycle ---------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await setup();
  chrome.contextMenus.removeAll(() =>
    chrome.contextMenus.create({
      id: 'add',
      title: 'Add to Nuts to Soup',
      contexts: ['link', 'page'],
      documentUrlPatterns: [`${NTS}/*`],
      targetUrlPatterns: [`${NTS}/shows/*/episodes/*`],
    }),
  );
  if (reason === 'install') sync();
});
chrome.runtime.onStartup.addListener(setup);

async function setup() {
  await migrate();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.alarms.create('poll', { periodInMinutes: POLL_MINUTES, delayInMinutes: 0.1 });
  await chrome.alarms.create('sync', { periodInMinutes: SYNC_MINUTES, delayInMinutes: SYNC_MINUTES });
}

chrome.contextMenus.onClicked.addListener(({ linkUrl, pageUrl }) => {
  add([linkUrl || pageUrl]).catch(() => {});
});

chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === 'poll') poll();
  if (name === 'sync') sync();
});

// Older versions kept an inbox beside the queue, and an "up next" pin instead
// of manual positions. Fold both into the queue.
async function migrate() {
  const { inbox, queue = [] } = await chrome.storage.local.get(['inbox', 'queue']);
  if (!inbox && !queue.some((q) => q.pin)) return;
  await locked(async () => {
    const s = await chrome.storage.local.get(['inbox', 'queue']);
    const q = s.queue || [];
    const pinned = q.filter((x) => x.pin).sort((a, b) => a.pin - b.pin);
    pinned.forEach((x, i) => (x.rank = i));
    for (const x of q) delete x.pin;
    for (const i of s.inbox || []) if (!q.some((x) => x.alias === i.alias)) q.push(i);
    await chrome.storage.local.set({ queue: q });
    await chrome.storage.local.remove('inbox');
  });
}

// --- serialised state changes -------------------------------------------------

let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

// fn mutates the loaded state in place and returns the keys it changed.
function mutate(fn) {
  return locked(async () => {
    const s = await load();
    const keys = fn(s) || [];
    await save(Object.fromEntries(keys.map((k) => [k, s[k]])));
    return s;
  });
}

const without = (list, alias) => list.filter((x) => x.alias !== alias);
const has = (list, alias) => list.some((x) => x.alias === alias);

// A manual position above everything else in the queue.
const topRank = (queue) => Math.min(1, ...queue.filter((x) => x.rank != null).map((x) => x.rank)) - 1;

// Gives an episode a manual position. Its show's stack moves with it, so the
// show's other episodes lose theirs.
function place(s, alias, rank) {
  const key = s.eps[alias] && stackKey(s.eps[alias]);
  for (const x of s.queue) {
    if (x.alias === alias) x.rank = rank;
    else if (key && s.eps[x.alias] && stackKey(s.eps[x.alias]) === key) delete x.rank;
  }
}

// Drop cached metadata nothing refers to any more.
function prune(s) {
  const keep = new Set([
    ...s.queue.map((q) => q.alias),
    ...s.saved,
    ...s.history,
    ...recent(s.done, 300),
    ...recent(s.dismissed, 300),
    ...s.plays.slice(0, 200).map((p) => p.alias),
  ]);
  if (s.now?.alias) keep.add(s.now.alias);
  for (const a of Object.keys(s.eps)) if (!keep.has(a)) delete s.eps[a];
}

const recent = (map, n) =>
  Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([a]) => a);

// --- polling Latest -----------------------------------------------------------

// Latest is ordered by when episodes were added, and episodes are often added
// a day or two after broadcast, so we track every alias we've seen rather than
// a date. Two pages are always checked in case something lands out of order.
async function poll() {
  const fresh = [];
  const { seen } = await chrome.storage.local.get('seen');
  const known = new Set(seen || []);
  const firstRun = !known.size;
  for (let offset = 0; offset < LATEST_MAX_OFFSET; offset += PAGE) {
    const page = await fetchLatest(offset, PAGE);
    const unseen = page.filter((e) => !known.has(e.alias));
    fresh.push(...unseen);
    if (firstRun || (offset >= PAGE && !unseen.length)) break;
  }

  await mutate((s) => {
    const seenSet = new Set(s.seen);
    for (const e of fresh) {
      if (seenSet.has(e.alias)) continue;
      seenSet.add(e.alias);
      s.eps[e.alias] = { ...s.eps[e.alias], ...e };
      if (s.done[e.alias] || s.dismissed[e.alias] || has(s.queue, e.alias)) continue;
      s.queue.push({ alias: e.alias, addedAt: Date.now() });
    }
    s.seen = [...seenSet].slice(-3000);
    s.polledAt = Date.now();
    prune(s);
    return ['eps', 'queue', 'seen', 'polledAt'];
  });
  enrich();
}

// Search results lack intensity and tracklists; fetch them for episodes that
// feed ranking (queued), the taste profile (saved, history) or the Tracks tab
// (playing).
let enriching = false;
async function enrich() {
  if (enriching) return;
  enriching = true;
  try {
    for (;;) {
      const s = await load();
      const todo = [...new Set([s.now?.alias, ...s.queue.map((q) => q.alias), ...s.saved, ...s.history])]
        .filter((a) => a && s.eps[a] && (!s.eps[a].detail || !s.eps[a].tracks))
        .slice(0, 10);
      if (!todo.length) return;
      const got = {};
      await Promise.all(
        todo.map(async (a) => {
          const { path, detail } = s.eps[a];
          try {
            const ep = detail ? {} : await fetchEpisode(path);
            ep.tracks = await fetchTracks(path).catch(() => []);
            ep.artists = [...new Set(ep.tracks.map((t) => t.artist.toLowerCase()).filter(Boolean))];
            got[a] = ep;
          } catch {
            got[a] = { detail: true, missing: true, tracks: [] }; // don't retry forever
          }
        }),
      );
      await mutate((t) => {
        for (const [a, ep] of Object.entries(got)) if (t.eps[a]) t.eps[a] = { ...t.eps[a], ...ep };
        return ['eps'];
      });
    }
  } finally {
    enriching = false;
  }
}

// --- syncing My NTS (follows, saved episodes, history) -------------------------

// We read My NTS the same way you would: by loading the pages in a background
// tab and reading the lists off them. No credentials are touched.
async function sync() {
  const { syncTab } = await chrome.storage.session.get('syncTab');
  if (syncTab) return; // already running
  const tab = await chrome.tabs.create({ url: NTS + SYNC_PAGES[0], active: false });
  await chrome.storage.session.set({ syncTab: { id: tab.id, step: 0, startedAt: Date.now() } });
  await save({ syncError: null });
  setTimeout(() => finishSync('Sync timed out'), 150_000);
}

async function finishSync(error) {
  const { syncTab } = await chrome.storage.session.get('syncTab');
  if (!syncTab) return;
  await chrome.storage.session.remove('syncTab');
  chrome.tabs.remove(syncTab.id).catch(() => {});
  if (error) await save({ syncError: error });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { syncTab } = await chrome.storage.session.get('syncTab');
  if (syncTab?.id === tabId) await chrome.storage.session.remove('syncTab');
});

async function onScraped(msg, sender) {
  if (msg.kind === 'signedOut') {
    const { syncTab } = await chrome.storage.session.get('syncTab');
    if (syncTab?.id === sender.tab?.id) await finishSync('Sign in to nts.live to sync your hosts');
    return;
  }

  if (msg.kind === 'shows') {
    const prev = (await load()).follows.shows;
    const shows = await Promise.all(
      msg.items.map(async (it) => prev.find((p) => p.alias === it.alias) || fetchShow(it.alias).catch(() => it)),
    );
    await mutate((s) => {
      s.follows = { shows, syncedAt: Date.now() };
      return ['follows'];
    });
  } else if (msg.kind === 'saved' || msg.kind === 'history') {
    await mutate((s) => {
      const aliases = [];
      for (const path of msg.items) {
        const p = parsePath(path);
        if (!p) continue;
        aliases.push(p.alias);
        s.eps[p.alias] ??= { ...p, name: '', genres: [], moods: [], date: 0 };
      }
      // A fully loaded saved list replaces ours (so un-saving counts); anything
      // partial, and history, only adds.
      s[msg.kind] =
        msg.kind === 'saved' && msg.complete
          ? aliases
          : [...new Set([...aliases, ...s[msg.kind]])].slice(0, 300);
      return ['eps', msg.kind];
    });
    enrich();
  }

  const { syncTab } = await chrome.storage.session.get('syncTab');
  if (syncTab?.id !== sender.tab?.id) return; // you were just browsing My NTS
  const step = syncTab.step + 1;
  if (step >= SYNC_PAGES.length) return finishSync();
  await chrome.storage.session.set({ syncTab: { ...syncTab, step } });
  await chrome.tabs.update(syncTab.id, { url: NTS + SYNC_PAGES[step] });
}

// --- playback -----------------------------------------------------------------

// Tabs that were already open when the extension was installed or reloaded
// have no content script (or an orphaned one), so inject it if nothing answers.
// A newer copy retires any older one on the page.
// `tries` is in half seconds; a tab that's still loading needs the full 20.
async function sendToTab(tabId, msg, tries = 40) {
  let injected = false;
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      if (!injected && i >= 1) {
        injected = true;
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 500)); // content script not ready yet
    }
  }
  throw new Error('NTS tab did not respond');
}

// One NTS tab does the playing: the one last used, else whichever is audible,
// pinned or open. The last-used tab is forgotten when Chrome restarts.
async function findPlayerTab() {
  const { playerTab: lastId, syncTab } = await chrome.storage.session.get(['playerTab', 'syncTab']);
  const tabs = (await chrome.tabs.query({ url: `${NTS}/*` })).filter((t) => t.id !== syncTab?.id);
  return tabs.find((t) => t.id === lastId) || tabs.find((t) => t.audible) || tabs.find((t) => t.pinned) || tabs[0];
}

// The player tab, opening a new pinned one if there's none.
async function playerTab(ep) {
  let tab = await findPlayerTab();
  if (!tab) {
    // Chrome won't start media in a tab that has never been shown, so open it in front.
    tab = await chrome.tabs.create({ url: NTS + ep.path, pinned: true, active: true });
  } else if (tab.discarded) {
    await chrome.tabs.update(tab.id, { active: true });
  }
  await chrome.storage.session.set({ playerTab: tab.id });
  return tab;
}

// The player tab, if there's one that's awake to take a command. A discarded
// tab has nothing loaded, so playing it means loading again.
async function livePlayerTab() {
  const tab = await findPlayerTab();
  return tab && !tab.discarded ? tab : null;
}

// `pos`: where it is now, after a seek, until the tab next reports in.
async function markPlaying(alias, playing, pos) {
  await mutate((t) => {
    if (t.now?.alias !== alias) return [];
    t.now = { ...t.now, playing, at: Date.now(), ...(pos != null && { pos }) };
    return ['now'];
  });
}

// Playback commands run one at a time, so a double press or a play straight
// after a pause can't interleave with a load still in progress.
let playback = Promise.resolve();
function serial(fn) {
  const run = playback.then(fn);
  playback = run.catch(() => {});
  return run;
}

// `front`: the episode being left goes to the top of the queue. `at`: start there
// (seconds) instead of where you left off.
async function play(alias, { front, at, path } = {}) {
  const s = await load();
  let ep = s.eps[alias];
  if (!ep && path) ep = await fetchEpisode(path).catch(() => null);
  if (!ep?.src) throw new Error('No audio for this episode');
  const prev = s.now?.alias;

  // Update the panel straight away; loading can take a few seconds.
  await mutate((t) => {
    t.eps[alias] ??= ep;
    if (front && prev && prev !== alias && has(t.queue, prev)) place(t, prev, topRank(t.queue));
    const q = t.queue.find((x) => x.alias === alias);
    if (q) delete q.rank;
    else if (!t.done[alias]) t.queue.push({ alias, addedAt: Date.now() });
    const p = t.progress[alias];
    t.now = { alias, path: ep.path, playing: false, pos: at ?? p?.pos ?? 0, dur: p?.dur || 0, at: Date.now() };
    return ['eps', 'queue', 'now'];
  });

  const tab = await playerTab(ep);
  const { started } = await sendToTab(tab.id, {
    type: 'load',
    ep: { alias, path: ep.path, src: ep.src, name: ep.name, thumb: ep.thumb, at },
  });
  // Chrome holds back media in a tab that has never been on screen (e.g. one
  // restored after a restart), and may block autoplay. Showing the tab lets
  // the former through and puts the play button in reach for the latter.
  if (!started) await chrome.tabs.update(tab.id, { active: true });
  else await markPlaying(alias, true);
  return { started };
}

async function next() {
  const s = await load();
  const [first] = orderQueue(s, buildProfile(s));
  if (!first) return { empty: true };
  return play(first.alias);
}

// Moves on from the episode playing, which leaves the queue. Skipping one in
// its first few minutes counts against it, like removing it.
async function skip() {
  const s = await load();
  const alias = s.now?.alias;
  if (!orderQueue(s, buildProfile(s)).length) return { empty: true };
  if (alias) {
    await mutate((t) => {
      const p = t.progress[alias];
      t.queue = without(t.queue, alias);
      if (isDone(p)) t.done[alias] = Date.now();
      else if ((p?.pos || 0) < 300) t.dismissed[alias] = Date.now();
      return ['queue', 'done', 'dismissed'];
    });
  }
  return next();
}

// Asks the player tab to play (msg.type 'resume') or seek in (msg.type
// 'seek') the episode it already has loaded, which NTS restores after a reload. Null when it doesn't have it, or
// there's no tab to ask, and the episode needs loading.
async function inPlayerTab(msg) {
  const tab = await livePlayerTab();
  if (!tab) return null;
  const r = await sendToTab(tab.id, msg, 6).catch(() => null);
  if (r?.state === 'playing') {
    await chrome.storage.session.set({ playerTab: tab.id });
    await markPlaying(msg.alias, true, msg.t);
    return { started: true };
  }
  if (r?.state === 'blocked') {
    // Same as in play(): showing the tab lets Chrome start the media.
    await chrome.tabs.update(tab.id, { active: true });
    return { started: false };
  }
  return null;
}

// Play/pause from the panel. `want` is what its button showed, so a stale
// playing flag can't turn a press of play into a pause. Playing picks up in
// the tab if the episode is still loaded there, and otherwise loads it again
// where you left off (tab closed, reloaded, discarded, Chrome restarted).
async function toggle(want) {
  const { now } = await load();
  if (!now?.alias) return want ? next() : null;
  if (want) return (await inPlayerTab({ type: 'resume', alias: now.alias })) || play(now.alias);
  const tab = await livePlayerTab();
  if (tab) await sendToTab(tab.id, { type: 'pause' }, 6).catch(() => {});
  await markPlaying(now.alias, false); // nothing left that could be playing it
  return null;
}

// Jump to the start of a track: in place if its episode is the one playing.
async function jump({ alias, path, offset }) {
  if ((await load()).now?.alias === alias) {
    const r = await inPlayerTab({ type: 'seek', alias, t: offset });
    if (r) return r;
  }
  return play(alias, { at: offset, path });
}

// Remember each track as it starts playing, for the Tracks tab.
async function logTrack(n) {
  if (!n?.playing || !n.alias) return;
  await mutate((s) => {
    const ep = s.eps[n.alias];
    const t = ep?.tracks && trackAt(ep.tracks, n.pos);
    const last = s.plays[0];
    if (!t || (last?.alias === n.alias && last.offset === t.offset)) return [];
    s.plays.unshift({ alias: n.alias, path: ep.path, artist: t.artist, title: t.title, offset: t.offset, at: Date.now() });
    s.plays.length = Math.min(s.plays.length, 500);
    return ['plays'];
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.now) logTrack(changes.now.newValue).catch(() => {});
});

async function onEnded(alias) {
  const s = await mutate((t) => {
    t.done[alias] = Date.now();
    t.queue = without(t.queue, alias);
    return ['done', 'queue'];
  });
  // Let NTS's own "up next" carry on if our queue is empty.
  if (s.settings.autoAdvance && s.queue.length) await serial(next);
}

// The content script reports whatever NTS starts playing, including episodes
// you started on the site yourself.
async function onNowPlaying({ alias, path }, sender) {
  await chrome.storage.session.set({ playerTab: sender.tab.id });
  const s = await load();
  let ep = s.eps[alias];
  if (!ep && path) ep = await fetchEpisode(path).catch(() => null);
  await mutate((t) => {
    if (ep) t.eps[alias] = { ...t.eps[alias], ...ep };
    if (!t.done[alias] && !has(t.queue, alias)) t.queue.push({ alias, addedAt: Date.now() });
    return ['eps', 'queue'];
  });
  enrich();
}

// Adds episodes by nts.live URL. Asking for something explicitly overrides an
// earlier dismissal or finish.
const pathOf = (url) => {
  try {
    return parsePath(new URL(url, NTS).pathname)?.path;
  } catch {
    return null;
  }
};

async function add(urls) {
  const paths = [...new Set(urls.map(pathOf).filter(Boolean))];
  if (!paths.length) throw new Error('No NTS episode links found');
  const eps = (await Promise.all(paths.map((p) => fetchEpisode(p).catch(() => null)))).filter(Boolean);
  if (!eps.length) throw new Error("Couldn't load those episodes from NTS");
  await mutate((s) => {
    for (const ep of eps) {
      s.eps[ep.alias] = { ...s.eps[ep.alias], ...ep };
      delete s.dismissed[ep.alias];
      delete s.done[ep.alias];
      if (!has(s.queue, ep.alias)) s.queue.push({ alias: ep.alias, addedAt: Date.now() });
    }
    return ['eps', 'queue', 'dismissed', 'done'];
  });
  enrich();
  return { added: eps.length, failed: paths.length - eps.length };
}

// --- messages -----------------------------------------------------------------

const handlers = {
  play: (m) => serial(() => play(m.alias, { front: true })),
  jump: (m) => serial(() => jump(m)),
  skip: () => serial(skip),
  toggle: (m) => serial(() => toggle(m.play)),
  ended: (m) => onEnded(m.alias),
  // The tab's stream died (its URLs expire a few hours after it loads), so
  // load it again there, from where it stopped.
  stalled: async (m, sender) => {
    await chrome.storage.session.set({ playerTab: sender.tab.id });
    return serial(() => play(m.alias, { at: m.at, path: m.path }));
  },
  nowPlaying: (m, sender) => onNowPlaying(m, sender),
  scraped: (m, sender) => onScraped(m, sender),
  isSyncTab: async (_m, sender) => (await chrome.storage.session.get('syncTab')).syncTab?.id === sender.tab?.id,
  poll: () => poll(),
  sync: () => sync(),
  add: (m) => add(m.urls),

  // `aliases` is the queue as displayed (one front episode per card), and a
  // card moved there from `from` to `moved`. Everything down to the lower of
  // the two (and to any earlier manual placement) is fixed in the order
  // shown. The rest stays ranked, following on from what it did before, so
  // it keeps the order you saw.
  reorder: (m) =>
    mutate((s) => {
      const shown = orderQueue(s, buildProfile(s));
      const q = new Map(s.queue.map((x) => [x.alias, x]));
      let last = Math.max(m.moved, m.from ?? m.moved);
      m.aliases.forEach((a, i) => q.get(a)?.rank != null && (last = Math.max(last, i)));
      m.aliases.slice(0, last + 1).forEach((a, i) => place(s, a, i));
      s.chainFrom = shown[last + 1]?.after ?? null;
      return ['queue', 'chainFrom'];
    }),

  // Play next: to the top of the queue, stack and all.
  top: (m) =>
    mutate((s) => {
      if (has(s.queue, m.alias)) place(s, m.alias, topRank(s.queue));
      return ['queue'];
    }),

  // Taking something out of the queue counts against it, like a dismissal.
  remove: (m) =>
    mutate((s) => {
      for (const alias of m.aliases) {
        s.queue = without(s.queue, alias);
        s.dismissed[alias] = Date.now();
      }
      return ['queue', 'dismissed'];
    }),

  settings: (m) =>
    mutate((s) => {
      s.settings = { ...s.settings, ...m.settings };
      return ['settings'];
    }),
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg, sender)).then(
    (value) => reply({ ok: true, value: value ?? null }),
    (err) => reply({ ok: false, error: String(err?.message || err) }),
  );
  return true;
});
