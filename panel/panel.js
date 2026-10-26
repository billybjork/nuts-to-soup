import { load, isDone } from '../lib/store.js';
import { NTS } from '../lib/nts.js';
import { buildProfile, orderQueue, topGenres } from '../lib/rank.js';

const ICONS = {
  play: '<svg viewBox="0 0 16 16"><path d="M4 2l10 6-10 6z"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M3 2h4v12H3zM9 2h4v12H9z"/></svg>',
  next: '<svg viewBox="0 0 16 16"><path d="M2 2l8 6-8 6zM11 2h3v12h-3z"/></svg>',
  add: '<svg viewBox="0 0 16 16"><path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z"/></svg>',
  remove: '<svg viewBox="0 0 16 16"><path d="M3.4 2L8 6.6 12.6 2 14 3.4 9.4 8l4.6 4.6-1.4 1.4L8 9.4 3.4 14 2 12.6 6.6 8 2 3.4z"/></svg>',
  grip: '<svg viewBox="0 0 10 14"><path d="M1 1h3v3H1zM6 1h3v3H6zM1 5.5h3v3H1zM6 5.5h3v3H6zM1 10h3v3H1zM6 10h3v3H6z"/></svg>',
};

let state = null;
let view = 'queue';
let focus = 0; // keyboard focus index in the current list
let rows = []; // aliases in the current list, in display order
let sorting = false; // a drag is in progress; hold off re-rendering

try {
  view = localStorage.getItem('view') || 'queue';
  if (!['queue', 'tracks', 'hosts'].includes(view)) view = 'queue'; // "inbox" no longer exists
} catch {}

const $ = (sel) => document.querySelector(sel);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (ts) =>
  ts ? new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';

function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function ago(ts) {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

async function send(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (r && !r.ok) toast(r.error);
  return r;
}

// "Playing" not refreshed for a minute means the tab went away mid-play.
const isPlaying = (n) => !!n?.playing && Date.now() - n.at < 60000;

// Position now, extrapolated between the content script's 5-second saves.
function livePosition() {
  const n = state.now;
  if (!n?.alias) return 0;
  return (n.pos || 0) + (isPlaying(n) ? (Date.now() - n.at) / 1000 : 0);
}

// --- rendering ------------------------------------------------------------------

function renderNow() {
  const el = $('#now');
  const n = state.now;
  const ep = n?.alias && state.eps[n.alias];
  const playing = isPlaying(n);
  if (!ep) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const dur = state.progress[n.alias]?.dur || n.dur || 0;
  const pos = livePosition();
  el.innerHTML = `
    <img src="${esc(ep.image || ep.thumb)}" alt="" />
    <div>
      <a class="title" href="${NTS}${esc(ep.path)}" target="_blank">${esc(ep.name || ep.alias)}</a>
      <div class="meta">${playing ? 'Playing' : 'Paused'} · <span id="now-time">${fmtTime(pos)}${dur ? ` / ${fmtTime(dur)}` : ''}</span></div>
    </div>
    <div class="controls">
      <button data-act="toggle" title="Play / pause (space)">${playing ? ICONS.pause : ICONS.play}</button>
      <button data-act="next" title="Next in queue (n)">${ICONS.next}</button>
    </div>
    <div class="bar"><i id="now-bar" style="width:${dur ? Math.min(100, (pos / dur) * 100) : 0}%"></i></div>`;
}

function row(item, i) {
  const { ep } = item;
  const p = state.progress[ep.alias];
  const pct = p?.dur ? Math.min(100, (p.pos / p.dur) * 100) : 0;
  const notes = [];
  if (pct && !isDone(p) && p.pos > 60) notes.push(`Resume ${fmtTime(p.pos)}`);
  notes.push(...(item.why || []));
  return `
    <article class="row${i === focus ? ' focus' : ''}" data-alias="${esc(ep.alias)}" data-i="${i}">
      <button class="grip" data-grip title="Drag to reorder (alt + up/down)">${ICONS.grip}</button>
      <div class="thumb">
        <img src="${esc(ep.image || ep.thumb)}" alt="" loading="lazy" />
        ${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
      </div>
      <div class="body">
        <a class="title" href="${NTS}${esc(ep.path)}" target="_blank">${esc(ep.name || ep.alias)}</a>
        <div class="meta">${esc([fmtDate(ep.date), ep.location].filter(Boolean).join(' · '))}</div>
        <div class="tags">
          ${ep.genres.slice(0, 4).map((g) => `<span class="tag">${esc(g)}</span>`).join('')}
        </div>
        ${notes.length ? `<div class="why">${esc(notes.join(' · '))}</div>` : ''}
      </div>
      <div class="actions">
        <button data-act="play" title="Play (enter)">${ICONS.play}</button>
        <button data-act="remove" title="Remove (x)">${ICONS.remove}</button>
      </div>
    </article>`;
}

function renderQueue(prof) {
  const items = orderQueue(state, prof).filter((i) => i.alias !== state.now?.alias);
  rows = items.map((i) => i.alias);
  $('#list').innerHTML = items.length
    ? items.map((it, i) => row(it, i)).join('')
    : '<div class="empty">Nothing queued. New episodes show up here as NTS adds them.</div>';
  $('#foot').innerHTML = `
    <form class="add" data-form="add">
      <input name="urls" placeholder="Paste NTS episode links to add" autocomplete="off" />
      <button>Add</button>
    </form>
    <label class="setting" style="padding:0">
      <input type="checkbox" data-act="autoAdvance" ${state.settings.autoAdvance ? 'checked' : ''} />
      Play the next one when a mix ends
    </label>
    <span>Checked ${ago(state.polledAt)}</span>
    <button data-act="poll">Check now</button>
    <div class="keys">Keys: J/K move · Enter play · X remove · Alt+↑/↓ reorder · Space play/pause · N next. Drag a mix by its grip to reorder, drag an episode link here, paste one, or right-click it on nts.live to add it.</div>`;
}

const dayLabel = (ts) => {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 864e5);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return fmtDate(ts);
};

