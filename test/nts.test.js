import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchEpisode, fetchTracks, fromSearch, parsePath } from '../lib/nts.js';

test('search metadata deduplicates tags and tolerates missing optional fields', () => {
  const ep = fromSearch({
    article: { path: '/shows/h/episodes/a' },
    genres: [{ name: 'Jazz' }, { value: ' jazz ' }, null],
    moods: null,
  });
  assert.deepEqual(ep.genres, ['jazz']);
  assert.equal(ep.date, 0);
  assert.equal(fromSearch(null), null);
  assert.equal(parsePath('/shows/h/episodes/../private'), null);
});

test('detail rejects wrong episode and HTTP errors without caching them', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ episode_alias: 'other', show_alias: 'h' }),
  }));
  await assert.rejects(fetchEpisode('/shows/h/episodes/a'), /different episode/);
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(fetchEpisode('/shows/h/episodes/a'), /503/);
});

test('tracklists reject invalid offsets and retain zero offsets', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return {
      ok: true,
      json: async () => ({
        results: [
          null,
          { title: 'Second', offset: 30, duration: -2 },
          { title: 'First', offset: 0, offset_estimate: 10, duration: 30 },
          { title: 'Bad', offset: -1 },
          { title: 'Bad', offset: '12' },
        ],
      }),
    };
  });
  const tracks = await fetchTracks('/shows/h/episodes/a');
  assert.deepEqual(
    tracks.map((t) => [t.title, t.offset, t.duration]),
    [
      ['First', 0, 30],
      ['Second', 30, 0],
    ],
  );
});
