// nts tui: a full-screen player. It shows what the side panel shows, from the
// same view module, and updates from the extension's state changes as they
// arrive. The only timer redraws the position while something plays. In a
// terminal with kitty graphics it shows covers, a small turntable and a
// timeline (views.js); elsewhere, the same views in text.
import fs from 'node:fs';
import path from 'node:path';
import React, { useState, useEffect, useMemo } from 'react';
import { render, Box, Text, useInput, useApp, useWindowSize } from 'ink';
import htm from 'htm';
import { connect } from './client.js';
import { socketPath } from './paths.js';
import { buildProfile } from '../lib/rank.js';
import { ago, fmtDate, isPlaying, nowView, queueCards, queuedCount, hostsView } from '../lib/view.js';
import { detect, Gfx, GfxProvider, useGfx } from './graphics.js';
import {
  Tabs,
  Now,
  List,
  queueItems,
  trackItems,
  QueuePreview,
  TrackPreview,
  HostGrid,
  hostGrid,
  previewWidth,
  HEADER_ROWS,
} from './views.js';

const ui = htm.bind(React.createElement);
const VIEWS = { 1: 'queue', 2: 'tracks', 3: 'hosts' };
const KEYS =
  'j/k move · enter play · shift+enter/t play next · x remove · alt+↑/↓ reorder · space play/pause · n skip · N next track · 1/2/3 views · q quit';
const ART_KEYS = `${KEYS.replace(' · q quit', '')} · d density · q quit`;

// Hosts without graphics: the list the TUI always had.
function hostLines(s, focus) {
  const { shows, genres } = hostsView(s, buildProfile(s));
  const head = (text) => ({ key: text, el: ui`<${Text} key=${text} bold> ${text}<//>` });
  return [
    head(`Following (${shows.length})`),
    ...shows.map((h, i) => ({
      key: h.alias,
      focusable: true,
      el: ui`<${Text} key=${h.alias} wrap="truncate-end" inverse=${i === focus}>
        ${i === focus ? '›' : ' '} ${h.name}<${Text} dimColor>${'  '}${fmtDate(h.last)}<//>
      <//>`,
    })),
    head('Your sound'),
    {
      key: 'genres',
      el: ui`<${Text} key="genres" wrap="truncate-end" dimColor>
        ${' '}${genres.join(' · ') || 'Builds up as you save, finish and queue episodes.'}
      <//>`,
    },
    {
      key: 'synced',
      el: ui`<${Text} key="synced" dimColor>
        ${' '}Synced from My NTS ${ago(s.follows.syncedAt)}${s.syncError ? ` · ${s.syncError}` : ''}
      <//>`,
    },
  ];
}

