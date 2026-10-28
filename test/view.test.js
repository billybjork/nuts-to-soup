import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../lib/store.js';
import { buildProfile, orderQueue } from '../lib/rank.js';
import {
  fmtTime,
  ago,
  isPlaying,
  livePosition,
  nowView,
  queueCards,
  queuedCount,
  cardInfo,
  tracksView,
  hostsView,
} from '../lib/view.js';

const T = 1_700_000_000_000;
const ep = (alias, show, extra = {}) => ({
  path: `/shows/${show}/episodes/${alias}`,
  show,
  name: alias.toUpperCase(),
  date: T - 864e5,
  genres: ['dub'],
  moods: [],
  ...extra,
});
const tracks = [
  { artist: 'A', title: 'One', offset: 0, duration: 100 },
  { artist: '', title: 'Two', offset: 100, duration: 100 },
  { artist: 'C', title: 'Three', offset: 200, duration: 100 },
];

function state(extra = {}) {
  return normalize({
    eps: {
      a: ep('a', 'h', { tracks }),
      b: ep('b', 'h', { date: T }),
      c: ep('c', 'other', { location: 'London' }),
      d: ep('d', 'guests'),
    },
    queue: [{ alias: 'a' }, { alias: 'b' }, { alias: 'c' }, { alias: 'd' }],
    follows: {
      shows: [
        { alias: 'other', name: 'Zed' },
        { alias: 'h', name: 'Aye' },
      ],
    },
    ...extra,
  });
}

test('times format like the panel', () => {
  assert.equal(fmtTime(5), '0:05');
  assert.equal(fmtTime(3725), '1:02:05');
  assert.equal(fmtTime(-3), '0:00');
  assert.equal(ago(0), 'never');
  assert.equal(ago(T - 5 * 60000, T), '5 min ago');
  assert.equal(ago(T - 3 * 864e5, T), '3d ago');
});

test('playing goes stale after a minute without reports', () => {
  assert.equal(isPlaying({ playing: true, at: T - 59_000 }, T), true);
  assert.equal(isPlaying({ playing: true, at: T - 61_000 }, T), false);
  assert.equal(isPlaying(null, T), false);
});

test('position extrapolates while playing, prefers a newer seek, and stops at the end', () => {
  const s = state({ now: { alias: 'a', playing: true, pos: 50, dur: 300, at: T - 10_000 } });
  assert.equal(livePosition(s, null, T), 60);
  assert.equal(livePosition(s, { alias: 'a', pos: 200, at: T - 1000 }, T), 201);
  assert.equal(livePosition(s, { alias: 'b', pos: 200, at: T - 1000 }, T), 60);
  s.now.pos = 299;
  assert.equal(livePosition(s, null, T), 300);
  s.now.playing = false;
  s.now.pos = 50;
  assert.equal(livePosition(s, null, T), 50);
});

test('now view names the current and next tracks', () => {
  const s = state({ now: { alias: 'a', playing: true, pos: 150, dur: 300, at: T } });
  const v = nowView(s, null, T);
  assert.equal(v.ep.alias, 'a');
  assert.equal(v.playing, true);
  assert.equal(v.dur, 300);
  assert.equal(v.track.title, 'Two');
  assert.equal(v.next.title, 'Three');
  s.now.pos = 250;
  assert.equal(nowView(s, null, T).next, null);
  assert.equal(nowView(state(), null, T), null);
});

test('queue cards match the ranked order, stacked by show, without the current episode', () => {
  const s = state({ now: { alias: 'c', pos: 0, at: T } });
  const cards = queueCards(s);
  assert.deepEqual(
    cards.map((c) => c.alias),
    orderQueue(s, buildProfile(s)).map((c) => c.alias),
  );
  const h = cards.find((c) => c.key === 'show:h');
  assert.equal(h.alias, 'b'); // newest first
  assert.deepEqual(
    h.stack.map((x) => x.alias),
    ['a'],
  );
  assert.equal(
    cards.some((c) => c.alias === 'c'),
    false,
  );
  assert.equal(queuedCount(s), 3);
});

test('card notes show a resume point only for partly played episodes', () => {
  const s = state({ 'p:c': { pos: 125, dur: 3600, at: T } });
  const c = queueCards(s).find((x) => x.alias === 'c');
  const info = cardInfo(s, c);
  assert.equal(Math.round(info.pct), 3);
  assert.ok(info.notes.includes('Resume 2:05'));
  assert.ok(info.notes.includes('London'));
  s.progress.c.pos = 3590;
  assert.equal(
    cardInfo(s, c).notes.some((n) => n.startsWith('Resume')),
    false,
  );
});

test('tracks are grouped by day and the newest is live while its episode plays', () => {
  const now = Date.now();
  const s = state({
    now: { alias: 'a', playing: true, pos: 10, at: now },
    plays: [
      { alias: 'a', offset: 0, title: 'One', at: now },
      { alias: 'a', offset: 0, title: 'Old', at: now - 1000 },
      { alias: 'b', offset: 0, title: 'Older', at: now - 3 * 864e5 },
    ],
  });
  const rows = tracksView(s, now);
  assert.deepEqual(
    rows.map((r) => [r.day, r.live]),
    [
      ['Today', true],
      [null, false],
      [rows[2].day, false],
    ],
  );
  assert.ok(rows[2].day);
  assert.equal(rows[0].ep.alias, 'a');
});

test('hosts are sorted by name with their newest episode date', () => {
  const s = state();
  const { shows, genres } = hostsView(s);
  assert.deepEqual(
    shows.map((x) => [x.name, x.last]),
    [
      ['Aye', T],
      ['Zed', T - 864e5],
    ],
  );
  assert.deepEqual(genres, ['dub']);
});
