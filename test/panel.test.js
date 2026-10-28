import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { normalize, isDone } from '../lib/store.js';
import { NTS, trackAt } from '../lib/nts.js';
import { buildProfile, orderQueue, topGenres } from '../lib/rank.js';
const html = readFileSync(new URL('../panel/panel.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../panel/panel.js', import.meta.url), 'utf8').replace(
  /^import .*;\n/gm,
  '',
);
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
async function panel(t, sendMessage) {
  const dom = new JSDOM(html, {
    url: 'https://extension.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  const data = normalize({
    eps: {
      a: {
        path: '/shows/h/episodes/a',
        show: 'h',
        name: '<script>unsafe</script>',
        date: 1,
        genres: [],
        moods: [],
      },
    },
    queue: [{ alias: 'a' }],
  });
  Object.assign(w, {
    load: async () => structuredClone(data),
    isDone,
    NTS,
    trackAt,
    buildProfile,
    orderQueue,
    topGenres,
    matchMedia: () => ({ matches: true }),
    CSS: { escape: (value) => value },
    chrome: { runtime: { sendMessage }, storage: { onChanged: { addListener() {} } } },
  });
  w.HTMLElement.prototype.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval(source);
  await flush();
  return w;
}

test('panel renders metadata as text and preserves input selection on rerender', async (t) => {
  const w = await panel(t, async () => ({ ok: true }));
  assert.equal(w.document.querySelector('.title').textContent, '<script>unsafe</script>');
  assert.equal(w.document.querySelector('#list script'), null);
  const input = w.document.querySelector('.add input');
  input.value = 'a link in progress';
  input.focus();
  input.setSelectionRange(2, 5);
  // Expand renders the queue again using the same path as storage changes.
  w.eval('render()');
  const replacement = w.document.querySelector('.add input');
  assert.equal(replacement.value, 'a link in progress');
  assert.equal(replacement.selectionStart, 2);
  assert.equal(replacement.selectionEnd, 5);
});

test('keyboard Enter on a focused button does not also play the queue selection', async (t) => {
  const sent = [];
  const w = await panel(t, async (msg) => {
    sent.push(msg);
    return { ok: true };
  });
  const button = w.document.querySelector('[data-view="tracks"]');
  button.focus();
  button.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  assert.equal(sent.length, 0);
});

test('disconnected worker produces a visible error instead of an unhandled rejection', async (t) => {
  const w = await panel(t, async () => {
    throw new Error('Disconnected');
  });
  w.document.querySelector('[data-act="poll"]').click();
  await flush();
  assert.match(w.document.querySelector('#toast').textContent, /Disconnected/);
});
