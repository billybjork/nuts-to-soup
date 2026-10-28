// nts tui: a full-screen player. It shows what the side panel shows, from the
// same view module, and updates from the extension's state changes as they
// arrive. The only timer redraws the position while something plays.
import fs from 'node:fs';
import path from 'node:path';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { render, Box, Text, useInput, useApp, useWindowSize } from 'ink';
import htm from 'htm';
import { connect } from './client.js';
import { socketPath } from './paths.js';
import { buildProfile } from '../lib/rank.js';
import {
  ago,
  fmtDate,
  fmtTime,
  isPlaying,
  nowView,
  queueCards,
  queuedCount,
  cardInfo,
  tracksView,
  hostsView,
  trackName,
} from '../lib/view.js';

const ui = htm.bind(React.createElement);
const VIEWS = ['queue', 'tracks', 'hosts'];
const KEYS =
  'j/k move · enter play · shift+enter/t play next · x remove · alt+↑/↓ reorder · space play/pause · n skip · N next track · 1/2/3 views · q quit';

// --- pieces ------------------------------------------------------------------------

function Tabs({ view, count }) {
  const tab = (v, label) =>
    ui`<${Text} key=${v} bold=${view === v} dimColor=${view !== v} underline=${view === v}>${label}<//>`;
  return ui`<${Box} gap=${2} paddingX=${1}>
    <${Text} bold>Nuts to Soup<//>
    ${[tab('queue', `1 Queue${count ? ` ${count}` : ''}`), tab('tracks', '2 Tracks'), tab('hosts', '3 Hosts')]}
  <//>`;
}

function Now({ v, width }) {
  if (!v)
    return ui`<${Box} flexDirection="column" paddingX=${1} height=${3}>
      <${Text} dimColor>Nothing playing. Enter plays the focused card, space plays the top one.<//>
    <//>`;
  const time = `${fmtTime(v.pos)}${v.dur ? ` / ${fmtTime(v.dur)}` : ''}`;
  const bar = Math.max(0, width - 2);
  const done = v.dur ? Math.round(Math.min(1, v.pos / v.dur) * bar) : 0;
  return ui`<${Box} flexDirection="column" paddingX=${1} height=${3}>
    <${Box}>
      <${Box} flexGrow=${1} flexShrink=${1}>
        <${Text} wrap="truncate-end">
          <${Text} color=${v.playing ? 'green' : undefined}>${v.playing ? '▶ ' : '❚❚ '}<//>
          <${Text} bold>${v.ep.name || v.alias}<//>
        <//>
      <//>
      <${Text}> ${time}<//>
    <//>
    <${Text} wrap="truncate-end" dimColor=${!v.track}>
      ${v.track ? `♪ ${trackName(v.track)}` : `${v.ep.show}${v.playing ? '' : ' · paused'}`}
    <//>
    <${Text}><${Text} color="green">${'━'.repeat(done)}<//><${Text} dimColor>${'─'.repeat(bar - done)}<//><//>
  <//>`;
}

// A window onto `lines` that keeps line `at` in view.
function List({ lines, at, height, empty }) {
  const top = useRef(0);
  if (at < top.current) top.current = at;
  if (at >= top.current + height) top.current = at - height + 1;
  top.current = Math.max(0, Math.min(top.current, Math.max(0, lines.length - height)));
  if (!lines.length) return ui`<${Box} height=${height} paddingX=${1}><${Text} dimColor>${empty}<//><//>`;
  return ui`<${Box} flexDirection="column" height=${height} overflow="hidden">
    ${lines.slice(top.current, top.current + height)}
  <//>`;
}

const Row = ({ on, children }) =>
  ui`<${Text} wrap="truncate-end" inverse=${on}>${on ? '›' : ' '}${children} <//>`;

// Each view's lines, and which of them can take focus: [{key, el, alias?, row?}].
function queueLines(s, cards, focus) {
  const w = String(cards.length).length;
  return cards.map((c, i) => {
    const { notes } = cardInfo(s, c);
    const more = c.stack.length ? ui`<${Text} color="yellow"> ×${c.stack.length + 1}<//>` : '';
    return {
      key: c.key,
      focusable: true,
      el: ui`<${Row} key=${c.key} on=${i === focus}>
        <${Text} dimColor> ${String(i + 1).padStart(w)} <//>${c.ep.name || c.alias}${more}
        <${Text} dimColor>${'  '}${notes.join(' · ')}${c.ep.genres.length ? ` · ${c.ep.genres.join(', ')}` : ''}<//>
      <//>`,
    };
  });
}

