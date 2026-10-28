// Ranking and sequencing. Deliberately simple and explainable: every score
// comes with the reasons that produced it.

import { GUESTS } from './nts.js';

const DAY = 864e5;

// How much each kind of signal says about taste. One episode counts once,
// at its strongest signal (a saved episode you also finished counts as saved).
const SIGNALS = { saved: 3, done: 2, history: 1, queued: 0.5, dismissed: -0.4 };

export function buildProfile(s) {
  const signal = new Map();
  const note = (alias, kind) => {
    const prev = signal.get(alias);
    const w = SIGNALS[kind];
    if (!prev || (w > 0 && w > SIGNALS[prev])) signal.set(alias, kind);
  };
  s.saved.forEach((a) => note(a, 'saved'));
  Object.keys(s.done).forEach((a) => note(a, 'done'));
  s.history.forEach((a) => note(a, 'history'));
  s.queue.forEach((q) => note(q.alias, 'queued'));
  Object.keys(s.dismissed).forEach((a) => note(a, 'dismissed'));

  const genre = Object.create(null);
  const mood = Object.create(null);
  const show = Object.create(null);
  const counts = Object.create(null); // show -> {saved, done}
  const add = (m, k, w) => (m[k] = (m[k] || 0) + w);

  for (const [alias, kind] of signal) {
    const ep = s.eps[alias];
    if (!ep) continue;
    const w = SIGNALS[kind];
    ep.genres.forEach((g) => add(genre, g, w));
    ep.moods.forEach((m) => add(mood, m, w));
    if (ep.show === GUESTS) continue;
    add(show, ep.show, w / 2);
    if (kind === 'saved' || kind === 'done') {
      counts[ep.show] ??= { saved: 0, done: 0 };
      counts[ep.show][kind]++;
    }
  }

  const follows = new Set(s.follows.shows.map((f) => f.alias));
  for (const k of Object.keys(show)) show[k] = Math.max(-1.5, Math.min(3, show[k]));
  for (const a of follows) show[a] = (show[a] || 0) + 3;

  return { genre: normalize(genre), mood: normalize(mood), show, counts, follows };
}

// Scale so the strongest positive tag is 1.
function normalize(m) {
  const max = Math.max(0, ...Object.values(m));
  if (!max) return m;
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v / max]));
}

// Sum of tag weights, damped so episodes with many tags don't win by volume.
function fit(tagsOf, weights) {
  if (!tagsOf?.length) return 0;
  return tagsOf.reduce((a, t) => a + (weights[t] || 0), 0) / Math.sqrt(tagsOf.length);
}

export function score(ep, prof, now = Date.now()) {
  const why = [];
  const c = prof.counts[ep.show];
  if (c?.saved) why.push(`${c.saved} saved`);
  else if (c?.done) why.push(`${c.done} finished`);

  const genreFit = fit(ep.genres, prof.genre);
  const ageDays = Math.max(0, (now - ep.date) / DAY);
  const value =
    (prof.show[ep.show] || 0) + 2 * genreFit + 0.5 * fit(ep.moods, prof.mood) + Math.exp(-ageDays / 10);

  return { score: value, why };
}

const jaccard = (a, b) => {
  if (!a?.length || !b?.length) return 0;
  const B = new Set(b);
  const shared = a.filter((x) => B.has(x)).length;
  return shared / (a.length + b.length - shared);
};

// How well b follows a: shared genres, moods and tracklist artists, and a
// similar energy level.
export function similarity(a, b) {
  let s = jaccard(a.genres, b.genres) + 0.5 * jaccard(a.moods, b.moods) + 0.5 * jaccard(a.artists, b.artists);
  if (a.intensity != null && b.intensity != null) s -= Math.abs(a.intensity - b.intensity) / 100;
  return s;
}

// Episodes from one show share a card in the queue. Guests' episodes are each
// their own.
export const stackKey = (ep) => (ep.show && ep.show !== GUESTS ? `show:${ep.show}` : `ep:${ep.alias}`);

// A show you've heard in the last this-many episodes (the one playing
// included) waits until that many others have had a turn.
const COOLDOWN = 3;

// Cards in play order. Each is its front episode, with the rest of its show's
// stack in `stack`: the one placed by hand or partly played comes first, then
// newest to oldest.
//
// Order: anything you've placed by hand (dragged), then partly played (most
// recent first), then a greedy chain where each pick balances its own score
// against how well it follows the previous one, which loosely groups genres.
// Cooling-down shows sit out the first few places. Each chained card notes in
// `after` what it followed. The chain starts from `s.chainFrom` (set on a
// reorder so what's below a drop keeps its order), else from nothing, so
// placing a card doesn't reshuffle everything after it.
export function orderQueue(s, prof, now = Date.now()) {
  const startedAt = (a) => ((s.progress[a]?.pos || 0) > 60 ? s.progress[a].at || 0 : 0);
  const stacks = new Map();
  for (const q of s.queue) {
    const ep = s.eps[q.alias];
    if (!ep || q.alias === s.now?.alias) continue;
    const key = stackKey(ep);
    if (!stacks.has(key)) stacks.set(key, []);
    stacks.get(key).push({ ...q, ep, ...score(ep, prof, now) });
  }
  const cards = [...stacks].map(([key, eps]) => {
    eps.sort(
      (a, b) =>
        (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
        startedAt(b.alias) - startedAt(a.alias) ||
        b.ep.date - a.ep.date,
    );
    return { ...eps[0], key, stack: eps.slice(1) };
  });

  // How many places each recently heard show still has to wait.
  const heard = [s.now?.alias, ...Object.keys(s.progress).sort((a, b) => s.progress[b].at - s.progress[a].at)]
    .filter((a, i, all) => a && all.indexOf(a) === i)
    .slice(0, COOLDOWN);
  const wait = new Map();
  heard.forEach(
    (a, i) => s.eps[a] && !wait.has(stackKey(s.eps[a])) && wait.set(stackKey(s.eps[a]), COOLDOWN - i),
  );
  const waits = (c, at) => (wait.get(c.key) || 0) > at;

  const placed = cards.filter((c) => c.rank != null).sort((a, b) => a.rank - b.rank);
  const started = cards
    .filter((c) => c.rank == null && startedAt(c.alias) && !waits(c, 0))
    .sort((a, b) => startedAt(b.alias) - startedAt(a.alias));
  let rest = cards.filter((c) => !placed.includes(c) && !started.includes(c));

  const out = [...placed, ...started];
  const max = Math.max(1, ...cards.map((c) => c.score)); // over all cards, so pinning one doesn't shift the rest
  let prev = s.chainFrom && out.find((c) => c.alias === s.chainFrom);
  while (rest.length) {
    const ready = rest.filter((c) => !waits(c, out.length));
    let best;
    let bestValue = -Infinity;
    for (const c of ready.length ? ready : rest) {
      const v = c.score / max + (prev ? 1.2 * similarity(prev.ep, c.ep) : 0);
      if (v > bestValue) [best, bestValue] = [c, v];
    }
    best.after = prev?.alias || null;
    out.push(best);
    rest = rest.filter((c) => c !== best);
    prev = best;
  }
  return out;
}

export function topGenres(prof, n = 12) {
  return Object.entries(prof.genre)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}
