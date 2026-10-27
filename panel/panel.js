import { load, isDone } from '../lib/store.js';
import { NTS, trackAt } from '../lib/nts.js';
import { buildProfile, orderQueue, topGenres } from '../lib/rank.js';

const ICONS = {
  play: '<svg viewBox="0 0 16 16"><path d="M4 2l10 6-10 6z"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M3 2h4v12H3zM9 2h4v12H9z"/></svg>',
  skip: '<svg viewBox="0 0 16 16"><path d="M2 2l8 6-8 6zM11 2h3v12h-3z"/></svg>',
  track: '<svg viewBox="0 0 16 16"><path d="M1 3l6.5 5L1 13zM8 3l6.5 5L8 13z"/></svg>',
  more: '<svg viewBox="0 0 16 16"><path d="M1.5 6.5h3v3h-3zM6.5 6.5h3v3h-3zM11.5 6.5h3v3h-3z"/></svg>',
  grip: '<svg viewBox="0 0 6 10"><path d="M0 0h2v2H0zM4 0h2v2H4zM0 4h2v2H0zM4 4h2v2H4zM0 8h2v2H0zM4 8h2v2H4z"/></svg>',
};

let state = null;
let view = 'queue';
let shown = null; // the view last rendered; switching views doesn't animate
let focus = 0; // keyboard focus index in the current list
let rows = []; // front aliases of the cards in the current list, in display order
let cards = new Map(); // stack key -> card, as last rendered
let sorting = false; // a drag is in progress; hold off re-rendering
let seek = null; // {alias, pos, at}: a jump the NTS tab hasn't reported back yet
const open = new Set(); // stack keys shown expanded

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
  const from = seek?.alias === n.alias && seek.at > n.at ? seek : n;
  return (from.pos || 0) + (isPlaying(n) ? (Date.now() - from.at) / 1000 : 0);
}

const trackName = (t) => [t.artist, t.title].filter(Boolean).join(' — ');

// The first listed track starting after `pos`, give or take a moment for
// tracks just jumped to.
const trackAfter = (ep, pos) => ep?.tracks?.find((t) => t.offset > pos + 2);

// --- animation -------------------------------------------------------------------

const still = matchMedia('(prefers-reduced-motion: reduce)');
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

// Runs `update`, then slides each card (and the now-playing card) from where
// it was to where it ended up. One whose key is new starts from wherever its
// episode was shown before, so a queue row rises into the now-playing card and
// back; failing that it fades in.
function flip(update, animate = true) {
  if (!animate || still.matches) return update();
  const byKey = new Map();
  const byEp = new Map();
  for (const el of document.querySelectorAll('[data-key], [data-ep]')) {
    const r = el.getBoundingClientRect();
    if (el.dataset.key) byKey.set(el.dataset.key, r);
    if (el.dataset.ep && !byEp.has(el.dataset.ep)) byEp.set(el.dataset.ep, r);
  }
  update();
  for (const el of document.querySelectorAll('#now[data-key], #list > [data-key]')) {
    if (el.hidden) continue;
    el.getAnimations().forEach((a) => a.cancel());
    const from = byKey.get(el.dataset.key) || byEp.get(el.dataset.ep);
    const to = el.getBoundingClientRect();
    if (!from) {
      el.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], {
        duration: 220,
        easing: 'ease-out',
      });
      continue;
    }
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    const offscreen = (r) => r.bottom < 0 || r.top > innerHeight;
    if (offscreen(from) && offscreen(to)) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 280, easing: EASE });
  }
}