function renderTracks() {
  rows = [];
  const n = state.now;
  const plays = state.plays;
  let day = '';
  const html = plays.map((t, i) => {
    const ep = state.eps[t.alias];
    const live = i === 0 && isPlaying(n) && n.alias === t.alias;
    const head = dayLabel(t.at) !== day ? `<div class="section">${esc((day = dayLabel(t.at)))}</div>` : '';
    return `${head}
      <button class="track${live ? ' live' : ''}" data-act="jump" data-alias="${esc(t.alias)}" data-path="${esc(t.path)}" data-offset="${t.offset}" title="Jump to the start of this track">
        <img src="${esc(ep?.thumb || ep?.image || '')}" alt="" loading="lazy" />
        <div>
          <div class="name">${esc([t.artist, t.title].filter(Boolean).join(' — '))}</div>
          <div class="meta">${esc(ep?.name || t.alias)} · ${fmtTime(t.offset)}</div>
        </div>
        <time>${live ? 'Playing' : new Date(t.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
      </button>`;
  });
  $('#list').innerHTML = plays.length
    ? html.join('')
    : '<div class="empty">Tracks show up here as they play. Click one to jump back to it.</div>';
  $('#foot').innerHTML = `<div class="keys">Tracks come from NTS's tracklists, so mixes without one aren't listed.</div>`;
}

function renderHosts(prof) {
  rows = [];
  const shows = [...state.follows.shows].sort((a, b) => a.name.localeCompare(b.name));
  const lastEp = {};
  for (const ep of Object.values(state.eps)) {
    if (ep.date > (lastEp[ep.show] || 0)) lastEp[ep.show] = ep.date;
  }
  const genres = topGenres(prof);
  $('#list').innerHTML = `
    <div class="section">Following (${shows.length})</div>
    ${
      shows.length
        ? shows
            .map(
              (s) => `<div class="host">
                <a href="${NTS}/shows/${esc(s.alias)}" target="_blank">${esc(s.name)}</a>
                <span>${lastEp[s.alias] ? fmtDate(lastEp[s.alias]) : ''}</span>
              </div>`,
            )
            .join('')
        : '<div class="empty">No hosts yet. Heart a show on nts.live, then sync.</div>'
    }
    <div class="section">Your sound</div>
    <div class="genres tags">${
      genres.length
        ? genres.map(([g]) => `<span class="tag">${esc(g)}</span>`).join('')
        : '<span class="meta">Builds up as you save, finish and queue mixes.</span>'
    }</div>`;
  $('#foot').innerHTML = `
    <span>Synced from My NTS ${ago(state.follows.syncedAt)}</span>
    <button data-act="sync">Sync now</button>
    ${state.syncError ? `<span class="error">${esc(state.syncError)}</span>` : ''}
    <div class="keys">New episodes from these hosts rank higher in your queue.</div>`;
}

