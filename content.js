// Runs on every nts.live page. Three jobs:
//  1. Keep a durable per-episode playback position and restore it when NTS
//     loads an episode further back than where you left it.
//  2. Load episodes into NTS's own player when the queue asks.
//  3. Read your follows, saved episodes and history off the My NTS pages.

(() => {
  const TICK_MS = 2000;
  const SAVE_EVERY_MS = 5000;
  const RESUME_MIN_GAP_S = 20; // don't bother seeking for less than this
  const RESUME_WINDOW_MS = 15000; // keep re-applying the resume for this long
  const QUIET_AFTER_END_MS = 20000; // ignore NTS's own "up next" while ours loads
  const MIXCLOUD_ORIGIN = 'https://player-widget.mixcloud.com';

  // A copy injected after an extension reload retires the older one on the page.
  const root = document.documentElement;
  const me = String(Math.random());
  root.dataset.ntsq = me;
  const superseded = () => root.dataset.ntsq !== me;

  let current = null; // {alias, startedAt, lastSave, floor, target, seekedAt, attempts}
  let pending = null; // {alias, at}: what we last asked NTS to load
  let seekTo = null; // {alias, t}: where the next load should start
  let quietUntil = 0;
  let mixcloud = { pos: 0, dur: 0, playing: false, at: 0 };
  let methodId = 1e6; // high, so Mixcloud responses never collide with NTS's own calls

  const send = (msg) => {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // Extension was reloaded; this page's script is orphaned until refresh.
    }
  };

  // NTS writes {episodeAlias, currentPositionS} here about once a second while
  // an archive episode plays, for both its own player and the Mixcloud embed.
  function activeEpisode() {
    try {
      return JSON.parse(localStorage.getItem('activeEpisode') || '{}') || {};
    } catch {
      return {};
    }
  }

  const footer = () => document.querySelector('.footer-player--episode-player');

  function footerPath() {
    const a = footer()?.querySelector('a[href*="/episodes/"]');
    return a ? new URL(a.href).pathname : null;
  }

  // --- the player behind the footer: an <audio> element or a Mixcloud iframe

  function mixcloudFrame() {
    return footer()?.querySelector('iframe[src*="mixcloud"]') || null;
  }

  function mixcloudCall(methodName, ...args) {
    const frame = mixcloudFrame();
    frame?.contentWindow.postMessage(
      JSON.stringify({ type: 'method', data: { methodId: ++methodId, methodName, args } }),
      MIXCLOUD_ORIGIN,
    );
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== MIXCLOUD_ORIGIN) return;
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m?.mixcloud !== 'playerWidget' || m.type !== 'event') return;
    const { eventName, args = [] } = m.data || {};
    if (eventName === 'progress') {
      mixcloud = { ...mixcloud, pos: args[0] || 0, dur: args[1] || mixcloud.dur, at: Date.now() };
    } else if (eventName === 'play') {
      mixcloud.playing = true;
    } else if (eventName === 'pause') {
      mixcloud.playing = false;
      tick();
    } else if (eventName === 'ended') {
      mixcloud.playing = false;
      ended();
    }
  });

  // In case the widget's events don't reach us, a position NTS keeps moving
  // forward also counts as playing.
  let lastSeen = { alias: null, pos: -1 };
  function advancing(ae) {
    const moved = ae.episodeAlias === lastSeen.alias && ae.currentPositionS > lastSeen.pos;
    lastSeen = { alias: ae.episodeAlias, pos: ae.currentPositionS };
    return moved;
  }

  // The <audio> NTS is playing the archive through: the one whose position
  // agrees with activeEpisode (the live radio has its own element).
  function audioFor(ae) {
    const els = [...document.querySelectorAll('audio')].filter((a) => a.src);
    if (!els.length) return null;
    return els.reduce((best, a) =>
      Math.abs(a.currentTime - (ae.currentPositionS || 0)) < Math.abs(best.currentTime - (ae.currentPositionS || 0))
        ? a
        : best,
    );
  }

  function player(ae) {
    if (mixcloudFrame()) {
      const live = Date.now() - (mixcloud.at || 0) < 3000;
      return {
        pos: live ? mixcloud.pos : ae.currentPositionS || 0,
        dur: mixcloud.dur,
        playing: mixcloud.playing || advancing(ae),
        seek: (t) => mixcloudCall('seek', t),
      };
    }
    const el = audioFor(ae);
    if (!el) return null;
    return {
      pos: el.currentTime,
      dur: Number.isFinite(el.duration) ? el.duration : 0,
      playing: !el.paused,
      seek: (t) => (el.currentTime = t),
      el,
    };
  }

  // --- tracking -------------------------------------------------------------

  let wasPlaying = false;

  function tick() {
    if (superseded()) return;
    const ae = activeEpisode();
    const p = player(ae);
    if (!p) return;

    // activeEpisode lags a switch by a second or so; until it catches up its
    // position won't match the player's, and we skip rather than misattribute.
    let alias = ae.episodeAlias;
    if (!alias || Math.abs((ae.currentPositionS || 0) - p.pos) > 15) {
      alias = pending && Date.now() - pending.at < 60000 ? pending.alias : null;
    }
    if (!alias) return;

    if (!p.playing) {
      if (wasPlaying && current?.alias === alias) persist(alias, p, false);
      wasPlaying = false;
      return;
    }
    wasPlaying = true;

    if (current?.alias !== alias) {
      if (Date.now() < quietUntil && alias !== pending?.alias) return;
      current = { alias, startedAt: Date.now(), lastSave: Date.now(), floor: 0, attempts: 0 };
      send({ type: 'nowPlaying', alias, path: footerPath() });
      if (seekTo?.alias === alias) {
        Object.assign(current, { target: seekTo.t, seekedAt: Date.now(), attempts: 1 });
        seekTo = null;
        p.seek(current.target);
      } else {
        resume(alias, p);
      }
      return;
    }

    // NTS may apply its own (older) start position after ours; re-apply ours
    // for a few seconds, but give up quickly so we never fight a manual seek.
    const fresh = Date.now() - current.startedAt < RESUME_WINDOW_MS;
    if (current.target != null) {
      // Asked to start at a specific point, which NTS may override with its
      // own saved position (earlier or later).
      const expected = current.target + (Date.now() - current.seekedAt) / 1000;
      if (fresh && Math.abs(p.pos - expected) > 10) {
        if (current.attempts < 4) {
          current.attempts++;
          current.seekedAt = Date.now();
          p.seek(current.target);
        }
        return;
      }
    } else if (current.floor && p.pos < current.floor - 10) {
      if (fresh && current.attempts < 3) {
        current.attempts++;
        p.seek(current.floor);
        return;
      }
      if (fresh) return; // don't overwrite the saved position while it's settling
    }

    if (Date.now() - current.lastSave >= SAVE_EVERY_MS) persist(alias, p, true);
  }

  async function resume(alias, p) {
    const key = `p:${alias}`;
    const saved = (await chrome.storage.local.get(key))[key];
    if (!saved || current?.alias !== alias) return;
    if (saved.pos < p.pos + RESUME_MIN_GAP_S) return;
    if (saved.dur && saved.pos > saved.dur - 30) return; // finished; start over
    current.floor = saved.pos;
    current.attempts = 1;
    p.seek(saved.pos);
  }

  function persist(alias, p, playing) {
    if (!current || current.alias !== alias) return;
    current.lastSave = Date.now();
    const at = Date.now();
    const pos = Math.floor(p.pos);
    const dur = Math.floor(p.dur || 0);
    try {
      chrome.storage.local.set({
        [`p:${alias}`]: { pos, dur, at },
        now: { alias, path: footerPath(), playing, pos, dur, at },
      });
    } catch {
      // orphaned after an extension reload
    }
  }

  function ended() {
    if (!current) return;
    const { alias } = current;
    const ae = activeEpisode();
    const p = player(ae);
    if (p) persist(alias, { pos: p.dur || p.pos, dur: p.dur }, false);
    current = null;
    pending = null;
    quietUntil = Date.now() + QUIET_AFTER_END_MS;
    send({ type: 'ended', alias });
  }

  setInterval(tick, TICK_MS);
  document.addEventListener('pause', (e) => e.target instanceof HTMLAudioElement && tick(), true);
  document.addEventListener('ended', (e) => e.target instanceof HTMLAudioElement && current && ended(), true);
  // Last chance to save before the tab closes, reloads or is discarded.
  window.addEventListener('pagehide', () => {
    const ae = activeEpisode();
    const p = player(ae);
    if (current && p) persist(current.alias, p, false);
  });

  // --- commands from the extension --------------------------------------------

  // NTS has one document-level click listener for every play button, which
  // reads the episode from data-* attributes. A hidden button of our own goes
  // through exactly the same path as clicking play on the site.
  function load(ep) {
    const b = document.createElement('button');
    b.className = 'mixcloud-btn';
    b.hidden = true;
    const data = {
      src: ep.src,
      permalink: ep.path,
      thumbnail: ep.thumb || '',
      'episode-name': ep.name || '',
      'event-label': 'Episode',
    };
    for (const [k, v] of Object.entries(data)) b.setAttribute(`data-${k}`, v);
    document.body.append(b);
    const before = activeEpisode();
    pending = { alias: ep.alias, at: Date.now() };
    seekTo = ep.at != null ? { alias: ep.alias, t: ep.at } : null;
    quietUntil = 0;
    mixcloud = { pos: 0, dur: 0, playing: false, at: 0 };
    b.click();
    b.remove();
    return waitForStart(ep.alias, before);
  }

  // NTS only records an episode as active once its position moves past zero,
  // so either the alias switching over or its position moving means it started.
  async function waitForStart(alias, before) {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 500));
      const ae = activeEpisode();
      if (ae.episodeAlias !== alias) continue;
      if (before.episodeAlias !== alias || ae.currentPositionS !== before.currentPositionS) return true;
    }
    return false;
  }

  function toggle() {
    const button = footer()?.querySelector('[class*="player__play-button"]');
    if (button) return button.click();
    const p = player(activeEpisode());
    if (p?.el) p.el.paused ? p.el.play() : p.el.pause();
  }

  // Jump within the episode that's playing, starting playback if it's paused.
  function seek(t) {
    const p = player(activeEpisode());
    if (!p) return false;
    if (current) Object.assign(current, { floor: 0, target: null });
    p.seek(t);
    if (!p.playing) toggle();
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (superseded()) return false;
    if (msg.type === 'seek') {
      reply({ started: seek(msg.t) });
      return false;
    }
    if (msg.type === 'load') {
      load(msg.ep).then((started) => reply({ started }));
      return true;
    }
    if (msg.type !== 'toggle') return false;
    toggle();
    reply({ ok: true });
    return false;
  });

  // --- My NTS -------------------------------------------------------------------

  const PAGES = {
    '/my-nts/favourites/shows': 'shows',
    '/my-nts/favourites/episodes': 'saved',
    '/my-nts/history': 'history',
  };

  function readList(kind) {
    const items = [...document.querySelectorAll('.my-nts__list-container .article-list-item')];
    return items
      .map((item) => {
        if (kind === 'shows') {
          const a = item.querySelector('a[href^="/shows/"]:not([href*="/episodes/"])');
          if (!a) return null;
          const alias = a.getAttribute('href').split('/')[2];
          const name = item.querySelector('[class*="title"]')?.textContent.trim();
          return { alias, name: name || alias };
        }
        const a = item.querySelector('a[href*="/episodes/"]');
        return a ? new URL(a.href).pathname : null;
      })
      .filter(Boolean);
  }

  const HISTORY_LIMIT = 200;

  // Lists load 10 at a time as you scroll (this works in background tabs
  // too), so keep scrolling until the count stops growing.
  async function scrape() {
    const path = location.pathname.replace(/\/$/, '');
    if (path.startsWith('/sign-in')) return send({ type: 'scraped', kind: 'signedOut' });
    const kind = PAGES[path];
    if (!kind) return;
    // Only scroll through the whole list in the extension's own sync tab, not
    // while you're browsing My NTS yourself.
    const deep = (await send({ type: 'isSyncTab' }))?.value === true;
    const start = Date.now();
    let last = -1;
    let stable = 0;
    let complete = false;
    while (Date.now() - start < 40000) {
      await new Promise((r) => setTimeout(r, 1200));
      if (location.pathname.replace(/\/$/, '') !== path) return;
      const n = readList(kind).length;
      if (kind === 'history' && n >= HISTORY_LIMIT) break;
      stable = n === last ? stable + 1 : 0;
      last = n;
      if (stable >= 3 && (n > 0 || Date.now() - start > 8000)) {
        complete = deep;
        break;
      }
      if (deep) window.scrollTo(0, document.body.scrollHeight);
    }
    if (deep) window.scrollTo(0, 0);
    const items = readList(kind).slice(0, HISTORY_LIMIT);
    // An empty follows or saved list is far more likely a page that failed to
    // load than a real one, and would wipe what we have.
    if (!items.length && kind !== 'history') return;
    send({ type: 'scraped', kind, items, complete });
  }

  // NTS is a single-page app, so watch for client-side navigation too.
  let lastPath = null;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    scrape();
  }, 1000);
})();
