import test from 'node:test';
import assert from 'node:assert/strict';
import { isDone, load } from '../lib/store.js';
import { buildProfile, orderQueue } from '../lib/rank.js';
import { parsePath, trackAt } from '../lib/nts.js';

test('completion requires meaningful listening, including short episodes', () => {
  assert.equal(isDone({ pos: 0, dur: 30 }), false);
  assert.equal(isDone({ pos: 28, dur: 30 }), true);
  assert.equal(isDone({ pos: 3550, dur: 3600 }), true);
  assert.equal(isDone({ pos: Infinity, dur: 3600 }), false);
  assert.equal(isDone(null), false);
});

test('episode parsing and track boundaries', () => {
  assert.equal(parsePath('/shows/a'), null);
  assert.equal(parsePath('/shows/a/episodes/b?x=1').alias, 'b');
  const tracks = [
    { offset: 10, duration: 5 },
    { offset: 20, duration: 0 },
  ];
  assert.equal(trackAt(tracks, 9), null);
  assert.equal(trackAt(tracks, 15), null);
  assert.equal(trackAt(tracks, 25), tracks[1]);
});

test('ranking groups shows, separates guests, excludes current and honors placement', async () => {
  globalThis.chrome = { storage: { local: { get: async () => ({}) } } };
  const s = await load();
  for (const [alias, show, date] of [
    ['a', 'host', 1],
    ['b', 'host', 2],
    ['c', 'guests', 3],
    ['d', 'guests', 4],
  ]) {
    s.eps[alias] = { alias, show, date, genres: ['constructor'], moods: [] };
    s.queue.push({ alias });
  }
  s.queue[0].rank = 0;
  const profile = buildProfile(s);
  assert.equal(Number.isFinite(profile.genre.constructor), true);
  const cards = orderQueue(s, profile, 5);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].alias, 'a');
  assert.equal(cards[0].stack[0].alias, 'b');
  s.now = { alias: 'a' };
  assert.equal(
    orderQueue(s, profile, 5).some((c) => c.alias === 'a'),
    false,
  );
});

test('malformed and legacy storage does not poison ranking', async () => {
  const { normalize } = await import('../lib/store.js');
  const s = normalize({
    queue: [{ alias: 'a', rank: Infinity }, { alias: 'a' }, null],
    eps: { a: { path: '/shows/h/episodes/a', genres: null, moods: 'bad', date: 'invalid', intensity: NaN } },
    follows: { shows: null },
    settings: { autoAdvance: 'false' },
    saved: false,
    'p:a': { pos: NaN, dur: Infinity },
    now: { alias: 'a', pos: -1 },
  });
  assert.equal(s.queue.length, 1);
  assert.equal(s.queue[0].rank, undefined);
  assert.equal(s.settings.autoAdvance, true);
  assert.equal(s.progress.a.pos, 0);
  s.now = null;
  assert.equal(Number.isFinite(orderQueue(s, buildProfile(s))[0].score), true);
});