function render() {
  if (!state) return;
  const prof = buildProfile(state);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  const queued = state.queue.filter((q) => q.alias !== state.now?.alias).length;
  $('#count-queue').textContent = queued || '';
  const input = $('.add input');
  const typed = input?.value;
  const hadFocus = input && document.activeElement === input;
  renderNow();
  if (view === 'queue') renderQueue(prof);
  else if (view === 'tracks') renderTracks();
  else renderHosts(prof);
  const again = $('.add input');
  if (again && typed) again.value = typed;
  if (again && hadFocus) again.focus();
  focus = Math.min(focus, Math.max(0, rows.length - 1));
}

async function refresh() {
  state = await load();
  render();
}

// --- interaction ---------------------------------------------------------------

function setView(v) {
  view = v;
  focus = 0;
  try {
    localStorage.setItem('view', v);
  } catch {}
  render();
  $('#scroll').scrollTo(0, 0);
}

function setFocus(i) {
  focus = Math.max(0, Math.min(rows.length - 1, i));
  document.querySelectorAll('.row').forEach((r) => r.classList.toggle('focus', Number(r.dataset.i) === focus));
  document.querySelector('.row.focus')?.scrollIntoView({ block: 'nearest' });
}

async function act(name, el) {
  if (name === 'autoAdvance') return send({ type: 'settings', settings: { autoAdvance: !state.settings.autoAdvance } });
  const { alias, path, offset } = { ...el?.closest('[data-alias]')?.dataset, ...el?.dataset };
  if (name === 'poll') toast('Checking Latest…');
  if (name === 'sync') toast('Syncing from My NTS in a background tab…');
  if (name === 'play' || name === 'jump') toast('Loading in your NTS tab…');
  const msg = name === 'jump' ? { type: name, alias, path, offset: Number(offset) } : alias ? { type: name, alias } : { type: name };
  const r = await send(msg);
  if (r?.value?.empty) toast('Queue is empty');
  else if (r?.value?.started === false) toast("Switched to the NTS tab. Press play there if it hasn't started");
  else if (r?.ok && (name === 'play' || name === 'jump')) $('#toast').hidden = true;
  return r;
}

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-view]');
  if (tab) return setView(tab.dataset.view);
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  e.preventDefault();
  act(btn.dataset.act, btn);
});

// --- reordering ------------------------------------------------------------------

// Drag a row by its grip. The row follows the pointer and the others slide
// out of the way; on release the new order is sent to the background.
function startSort(e, rowEl) {
  const list = $('#list');
  const scroller = $('#scroll');
  const els = [...list.querySelectorAll('.row')];
  const from = els.indexOf(rowEl);
  const grip = e.target.closest('.grip');
  const box = els.map((el) => ({ top: el.offsetTop, h: el.offsetHeight }));
  const startY = e.clientY;
  const startScroll = scroller.scrollTop;
  let y = startY;
  let to = from;
  let active = false;
  let frame = 0;

  const place = () => {
    // Keep the row inside the list as the pointer or the scroll position moves.
    const dy = y - startY + (scroller.scrollTop - startScroll);
    const top = Math.max(0, Math.min(list.offsetHeight - box[from].h, box[from].top + dy));
    const mid = top + box[from].h / 2;
    to = from;
    els.forEach((el, j) => {
      if (j === from) return;
      const m = box[j].top + box[j].h / 2;
      let shift = 0;
      if (j > from && m < mid) (shift = -box[from].h), to++;
      else if (j < from && m > mid) (shift = box[from].h), to--;
      el.style.transform = shift ? `translateY(${shift}px)` : '';
    });
    rowEl.style.transform = `translateY(${top - box[from].top}px)`;
  };

  const loop = () => {
    const r = scroller.getBoundingClientRect();
    const edge = 40;
    const dir = y < r.top + edge ? -1 : y > r.bottom - edge ? 1 : 0;
    if (dir) scroller.scrollTop += dir * 8;
    place();
    frame = requestAnimationFrame(loop);
  };

  const move = (ev) => {
    y = ev.clientY;
    if (active || Math.abs(y - startY) < 4) return;
    active = true;
    sorting = true;
    document.body.classList.add('sorting');
    rowEl.classList.add('dragging');
    frame = requestAnimationFrame(loop);
  };

  const finish = (commit) => {
    cancelAnimationFrame(frame);
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', cancel);
    document.removeEventListener('keydown', onKey);
    if (!active) return;
    document.body.classList.remove('sorting');
    els.forEach((el) => (el.style.transform = ''));
    rowEl.classList.remove('dragging');
    sorting = false;
    if (commit && to !== from) {
      const order = [...rows];
      order.splice(to, 0, ...order.splice(from, 1));
      list.insertBefore(rowEl, to > from ? els[to].nextSibling : els[to]);
      reorder(order, to);
    } else {
      refresh();
    }
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const onKey = (ev) => ev.key === 'Escape' && finish(false);

  grip.setPointerCapture(e.pointerId);
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', cancel);
  document.addEventListener('keydown', onKey);
}

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !e.target.closest('.grip')) return;
  e.preventDefault();
  document.body.classList.remove('keys');
  startSort(e, e.target.closest('.row'));
});