function App({ initial }) {
  const { exit } = useApp();
  const gfx = useGfx();
  const { columns, rows } = useWindowSize();
  const [client, setClient] = useState(initial);
  const [s, setS] = useState(initial.state);
  const [online, setOnline] = useState(true);
  const [view, setView] = useState('queue');
  const [focus, setFocus] = useState(0);
  const [dense, setDense] = useState(false);
  const [toast, setToast] = useState(null);
  const [seek, setSeek] = useState(null); // a jump the NTS tab hasn't reported back yet
  const [, setTick] = useState(0);

  // State from the extension, as it changes.
  useEffect(() => {
    const onState = (next) => setS(next);
    const onClose = () => setOnline(false);
    client.on('state', onState);
    client.on('close', onClose);
    return () => {
      client.off('state', onState);
      client.off('close', onClose);
    };
  }, [client]);
  useEffect(() => () => client.close(), [client]);

  // Chrome quit: pick up again when the host's socket comes back.
  useEffect(() => {
    if (online) return;
    let trying = false;
    let watcher;
    const retry = async () => {
      if (trying) return;
      trying = true;
      try {
        const c = await connect({ launch: false });
        setS(await c.subscribe());
        setClient(c);
        setOnline(true);
      } catch {}
      trying = false;
    };
    try {
      watcher = fs.watch(path.dirname(socketPath()), retry);
    } catch {}
    return () => watcher?.close();
  }, [online]);

  // Redraw the position each second while playing.
  const playing = isPlaying(s?.now);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [playing]);

  // Images no view has shown for a few renders are freed.
  useEffect(() => gfx?.sweep());

  // Messages clear after a few seconds, except the one asking you to press
  // play in the NTS tab, which stays until something plays.
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!toast || waiting) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast, waiting]);
  useEffect(() => {
    if (!waiting || !playing) return;
    setWaiting(false);
    setToast(null);
  }, [waiting, playing]);

  const cards = useMemo(() => (s ? queueCards(s) : []), [s]);
  const v = s && nowView(s, seek);

  // Layout: tabs, a gap, the header, a gap, the view, the keys.
  const header = gfx ? HEADER_ROWS : 3;
  const height = Math.max(1, rows - header - 4);
  const pw = previewWidth(columns);
  const grid = gfx && view === 'hosts' ? hostGrid(gfx, columns, height) : null;

  let items = [];
  let focusable = [];
  let tracks = [];
  if (s && view === 'queue') {
    items = queueItems({ gfx, s, cards, focus, dense });
    focusable = items;
  } else if (s && view === 'tracks') {
    const t = trackItems({ gfx, s, focus });
    items = t.items;
    tracks = t.focusable;
    focusable = tracks;
  } else if (s && view === 'hosts') {
    if (grid) focusable = hostsView(s, buildProfile(s)).shows;
    else {
      items = hostLines(s, focus);
      focusable = items.filter((l) => l.focusable);
    }
  }
  const n = focusable.length;
  const at =
    view === 'tracks'
      ? (tracks[Math.min(focus, n - 1)]?.index ?? 0)
      : view === 'hosts' && !grid
        ? Math.max(0, items.indexOf(focusable[Math.min(focus, n - 1)]))
        : Math.min(focus, Math.max(0, n - 1));

  // Keep focus on the list as it shrinks (a card played, removed or skipped).
  useEffect(() => {
    if (focus > 0 && focus >= n) setFocus(Math.max(0, n - 1));
  }, [focus, n]);

  // Sends a command and reports how it went, as the panel does.
  async function run(msg) {
    const starting = ['play', 'jump', 'skip'].includes(msg.type) || msg.play === true;
    const slow = starting && setTimeout(() => setToast('Loading in your NTS tab…'), 400);
    setWaiting(false);
    try {
      const value = await client.request(msg);
      if (value?.empty) setToast('Queue is empty');
      else if (value?.started === false) {
        setToast("Switched to the NTS tab. Press play there if it hasn't started");
        setWaiting(true);
      } else if (starting) setToast(null);
      return value;
    } catch (error) {
      setSeek(null);
      setToast(error.message);
    } finally {
      clearTimeout(slow);
    }
  }

  function nextTrack() {
    if (!v) return;
    if (!v.ep.tracks?.length) return setToast('No tracklist for this episode');
    if (!v.next) return setToast("That's the last listed track");
    setSeek({ alias: v.alias, pos: v.next.offset, at: Date.now() });
    run({ type: 'jump', alias: v.alias, path: v.ep.path, offset: v.next.offset });
  }

  function reorder(to) {
    if (to < 0 || to >= cards.length) return;
    const order = cards.map((c) => c.alias);
    order.splice(to, 0, ...order.splice(focus, 1));
    run({ type: 'reorder', aliases: order, moved: to, from: focus });
    setFocus(to);
  }

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) return exit();
    if (!online) {
      if (input === ' ')
        connect().then(
          () => setToast('Starting Chrome…'),
          (error) => setToast(error.message),
        );
      return;
    }
    if (!s) return;
    const card = view === 'queue' && cards[focus];
    const move = (i) => setFocus(Math.max(0, Math.min(n - 1, i)));
    const row = grid ? grid.per : 1;
    if (key.meta && (key.upArrow || key.downArrow))
      return view === 'queue' && reorder(focus + (key.upArrow ? -1 : 1));
    if (input === 'j' || key.downArrow) return move(focus + row);
    if (input === 'k' || key.upArrow) return move(focus - row);
    if (grid && (input === 'l' || key.rightArrow)) return move(focus + 1);
    if (grid && (input === 'h' || key.leftArrow)) return move(focus - 1);
    if (key.pageDown) return move(focus + 10);
    if (key.pageUp) return move(focus - 10);
    if (key.return && view === 'tracks') {
      const t = tracks[focus]?.track;
      if (!t) return;
      setSeek({ alias: t.alias, pos: t.offset, at: Date.now() });
      return run({ type: 'jump', alias: t.alias, path: t.path, offset: t.offset });
    }
    if ((key.return && key.shift) || input === 't') return card && run({ type: 'top', alias: card.alias });
    if (key.return) return card && run({ type: 'play', alias: card.alias });
    if (input === 'x') return card && run({ type: 'remove', aliases: [card.alias] });
    if (input === ' ') return run({ type: 'toggle', play: !isPlaying(s.now) });
    if (input === 'N') return nextTrack();
    if (input === 'n') return run({ type: 'skip' });
    if (input === 'd' && gfx) return setDense((d) => !d);
    if (VIEWS[input]) {
      setView(VIEWS[input]);
      setFocus(0);
    }
  });

  const empty = {
    queue: 'Nothing queued. New episodes show up here as NTS adds them.',
    tracks: 'Tracks show up here as they play. Enter jumps back to one.',
    hosts: '',
  }[view];
  let body;
  if (!s) body = ui`<${Box} height=${height} />`;
  else if (grid)
    body = ui`<${HostGrid} gfx=${gfx} s=${s} focus=${focus} columns=${columns} height=${height} />`;
  else {
    const side =
      pw > 0 &&
      view === 'queue' &&
      ui`<${QueuePreview} gfx=${gfx} s=${s} card=${cards[at]} width=${pw - 2} height=${height} />`;
    const sideT =
      pw > 0 &&
      view === 'tracks' &&
      ui`<${TrackPreview} gfx=${gfx} s=${s} track=${tracks[focus]?.track} width=${pw - 2} height=${height} />`;
    body = ui`<${Box} height=${height}>
      <${List} key=${view + dense} items=${items} at=${at} height=${height} empty=${empty} />
      ${side || sideT}
    <//>`;
  }
  return ui`<${Box} flexDirection="column" width=${columns} height=${rows}>
    <${Tabs} view=${view} count=${s ? queuedCount(s) : 0} />
    <${Text}> <//>
    <${Now} gfx=${gfx} s=${s} v=${v} width=${columns} />
    <${Text}> <//>
    ${body}
    <${Box} paddingX=${1}>
      <${Text} wrap="truncate-end" color=${online ? undefined : 'yellow'} dimColor=${online && !toast}>
        ${online ? toast || (gfx ? ART_KEYS : KEYS) : 'Chrome is closed. Waiting for it to start. Space starts it, q quits.'}
      <//>
    <//>
  <//>`;
}

export async function runTui() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('nts tui needs a terminal');
  const cells = await detect();
  const client = await connect();
  await client.subscribe();
  let gfx = null;
  if (cells) {
    gfx = new Gfx({ ...cells, write: null });
    gfx.write = gfx.hook(process.stdout);
  }
  const app = render(ui`<${GfxProvider} gfx=${gfx}><${App} initial=${client} /><//>`, {
    alternateScreen: true,
    kittyKeyboard: { mode: 'auto' },
    exitOnCtrlC: false,
  });
  try {
    await app.waitUntilExit();
  } finally {
    gfx?.dispose();
  }
}