// Slides an episode out before the action that removes it; the gap it leaves
// closes once the list re-renders. `back` undoes it if the action fails.
function leave(el, dx = 40) {
  if (!el || still.matches) return Promise.resolve();
  return el
    .animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${dx}px)` }], {
      duration: 160,
      easing: 'ease-in',
      fill: 'forwards',
    })
    .finished.catch(() => {});
}
const back = (el) => el?.getAnimations().forEach((a) => a.cancel());

// Swaps in new cards, keeping any whose markup hasn't changed, so their images
// don't reload and a hover isn't lost.
function patch(list, items) {
  const old = new Map([...list.children].filter((el) => el.dataset.key).map((el) => [el.dataset.key, el]));
  const tpl = document.createElement('template');
  list.replaceChildren(
    ...items.map(({ key, html }) => {
      const el = old.get(key);
      if (el?._html === html) return el;
      tpl.innerHTML = html;
      const fresh = tpl.content.firstElementChild;
      fresh._html = html;
      return fresh;
    }),
  );
}

// --- rendering ------------------------------------------------------------------

function renderNow() {
  const el = $('#now');
  const n = state.now;
  const ep = n?.alias && state.eps[n.alias];
  if (!ep) {
    el.hidden = true;
    delete el.dataset.key;
    delete el.dataset.ep;
    return;
  }
  const playing = isPlaying(n);
  // Time, progress and the current track are filled in by tickNow().
  const html = `
    <div class="eq${playing ? ' on' : ''}"><i></i><i></i><i></i></div>
    <img src="${esc(ep.image || ep.thumb)}" alt="" />
    <div class="body">
      <a class="title" href="${NTS}${esc(ep.path)}" target="_blank">${esc(ep.name || ep.alias)}</a>
      <div class="meta">${playing ? 'Playing' : 'Paused'} · <span data-live="time"></span></div>
      ${
        ep.tracks?.length
          ? `<div class="now-track">
              <span data-live="track"></span>
              <button data-act="nextTrack" data-live="next" title="Next track (shift + n)">${ICONS.track}</button>
            </div>`
          : ''
      }
    </div>
    <div class="actions">
      <button data-act="toggle" title="Play / pause (space)">${playing ? ICONS.pause : ICONS.play}</button>
      <button data-act="skip" title="Skip to the next episode (n)">${ICONS.skip}</button>
    </div>
    <div class="bar"><i data-live="bar"></i></div>`;
  el.hidden = false;
  el.dataset.key = `now:${n.alias}`;
  el.dataset.ep = n.alias;
  if (el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
  tickNow();
}

function tickNow() {
  const n = state?.now;
  const ep = n?.alias && state.eps[n.alias];
  if (!ep) return;
  const dur = state.progress[n.alias]?.dur || n.dur || 0;
  const pos = livePosition();
  const live = (k) => $(`#now [data-live="${k}"]`) || {};
  const t = ep.tracks && trackAt(ep.tracks, pos);
  live('time').textContent = `${fmtTime(pos)}${dur ? ` / ${fmtTime(dur)}` : ''}`;
  live('track').textContent = t ? trackName(t) : '';
  live('next').disabled = !trackAfter(ep, pos);
  if (live('bar').style) live('bar').style.width = `${dur ? Math.min(100, (pos / dur) * 100) : 0}%`;
}

function card(c) {
  const { ep, stack } = c;
  const p = state.progress[ep.alias];
  const pct = p?.dur ? Math.min(100, (p.pos / p.dur) * 100) : 0;
  const notes = [fmtDate(ep.date)];
  if (pct && !isDone(p) && p.pos > 60) notes.push(`Resume ${fmtTime(p.pos)}`);
  notes.push(...(c.why || []), ep.location);
  const expanded = stack.length && open.has(c.key);
  // The next two in the stack peek out from behind the cover.
  const under = stack
    .slice(0, 2)
    .map((s, i) => `<img class="under u${i + 1}" src="${esc(s.ep.thumb || s.ep.image)}" alt="" />`)
    .reverse()
    .join('');
  return `
    <div class="card${stack.length ? ' stacked' : ''}" data-key="${esc(c.key)}" data-ep="${esc(ep.alias)}">
      <article class="row" data-alias="${esc(ep.alias)}">
        <button class="grip" data-grip title="Drag to reorder (alt + up/down)">${ICONS.grip}</button>
        <div class="thumb">
          ${under}
          <img src="${esc(ep.image || ep.thumb)}" alt="" loading="lazy" />
          ${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
          ${
            stack.length
              ? `<button class="stack-n${expanded ? ' on' : ''}" data-act="expand" title="${stack.length + 1} episodes from this show, newest first. One plays per turn">${stack.length + 1}</button>`
              : ''
          }
        </div>
        <div class="body">
          <a class="title" href="${NTS}${esc(ep.path)}" target="_blank">${esc(ep.name || ep.alias)}</a>
          <div class="meta">${esc(notes.filter(Boolean).join(' · '))}</div>
          <div class="tags line">${ep.genres.map((g) => `<span class="tag">${esc(g)}</span>`).join('')}</div>
        </div>
        <div class="actions">
          <button data-act="play" title="Play (enter)">${ICONS.play}</button>
          <button data-act="menu" title="More">${ICONS.more}</button>
        </div>
      </article>
      ${expanded ? `<div class="subs">${stack.map(sub).join('')}</div>` : ''}
    </div>`;
}