async function reorder(order, moved) {
  rows = order;
  await send({ type: 'reorder', aliases: order, moved });
  refresh();
}

const EPISODE_URL = /https?:\/\/(?:www\.)?nts\.live\/shows\/[^/\s]+\/episodes\/[^/?#\s]+/g;

async function addUrls(text) {
  const urls = text.match(EPISODE_URL) || [];
  if (!urls.length) return toast('No NTS episode links found');
  const r = await send({ type: 'add', urls });
  if (!r?.ok) return false;
  const { added, failed } = r.value;
  toast(`Added ${added} to the queue${failed ? ` · ${failed} couldn't be loaded` : ''}`);
  if (view !== 'queue') setView('queue');
  return true;
}

document.addEventListener('submit', async (e) => {
  if (e.target.dataset.form !== 'add') return;
  e.preventDefault();
  const input = e.target.elements.urls;
  if (await addUrls(input.value)) input.value = '';
});

// Pasting links anywhere in the panel adds them.
document.addEventListener('paste', (e) => {
  if (e.target.matches('input, textarea')) return;
  const text = e.clipboardData?.getData('text') || '';
  if (!EPISODE_URL.test(text)) return;
  EPISODE_URL.lastIndex = 0;
  e.preventDefault();
  addUrls(text);
});

// Dragging links in from a tab (e.g. the Latest page) adds them.
const dragsLinks = (e) => ['text/uri-list', 'text/plain'].some((t) => e.dataTransfer?.types.includes(t));
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!dragsLinks(e)) return;
  dragDepth++;
  document.body.classList.add('dropping');
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dropping');
  }
});
document.addEventListener('dragover', (e) => {
  if (!dragsLinks(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  addUrls(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'));
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.target.matches('input, textarea') || sorting) return;
  const key = e.key.toLowerCase();
  if (e.altKey && view === 'queue' && (key === 'arrowup' || key === 'arrowdown')) {
    const to = focus + (key === 'arrowup' ? -1 : 1);
    if (to < 0 || to >= rows.length) return;
    e.preventDefault();
    const order = [...rows];
    order.splice(to, 0, ...order.splice(focus, 1));
    focus = to;
    reorder(order, to);
    return;
  }
  if (e.altKey) return;
  const alias = rows[focus];
  const listKeys = {
    j: () => setFocus(focus + 1),
    arrowdown: () => setFocus(focus + 1),
    k: () => setFocus(focus - 1),
    arrowup: () => setFocus(focus - 1),
    enter: () => alias && view === 'queue' && act('play', document.querySelector('.row.focus')),
    x: () => alias && view === 'queue' && act('remove', document.querySelector('.row.focus')),
  };
  const globalKeys = {
    ' ': () => act('toggle'),
    n: () => act('next'),
    1: () => setView('queue'),
    2: () => setView('tracks'),
    3: () => setView('hosts'),
  };
  const fn = listKeys[key] || globalKeys[key];
  if (!fn) return;
  e.preventDefault();
  if (key in listKeys) document.body.classList.add('keys');
  fn();
});

// Re-render on any stored change. Playback ticks (position saves) only touch
// the now-playing bar, so a click or hover on a row isn't pulled out from
// under the pointer every few seconds.
let pendingRender = false;
let changed = new Set();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  Object.keys(changes).forEach((k) => changed.add(k));
  if (pendingRender) return;
  pendingRender = true;
  setTimeout(async () => {
    pendingRender = false;
    const keys = changed;
    changed = new Set();
    const prev = state?.now?.alias;
    state = await load();
    if (sorting) return;
    const ticksOnly = [...keys].every((k) => k === 'now' || k.startsWith('p:'));
    if (ticksOnly && view !== 'tracks' && state.now?.alias === prev) renderNow();
    else render();
  }, 100);
});

setInterval(() => {
  const n = state?.now;
  if (!isPlaying(n)) return;
  const dur = state.progress[n.alias]?.dur || n.dur || 0;
  const pos = livePosition();
  const time = $('#now-time');
  const bar = $('#now-bar');
  if (time) time.textContent = `${fmtTime(pos)}${dur ? ` / ${fmtTime(dur)}` : ''}`;
  if (bar && dur) bar.style.width = `${Math.min(100, (pos / dur) * 100)}%`;
}, 1000);

refresh();
