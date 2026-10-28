import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMessage, senderSource } from '../lib/messages.js';

const commands = [
  { type: 'play', alias: 'a' },
  { type: 'top', alias: 'a' },
  { type: 'jump', alias: 'a', path: '/shows/h/episodes/a', offset: 10 },
  { type: 'skip' },
  { type: 'toggle', play: true },
  { type: 'settings', settings: { autoAdvance: false } },
  { type: 'remove', aliases: ['a'] },
  { type: 'reorder', aliases: ['a', 'b'], moved: 1, from: 0 },
  { type: 'add', urls: ['https://www.nts.live/shows/h/episodes/a'] },
  { type: 'poll' },
  { type: 'sync' },
];
const content = [
  {
    type: 'nowPlaying',
    alias: 'a',
    path: '/shows/h/episodes/a',
    playbackId: 'x',
    startedAt: 1,
    pos: 0,
    dur: 1,
  },
  { type: 'progress', alias: 'a', playbackId: 'x', pos: 1, dur: 2, playing: true },
  { type: 'ended', alias: 'a', playbackId: 'x' },
  { type: 'scraped', kind: 'signedOut' },
  { type: 'isSyncTab' },
  { type: 'refreshStream', index: 0 },
];

test('senders map to a source', () => {
  assert.equal(senderSource({}), 'panel');
  assert.equal(senderSource({ tab: { id: 1 }, url: 'chrome-extension://abc/panel/panel.html' }), 'panel');
  assert.equal(senderSource({ tab: { id: 1 }, frameId: 0, url: 'https://www.nts.live/' }), 'content');
  assert.equal(senderSource({ tab: { id: 1 }, frameId: 3, url: 'https://www.nts.live/' }), null);
  assert.equal(senderSource({ tab: { id: 1 }, frameId: 0, url: 'https://example.com/' }), null);
});

test('the panel and native may send exactly the panel commands', () => {
  for (const source of ['panel', 'native']) {
    for (const m of commands) assert.doesNotThrow(() => validateMessage(m, source), `${source} ${m.type}`);
    for (const m of content)
      assert.throws(() => validateMessage(m, source), /NTS page/, `${source} ${m.type}`);
  }
});

test('content scripts may send only their own messages', () => {
  for (const m of content) assert.doesNotThrow(() => validateMessage(m, 'content'), m.type);
  for (const m of commands) assert.throws(() => validateMessage(m, 'content'), /extension panel/, m.type);
  for (const m of commands) assert.throws(() => validateMessage(m, null), /extension panel/, m.type);
});

test('unknown types and malformed native commands are rejected', () => {
  assert.throws(() => validateMessage({ type: 'load' }, 'native'), /Unknown/);
  assert.throws(() => validateMessage(null, 'native'), /Invalid message/);
  assert.throws(() => validateMessage({ type: 'toggle', play: 'yes' }, 'native'), /Invalid toggle/);
  assert.throws(
    () => validateMessage({ type: 'jump', alias: 'a', path: '', offset: 1 }, 'native'),
    /Invalid jump/,
  );
});