function trackLines(s, focus) {
  const lines = [];
  let i = 0;
  for (const t of tracksView(s)) {
    if (t.day)
      lines.push({
        key: `d${lines.length}`,
        el: ui`<${Text} key=${`d${lines.length}`} bold> ${t.day}<//>`,
      });
    const on = i++ === focus;
    const when = t.live
      ? 'Playing'
      : new Date(t.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    lines.push({
      key: `t${i}`,
      focusable: true,
      track: t,
      el: ui`<${Row} key=${`t${i}`} on=${on}>
        <${Text} color=${t.live ? 'green' : undefined} dimColor=${!t.live}> ${when.padEnd(8)}<//
        >${trackName(t)}
        <${Text} dimColor>${'  '}${t.ep?.name || t.alias} · ${fmtTime(t.offset)}<//>
      <//>`,
    });
  }
  return lines;
}

function hostLines(s, focus) {
  const { shows, genres } = hostsView(s, buildProfile(s));
  const head = (text) => ({ key: text, el: ui`<${Text} key=${text} bold> ${text}<//>` });
  return [
    head(`Following (${shows.length})`),
    ...shows.map((h, i) => ({
      key: h.alias,
      focusable: true,
      el: ui`<${Row} key=${h.alias} on=${i === focus}>
        ${' '}${h.name}<${Text} dimColor>${'  '}${fmtDate(h.last)}<//><//
      >`,
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

// --- app ---------------------------------------------------------------------------

function App({ initial }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [client, setClient] = useState(initial);
  const [s, setS] = useState(initial.state);
  const [online, setOnline] = useState(true);
  const [view, setView] = useState('queue');
  const [focus, setFocus] = useState(0);
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

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const cards = useMemo(() => (s ? queueCards(s) : []), [s]);
  const v = s && nowView(s, seek);

  let lines = [];
  if (s && view === 'queue') lines = queueLines(s, cards, focus);
  else if (s && view === 'tracks') lines = trackLines(s, focus);
  else if (s) lines = hostLines(s, focus);
  const focusable = lines.filter((l) => l.focusable);
  const at = Math.max(0, lines.indexOf(focusable[Math.min(focus, focusable.length - 1)]));

  // Keep focus on the list as it shrinks (a card played, removed or skipped).
  useEffect(() => {
    if (focus > 0 && focus >= focusable.length) setFocus(Math.max(0, focusable.length - 1));
  }, [focus, focusable.length]);

  // Sends a command and reports how it went, as the panel does.
  async function run(msg) {
    const starting = ['play', 'jump', 'skip'].includes(msg.type) || msg.play === true;
    const slow = starting && setTimeout(() => setToast('Loading in your NTS tab…'), 400);
    try {
      const value = await client.request(msg);
      if (value?.empty) setToast('Queue is empty');
      else if (value?.started === false)
        setToast("Switched to the NTS tab. Press play there if it hasn't started");
      else if (starting) setToast(null);
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
    const n = focusable.length;
    const card = view === 'queue' && cards[focus];
    const move = (i) => setFocus(Math.max(0, Math.min(n - 1, i)));
    if (key.meta && (key.upArrow || key.downArrow))
      return view === 'queue' && reorder(focus + (key.upArrow ? -1 : 1));
    if (input === 'j' || key.downArrow) return move(focus + 1);
    if (input === 'k' || key.upArrow) return move(focus - 1);
    if (key.pageDown) return move(focus + 10);
    if (key.pageUp) return move(focus - 10);
    if (key.return && view === 'tracks') {
      const t = focusable[focus]?.track;
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
    const i = ['1', '2', '3'].indexOf(input);
    if (i >= 0) {
      setView(VIEWS[i]);
      setFocus(0);
    }
  });

  const height = Math.max(1, rows - 7);
  const empty = {
    queue: 'Nothing queued. New episodes show up here as NTS adds them.',
    tracks: 'Tracks show up here as they play. Enter jumps back to one.',
    hosts: '',
  }[view];
  return ui`<${Box} flexDirection="column" width=${columns} height=${rows}>
    <${Tabs} view=${view} count=${s ? queuedCount(s) : 0} />
    <${Text}> <//>
    <${Now} v=${v} width=${columns} />
    <${Text}> <//>
    <${List} lines=${lines.map((l) => l.el)} at=${at} height=${height} empty=${empty} />
    <${Box} paddingX=${1}>
      <${Text} wrap="truncate-end" color=${online ? undefined : 'yellow'} dimColor=${online && !toast}>
        ${online ? toast || KEYS : 'Chrome is closed. Waiting for it to start. Space starts it, q quits.'}
      <//>
    <//>
  <//>`;
}

export async function runTui() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('nts tui needs a terminal');
  const client = await connect();
  await client.subscribe();
  const app = render(ui`<${App} initial=${client} />`, {
    alternateScreen: true,
    kittyKeyboard: { mode: 'auto' },
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
}