// The rest of an expanded stack, in the order they'll play.
const sub = ({ ep }) => `
  <div class="sub" data-alias="${esc(ep.alias)}" data-ep="${esc(ep.alias)}">
    <img src="${esc(ep.thumb || ep.image)}" alt="" loading="lazy" />
    <div class="body">
      <a class="title" href="${NTS}${esc(ep.path)}" target="_blank">${esc(ep.name || ep.alias)}</a>
      <div class="meta">${esc(fmtDate(ep.date))}</div>
    </div>
    <button data-act="play" title="Play">${ICONS.play}</button>
    <button data-act="menu" title="More">${ICONS.more}</button>
  </div>`;

function renderQueue(prof) {
  const items = orderQueue(state, prof);
  rows = items.map((c) => c.alias);
  cards = new Map(items.map((c) => [c.key, c]));
  if (items.length) patch($('#list'), items.map((c) => ({ key: c.key, html: card(c) })));
  else $('#list').innerHTML = '<div class="empty">Nothing queued. New episodes show up here as NTS adds them.</div>';
  $('#foot').innerHTML = `
    <form class="add" data-form="add">
      <input name="urls" placeholder="Paste NTS episode links to add" autocomplete="off" />
      <button>Add</button>
    </form>
    <label class="setting" style="padding:0">
      <input type="checkbox" data-act="autoAdvance" ${state.settings.autoAdvance ? 'checked' : ''} />
      Play the next one when an episode ends
    </label>
    <span>Checked ${ago(state.polledAt)}</span>
    <button data-act="poll">Check now</button>
    <div class="keys">Keys: J/K move · Enter play · Shift+Enter play next · X remove · Alt+↑/↓ reorder · Space play/pause · N skip · Shift+N next track.</div>
    <div class="keys">A show's episodes stack on one card and play newest first, one per turn. After you hear one, that show waits for three others. Drag a card by its grip to reorder. To add an episode, drag or paste its link here, or right-click it on nts.live.</div>`;
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
          <div class="name">${esc(trackName(t))}</div>
          <div class="meta">${esc(ep?.name || t.alias)} · ${fmtTime(t.offset)}</div>
        </div>
        <time>${live ? 'Playing' : new Date(t.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
      </button>`;
  });
  $('#list').innerHTML = plays.length
    ? html.join('')
    : '<div class="empty">Tracks show up here as they play. Click one to jump back to it.</div>';
  $('#foot').innerHTML = `<div class="keys">Tracks come from NTS's tracklists, so episodes without one aren't listed.</div>`;
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
        : '<span class="meta">Builds up as you save, finish and queue episodes.</span>'
    }</div>`;
  $('#foot').innerHTML = `
    <span>Synced from My NTS ${ago(state.follows.syncedAt)}</span>
    <button data-act="sync">Sync now</button>
    ${state.syncError ? `<span class="error">${esc(state.syncError)}</span>` : ''}
    <div class="keys">New episodes from these hosts rank higher in your queue.</div>`;
}

// Genre chips stay on one line and scroll sideways; fade the edge while
// there's more to see.
function fadeChips(el) {
  el.classList.toggle('more', el.scrollWidth - el.scrollLeft - el.clientWidth > 1);
}

function render() {
  if (!state) return;
  const prof = buildProfile(state);
  const animate = shown === view;
  shown = view;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  const queued = state.queue.filter((q) => q.alias !== state.now?.alias).length;
  $('#count-queue').textContent = queued || '';
  const input = $('.add input');
  const typed = input?.value;
  const hadFocus = input && document.activeElement === input;
  flip(() => {
    renderNow();
    if (view === 'queue') renderQueue(prof);
    else if (view === 'tracks') renderTracks();
    else renderHosts(prof);
  }, animate);
  const again = $('.add input');
  if (again && typed) again.value = typed;
  if (again && hadFocus) again.focus();
  focus = Math.min(focus, Math.max(0, rows.length - 1));
  showFocus();
  document.querySelectorAll('.tags.line').forEach(fadeChips);
}

async function refresh() {
  state = await load();
  render();
}

// --- interaction ---------------------------------------------------------------

function setView(v) {
  view = v;
  focus = 0;
  closeMenu();
  try {
    localStorage.setItem('view', v);
  } catch {}
  render();
  $('#scroll').scrollTo(0, 0);
}

const cardEls = () => [...document.querySelectorAll('#list > .card')];

function showFocus() {
  cardEls().forEach((el, i) => el.querySelector('.row').classList.toggle('focus', i === focus));
}

function setFocus(i) {
  focus = Math.max(0, Math.min(rows.length - 1, i));
  showFocus();
  document.querySelector('.row.focus')?.scrollIntoView({ block: 'nearest' });
}

// What to slide out when an episode leaves the queue: its whole card, unless
// it's one of a stack that stays.
function shownEl(alias) {
  const el = document.querySelector(`#list [data-alias="${CSS.escape(alias)}"]`);
  return el?.matches('.row') && !el.closest('.stacked') ? el.closest('.card') : el;
}

async function act(name, el) {
  if (name === 'autoAdvance') return send({ type: 'settings', settings: { autoAdvance: !state.settings.autoAdvance } });
  if (name === 'menu') return toggleMenu(el);
  if (name === 'expand') return toggleStack(el.closest('.card').dataset.key);
  if (name === 'nextTrack') return nextTrack();
  closeMenu();
  const { alias, path, offset, key } = { ...el?.closest('[data-alias]')?.dataset, ...el?.dataset };
  if (name === 'poll') toast('Checking Latest…');
  if (name === 'sync') toast('Syncing from My NTS in a background tab…');
  let msg = alias ? { type: name, alias } : { type: name };
  let leaving = null;
  if (name === 'jump') {
    msg = { type: name, alias, path, offset: Number(offset) };
    seek = { alias, pos: msg.offset, at: Date.now() };
  } else if (name === 'toggle') {
    // Says which way, as the button showed it, so it can't flip the wrong way.
    msg = { type: name, play: !isPlaying(state?.now) };
  } else if (name === 'remove') {
    msg = { type: name, aliases: [alias] };
    leaving = shownEl(alias);
  } else if (name === 'removeStack') {
    const c = cards.get(key);
    msg = { type: 'remove', aliases: [c.alias, ...c.stack.map((s) => s.alias)] };
    leaving = shownEl(c.alias)?.closest('.card');
  } else if (name === 'skip' && state?.now?.alias) {
    leaving = $('#now');
  }
  await leave(leaving, leaving?.id === 'now' ? -40 : 40);
  return run(msg, leaving);
}

// Sends a command and reports how it went.
async function run(msg, leaving) {
  // Starting can mean loading the episode in a tab, which takes a few seconds.
  const starting = ['play', 'jump', 'skip'].includes(msg.type) || msg.play === true;
  const slow = starting && setTimeout(() => toast('Loading in your NTS tab…'), 400);
  const r = await send(msg);
  clearTimeout(slow);
  if (!r?.ok || r.value?.empty) back(leaving);
  if (r?.value?.empty) toast('Queue is empty');
  else if (r?.value?.started === false) toast("Switched to the NTS tab. Press play there if it hasn't started");
  else if (r?.ok && starting) $('#toast').hidden = true;
  return r;
}

// Jumps to the start of the next listed track in the episode playing.
function nextTrack() {
  const n = state?.now;
  const ep = n?.alias && state.eps[n.alias];
  if (!ep) return;
  if (!ep.tracks?.length) return toast('No tracklist for this episode');
  const t = trackAfter(ep, livePosition());
  if (!t) return toast("That's the last listed track");
  seek = { alias: n.alias, pos: t.offset, at: Date.now() };
  tickNow();
  return run({ type: 'jump', alias: n.alias, path: ep.path, offset: t.offset });
}

function toggleStack(key) {
  if (!open.delete(key)) open.add(key);
  render();
}

// --- menu ----------------------------------------------------------------------

const menu = $('#menu');

function toggleMenu(btn) {
  if (menu._for === btn) return closeMenu();
  closeMenu();
  const el = btn.closest('[data-alias]');
  const card = btn.closest('.card');
  const c = cards.get(card.dataset.key);
  const items = [
    ['top', 'Play next'],
    ['remove', 'Remove'],
  ];
  if (el.matches('.row') && c?.stack.length) items.push(['removeStack', `Remove all ${c.stack.length + 1}`]);
  menu.innerHTML = items.map(([a, label]) => `<button data-act="${a}">${label}</button>`).join('');
  menu.dataset.alias = el.dataset.alias;
  menu.dataset.key = card.dataset.key;
  menu._for = btn;
  btn.classList.add('on');
  menu.hidden = false;
  // Under the button, right edges lined up; above it if there's no room.
  const b = btn.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const below = b.bottom + 4 + m.height <= innerHeight - 8;
  menu.style.top = `${below ? b.bottom + 4 : b.top - 4 - m.height}px`;
  menu.style.left = `${Math.max(8, b.right - m.width)}px`;
  if (!still.matches) {
    menu.animate([{ opacity: 0, transform: `translateY(${below ? -4 : 4}px)` }, { opacity: 1, transform: 'none' }], {
      duration: 120,
      easing: 'ease-out',
    });
  }
}

function closeMenu() {
  if (menu.hidden) return;
  menu.hidden = true;
  menu._for?.classList.remove('on');
  menu._for = null;
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#menu, [data-act="menu"]')) closeMenu();
  const tab = e.target.closest('[data-view]');
  if (tab) return setView(tab.dataset.view);
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  e.preventDefault();
  act(btn.dataset.act, btn);
});

document.addEventListener(
  'scroll',
  (e) => {
    if (e.target.matches?.('.tags.line')) fadeChips(e.target);
    else closeMenu();
  },
  true,
);

// --- reordering ------------------------------------------------------------------

// Drag a card by its grip. The card follows the pointer and the others slide
// out of the way; on release it settles into place and the new order is sent
// to the background.
function startSort(e, cardEl) {
  const list = $('#list');
  const scroller = $('#scroll');
  const els = cardEls();
  const from = els.indexOf(cardEl);
  const grip = e.target.closest('.grip');
  const box = els.map((el) => ({ top: el.offsetTop, h: el.offsetHeight }));
  const startY = e.clientY;
  const startScroll = scroller.scrollTop;
  let y = startY;
  let to = from;
  let active = false;
  let frame = 0;

  const place = () => {
    // Keep the card inside the list as the pointer or the scroll position moves.
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
    cardEl.style.transform = `translateY(${top - box[from].top}px)`;
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
    closeMenu();
    document.body.classList.add('sorting');
    cardEl.classList.add('dragging');
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
    sorting = false;
    const moved = commit && to !== from;
    // Settle from wherever the drag left everything.
    flip(() => {
      els.forEach((el) => (el.style.transform = ''));
      if (moved) list.insertBefore(cardEl, to > from ? els[to].nextSibling : els[to]);
    });
    setTimeout(() => cardEl.classList.remove('dragging'), 280);
    if (moved) {
      const order = [...rows];
      order.splice(to, 0, ...order.splice(from, 1));
      reorder(order, to, from);
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
  startSort(e, e.target.closest('.card'));
});

async function reorder(order, moved, from) {
  rows = order;
  await send({ type: 'reorder', aliases: order, moved, from });
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
    const els = cardEls();
    const from = focus;
    flip(() => $('#list').insertBefore(els[from], to > from ? els[to].nextSibling : els[to]));
    setFocus(to);
    reorder(order, to, from);
    return;
  }
  if (e.altKey) return;
  const alias = rows[focus];
  const row = () => document.querySelector('.row.focus');
  const listKeys = {
    j: () => setFocus(focus + 1),
    arrowdown: () => setFocus(focus + 1),
    k: () => setFocus(focus - 1),
    arrowup: () => setFocus(focus - 1),
    enter: () => alias && view === 'queue' && act(e.shiftKey ? 'top' : 'play', row()),
    x: () => alias && view === 'queue' && act('remove', row()),
  };
  const globalKeys = {
    ' ': () => act('toggle'),
    n: () => (e.shiftKey ? nextTrack() : act('skip')),
    escape: () => closeMenu(),
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
// the now-playing card, so a click or hover on a row isn't pulled out from
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

setInterval(() => isPlaying(state?.now) && tickNow(), 1000);

refresh();
