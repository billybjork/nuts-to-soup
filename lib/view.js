// What the queue, now-playing card, Tracks and Hosts show, computed from the
// normalized store. Shared by the side panel and the terminal client so both
// order, stack and describe things the same way.

import { isDone } from './store.js';
import { trackAt } from './nts.js';
import { buildProfile, orderQueue, topGenres } from './rank.js';

export const fmtDate = (ts) =>
  ts ? new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';

export function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function ago(ts, now = Date.now()) {
  if (!ts) return 'never';
  const m = Math.round((now - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export const dayLabel = (ts) => {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 864e5);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return fmtDate(ts);
};

// "Playing" not refreshed for a minute means the tab went away mid-play.
export const isPlaying = (n, now = Date.now()) => !!n?.playing && now - n.at < 60000;

// Position now, extrapolated between the content script's 5-second saves.
// `seek` ({alias, pos, at}) is a jump the NTS tab hasn't reported back yet.
export function livePosition(s, seek, now = Date.now()) {
  const n = s.now;
  if (!n?.alias) return 0;
  const from = seek?.alias === n.alias && seek.at > n.at ? seek : n;
  const pos = (from.pos || 0) + (isPlaying(n, now) ? Math.max(0, now - from.at) / 1000 : 0);
  return n.dur > 0 ? Math.min(n.dur, pos) : pos;
}

export const trackName = (t) => [t.artist, t.title].filter(Boolean).join(' — ');

// The first listed track starting after `pos`, give or take a moment for
// tracks just jumped to.
export const trackAfter = (ep, pos) => ep?.tracks?.find((t) => t.offset > pos + 2);

// The now-playing card, or null when nothing is selected.
export function nowView(s, seek, now = Date.now()) {
  const n = s.now;
  const ep = n?.alias && s.eps[n.alias];
  if (!ep) return null;
  const pos = livePosition(s, seek, now);
  return {
    alias: n.alias,
    ep,
    playing: isPlaying(n, now),
    pos,
    dur: s.progress[n.alias]?.dur || n.dur || 0,
    track: (ep.tracks && trackAt(ep.tracks, pos)) || null,
    next: trackAfter(ep, pos) || null,
  };
}

// Cards in play order, each a show's stack fronted by the episode that plays
// next, as the background plays them.
export const queueCards = (s, prof = buildProfile(s)) => orderQueue(s, prof);

// Episodes queued, not counting the one playing.
export const queuedCount = (s) => s.queue.filter((q) => q.alias !== s.now?.alias).length;

// A card's listening progress (percent) and the notes under its title.
export function cardInfo(s, c) {
  const { ep } = c;
  const p = s.progress[ep.alias];
  const pct = p?.dur ? Math.min(100, (p.pos / p.dur) * 100) : 0;
  const notes = [fmtDate(ep.date)];
  if (pct && !isDone(p) && p.pos > 60) notes.push(`Resume ${fmtTime(p.pos)}`);
  notes.push(...(c.why || []), ep.location);
  return { pct, notes: notes.filter(Boolean) };
}

// Track history, newest first. `day` is set on the first track of each day,
// and `live` on the one playing now.
export function tracksView(s, now = Date.now()) {
  let day = '';
  return s.plays.map((t, i) => {
    const label = dayLabel(t.at);
    const row = {
      ...t,
      ep: s.eps[t.alias] || null,
      live: i === 0 && isPlaying(s.now, now) && s.now.alias === t.alias,
      day: label !== day ? label : null,
    };
    day = label;
    return row;
  });
}

// Followed shows by name, each with its newest known episode's date, and the
// genres the taste profile leans towards.
export function hostsView(s, prof = buildProfile(s)) {
  const lastEp = Object.create(null);
  for (const ep of Object.values(s.eps)) {
    if (ep.date > (lastEp[ep.show] || 0)) lastEp[ep.show] = ep.date;
  }
  return {
    shows: [...s.follows.shows]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((show) => ({ ...show, last: lastEp[show.alias] || 0 })),
    genres: topGenres(prof).map(([g]) => g),
  };
}
