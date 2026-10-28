#!/usr/bin/env node
// nts: control Nuts to Soup from the terminal. Rex actions and scripts run
// this for every command, so it stays free of Ink and React; `nts tui` loads
// those.
import { connect } from './client.js';
import { NTS, parsePath } from '../lib/nts.js';
import { fmtDate, fmtTime, isPlaying, nowView, queueCards, trackName } from '../lib/view.js';

const USAGE = `Usage: nts <command>

  status [--json]          what's playing, where, and the current track
  toggle                   play or pause
  play                     play (resume)
  play <n | alias | url>   play queue card n, an episode, or an NTS link
  pause                    pause
  skip                     next episode
  next                     next track in this episode
  queue [-n N] [--json]    the queue, in play order (default 20)
  add <url>...             add NTS episode links to the queue
  sync                     sync follows, saved and history from My NTS
  tui, player              the full-screen player`;

class UsageError extends Error {}

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
const has = (f) => rest.includes(f);
const positional = rest.filter((a, i) => !a.startsWith('-') && rest[i - 1] !== '-n');

// What to say after a command that starts playback, as the panel says it.
function started(value, ok) {
  if (value?.empty) return 'Queue is empty';
  if (value?.started === false) return "Switched to the NTS tab. Press play there if it hasn't started";
  return ok;
}

function status(s) {
  const v = nowView(s);
  if (!v) return { text: 'Nothing playing', json: null };
  const { ep } = v;
  const track = (t) => t && { artist: t.artist, title: t.title, offset: t.offset };
  const json = {
    alias: v.alias,
    name: ep.name || ep.alias,
    show: ep.show,
    url: NTS + ep.path,
    playing: v.playing,
    pos: Math.floor(v.pos),
    dur: v.dur,
    track: track(v.track),
    next: track(v.next),
  };
  const lines = [
    `${v.playing ? '▶ Playing' : '❚❚ Paused'} · ${fmtTime(v.pos)}${v.dur ? ` / ${fmtTime(v.dur)}` : ''}`,
    json.name,
    `${ep.show} · ${json.url}`,
  ];
  if (v.track) lines.push(`♪ ${trackName(v.track)}`);
  return { text: lines.join('\n'), json };
}

function queue(s) {
  const n = has('-n') ? Number(rest[rest.indexOf('-n') + 1]) : 20;
  if (!Number.isInteger(n) || n < 0) throw new UsageError('-n takes a number');
  const cards = queueCards(s).slice(0, n || Infinity);
  if (has('--json'))
    return JSON.stringify(
      cards.map((c, i) => ({
        n: i + 1,
        alias: c.alias,
        name: c.ep.name || c.alias,
        show: c.ep.show,
        date: c.ep.date,
        url: NTS + c.ep.path,
        stack: c.stack.map((x) => x.alias),
      })),
      null,
      2,
    );
  if (!cards.length) return 'Nothing queued';
  const w = String(cards.length).length;
  return cards
    .map((c, i) => {
      const more = c.stack.length ? ` (+${c.stack.length})` : '';
      return `${String(i + 1).padStart(w)}. ${c.ep.name || c.alias}${more} · ${fmtDate(c.ep.date)}`;
    })
    .join('\n');
}

// Play queue card n, an alias, or an NTS episode link (added first if new).
async function playTarget(client, s, target) {
  let alias;
  if (/^\d+$/.test(target)) {
    const card = queueCards(s)[Number(target) - 1];
    if (!card) throw new Error(`There's no card ${target} in the queue`);
    alias = card.alias;
  } else if (/nts\.live|^\/shows\//.test(target)) {
    const p = parsePath(target.replace(/^https?:\/\/(www\.)?nts\.live/, ''));
    if (!p) throw new Error('Not an NTS episode link');
    alias = p.alias;
    if (!s.eps[alias]?.path) await client.request({ type: 'add', urls: [NTS + p.path] });
  } else {
    alias = target;
    if (!s.eps[alias]) throw new Error(`Unknown episode: ${alias}`);
  }
  const name = s.eps[alias]?.name || alias;
  return started(await client.request({ type: 'play', alias }), `Playing ${name}`);
}

async function run() {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return USAGE;
  if (cmd === 'tui' || cmd === 'player') {
    const { runTui } = await import('./app.js');
    return runTui();
  }
  const simple = { skip: 'skip', sync: 'sync' };
  const needsState = ['status', 'toggle', 'play', 'pause', 'next', 'queue'];
  if (!simple[cmd] && !needsState.includes(cmd) && cmd !== 'add')
    throw new UsageError(`Unknown command: ${cmd}`);

  const client = await connect();
  try {
    if (cmd === 'add') {
      if (!positional.length) throw new UsageError('nts add <url>...');
      const { added, failed } = await client.request({ type: 'add', urls: positional });
      return `Added ${added} to the queue${failed ? ` · ${failed} couldn't be loaded` : ''}`;
    }
    if (cmd === 'skip') return started(await client.request({ type: 'skip' }), 'Skipped');
    if (cmd === 'sync') {
      await client.request({ type: 'sync' });
      return 'Syncing from My NTS in a background tab';
    }

    const s = await client.subscribe();
    if (cmd === 'status') {
      const { text, json } = status(s);
      return has('--json') ? JSON.stringify(json, null, 2) : text;
    }
    if (cmd === 'queue') return queue(s);
    if (cmd === 'next') {
      const v = nowView(s);
      if (!v) throw new Error('Nothing playing');
      if (!v.ep.tracks?.length) throw new Error('No tracklist for this episode');
      if (!v.next) throw new Error("That's the last listed track");
      await client.request({ type: 'jump', alias: v.alias, path: v.ep.path, offset: v.next.offset });
      return `♪ ${trackName(v.next)}`;
    }
    if (cmd === 'play' && positional.length) return await playTarget(client, s, positional[0]);
    // toggle, play, pause: say which way, so a stale state can't flip it the wrong way.
    const play = cmd === 'toggle' ? !isPlaying(s.now) : cmd === 'play';
    const value = await client.request({ type: 'toggle', play });
    return play ? started(value, 'Playing') : 'Paused';
  } finally {
    client.close();
  }
}

run().then(
  (out) => {
    if (out) console.log(out);
    process.exit(0);
  },
  (error) => {
    console.error(`nts: ${error.message}`);
    if (error instanceof UsageError) console.error(`\n${USAGE}`);
    process.exit(1);
  },
);
