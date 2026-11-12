// What the TUI draws: the header, the four views, and their pieces. With
// kitty graphics (`gfx`), covers, the record and the timeline are images;
// without, the same views fall back to text.
import React, { useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import htm from 'htm';
import { buildProfile } from '../lib/rank.js';
import {
  ago,
  fmtDate,
  fmtTime,
  cardInfo,
  tracksView,
  hostsView,
  trackName,
  livePosition,
} from '../lib/view.js';
import { Img, useAccent } from './graphics.js';
import * as P from './pixels.js';

const ui = htm.bind(React.createElement);
const GREEN = [90, 200, 120];
const rgbOf = (color) =>
  /^#[0-9a-f]{6}$/i.test(color) ? [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) : GREEN;
export const HEADER_ROWS = 6; // the header's height with graphics; 3 without
export const TOP = 3; // the screen row views start on, below the tabs and a gap

// --- images --------------------------------------------------------------------------

// A square cover, rounded a touch.
function coverImage(gfx, url, rows, tag = 'sq') {
  const cols = gfx.sq(rows);
  const [w, h] = gfx.px(cols, rows);
  return [
    gfx.image(`${tag}:${url}:${cols}x${rows}`, cols, rows, async () =>
      P.rounded(P.cover(await gfx.art.image(url, 400), w, h), Math.round(h * 0.025)),
    ),
    cols,
  ];
}

// A list thumbnail, with the side panel's progress bar along its bottom.
function thumbImage(gfx, ep, rows, pct = 0) {
  const cols = gfx.sq(rows);
  const [w, h] = gfx.px(cols, rows);
  const small = Math.max(w, h) <= 100;
  const url = (small ? ep.thumb : ep.image) || ep.image || ep.thumb;
  const step = pct > 0 && pct < 100 ? Math.max(2, Math.round(pct / 5) * 5) : 0;
  return [
    gfx.image(`th:${url}:${cols}x${rows}:${step}`, cols, rows, async () => {
      const img = P.cover(await gfx.art.image(url, small ? 100 : 400), w, h);
      if (step) {
        const bh = Math.max(2, Math.round(h * 0.07));
        P.rect(img, 0, h - bh, w, bh, [0, 0, 0, 160]);
        P.rect(img, 0, h - bh, (w * step) / 100, bh, [235, 235, 235, 255]);
      }
      return img;
    }),
    cols,
  ];
}

const backdropImage = (gfx, url, cols, rows) =>
  gfx.image(`bd:${url}:${cols}x${rows}`, cols, rows, async () => {
    // Blurred, so a quarter of the resolution is plenty; the terminal scales it.
    const [w, h] = gfx.px(cols, rows).map((n) => Math.max(8, Math.round(n / 4)));
    return P.darken(P.blur(P.cover(await gfx.art.image(url, 400), w, h), 15), 0.3);
  });

// Places `e` under the text at a fixed spot while this component is mounted.
function useOverlay(gfx, name, list) {
  const sig = JSON.stringify(list);
  useEffect(() => {
    gfx?.overlay(name, list);
  }, [gfx, name, sig]);
  useEffect(() => () => gfx?.overlay(name, null), [gfx, name]);
}

function timelineImage(gfx, name, cols, rows, { ep, dur, pos, color, focus = -1 }) {
  const [w, h] = gfx.px(cols, rows);
  const head = dur > 0 ? Math.round((pos / dur) * w) : 0;
  return gfx.slot(name, cols, rows, `${ep.alias}:${cols}x${rows}:${head}:${color}:${focus}:${dur}`, () =>
    P.timeline(w, h, { dur, pos, tracks: ep.tracks || [], color: rgbOf(color), focus }),
  );
}

// --- header ---------------------------------------------------------------------------

export function Tabs({ view, count }) {
  const tab = (v, label) =>
    ui`<${Text} key=${v} bold=${view === v} dimColor=${view !== v} underline=${view === v}>${label}<//>`;
  return ui`<${Box} gap=${2} paddingX=${1}>
    <${Text} bold>Nuts to Soup<//>
    ${[
      tab('queue', `1 Queue${count ? ` ${count}` : ''}`),
      tab('tracks', '2 Tracks'),
      tab('hosts', '3 Hosts'),
    ]}
  <//>`;
}

const timeOf = (v) => `${fmtTime(v.pos)}${v.dur ? ` / ${fmtTime(v.dur)}` : ''}`;
const showName = (s, alias) => s.follows.shows.find((h) => h.alias === alias)?.name || alias;

export function Now({ gfx, s, v, width }) {
  if (!gfx) return ui`<${NowText} v=${v} width=${width} />`;
  if (!v)
    return ui`<${Box} paddingX=${1} height=${HEADER_ROWS}>
      <${Text} dimColor>Nothing playing. Enter plays the focused card, space plays the top one.<//>
    <//>`;
  return ui`<${NowArt} gfx=${gfx} s=${s} v=${v} width=${width} />`;
}

function NowArt({ gfx, s, v, width }) {
  const url = v.ep.image || v.ep.thumb;
  const color = useAccent(gfx, url);
  const rows = HEADER_ROWS;
  const cols = gfx.sq(rows, DECK_RATIO);
  const shown = useTurntable(gfx, url, rows, cols, v);
  const [still, stillCols] = coverImage(gfx, url, rows);
  const bd = backdropImage(gfx, url, width, rows);
  const textW = Math.max(10, width - cols - 5);
  const tl = timelineImage(gfx, 'now', textW, 1, { ep: v.ep, dur: v.dur, pos: v.pos, color });
  // All placed directly, not through placeholders: the terminal draws a placed
  // image over placeholder cells whatever its z, so anything on the backdrop
  // has to be placed too, after it and above it.
  const art = shown ? [shown, cols] : still.ready ? [still, stillCols] : null;
  useOverlay(gfx, 'header', [
    ...(bd.ready ? [{ id: bd.id, row: TOP, col: 1, cols: width, rows, z: -1 }] : []),
    ...(art ? [{ id: art[0].id, row: TOP, col: 2, cols: art[1], rows, z: 1 }] : []),
    { id: tl.id, row: TOP + 4, col: cols + 4, cols: textW, rows: 1, z: 1 },
  ]);
  return ui`<${Box} paddingX=${1} height=${rows}>
    <${Box} width=${cols} flexShrink=${0} />
    <${Box} flexDirection="column" marginLeft=${2} width=${textW}>
      <${Box}>
        <${Box} flexGrow=${1} flexShrink=${1}>
          <${Text} wrap="truncate-end" bold color=${color}>${v.playing ? '▶ ' : '❚❚ '}${v.ep.name || v.alias}<//>
        <//>
        <${Text}> ${timeOf(v)}<//>
      <//>
      <${Text} wrap="truncate-end" dimColor>
        ${[showName(s, v.ep.show), v.ep.location, fmtDate(v.ep.date)].filter(Boolean).join(' · ')}
      <//>
      <${Text} wrap="truncate-end" dimColor=${!v.track}>
        ${v.track ? `♪ ${trackName(v.track)}` : v.playing ? 'No track listed here' : 'Paused'}
      <//>
      <${Text} wrap="truncate-end" dimColor>${v.next ? `next  ${trackName(v.next)}  at ${fmtTime(v.next.offset)}` : ' '}<//>
      <${Box} height=${1} flexShrink=${0} />
      <${Text} wrap="truncate-end" dimColor>${[...v.ep.genres, ...v.ep.moods].join(' · ') || ' '}<//>
    <//>
  <//>`;
}

function NowText({ v, width }) {
  if (!v)
    return ui`<${Box} flexDirection="column" paddingX=${1} height=${3}>
      <${Text} dimColor>Nothing playing. Enter plays the focused card, space plays the top one.<//>
    <//>`;
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
      <${Text}> ${timeOf(v)}<//>
    <//>
    <${Text} wrap="truncate-end" dimColor=${!v.track}>
      ${v.track ? `♪ ${trackName(v.track)}` : `${v.ep.show}${v.playing ? '' : ' · paused'}`}
    <//>
    <${Text}><${Text} color="green">${'━'.repeat(done)}<//><${Text} dimColor>${'─'.repeat(bar - done)}<//><//>
  <//>`;
}

// --- lists ----------------------------------------------------------------------------

// A window onto `items` that keeps item `at` in view. An item is {key, height,
// el}, or {key, height, render} to be built only when it's on screen, so its
// images are only fetched then.
export function List({ items, at, height, empty }) {
  const top = useRef(0);
  const rows = (a, b) => items.slice(a, b + 1).reduce((n, it) => n + (it.height || 1), 0);
  top.current = Math.max(0, Math.min(top.current, items.length - 1));
  if (at < top.current) top.current = at;
  while (top.current < at && rows(top.current, at) > height) top.current++;
  while (top.current > 0 && rows(top.current - 1, items.length - 1) <= height) top.current--;
  if (!items.length) return ui`<${Box} height=${height} paddingX=${1}><${Text} dimColor>${empty}<//><//>`;
  const shown = [];
  let used = 0;
  for (let i = top.current; i < items.length && used + (items[i].height || 1) <= height; i++) {
    shown.push(items[i].render ? items[i].render() : items[i].el);
    used += items[i].height || 1;
  }
  return ui`<${Box} flexDirection="column" height=${height} overflow="hidden" flexGrow=${1} flexShrink=${1}>
    ${shown}
  <//>`;
}

const Marker = ({ on, rows = 1 }) =>
  ui`<${Box} flexDirection="column" width=${1} flexShrink=${0}>
    <${Text} inverse=${on}>${on ? '›' : ' '}<//>
    ${rows > 1 && ui`<${Text}> <//>`}
  <//>`;

export const previewWidth = (columns) => (columns >= 100 ? Math.min(46, Math.round(columns * 0.36)) : 0);

export function queueItems({ gfx, s, cards, focus, dense }) {
  const w = String(cards.length).length;
  const rows = gfx && !dense ? 2 : 1;
  return cards.map((c, i) => {
    const on = i === focus;
    const { pct, notes } = cardInfo(s, c);
    const more = c.stack.length ? ui`<${Text} color="yellow"> ×${c.stack.length + 1}<//>` : '';
    const meta = [...notes, c.ep.genres.join(', ')].filter(Boolean).join(' · ');
    const title = `${String(i + 1).padStart(w)} ${c.ep.name || c.alias}`;
    const render = () => {
      const [thumb, cols] = gfx ? thumbImage(gfx, c.ep, rows, pct) : [null, 0];
      return rows === 2
        ? ui`<${Box} key=${c.key} height=${2}>
          <${Marker} on=${on} rows=${2} />
          <${Box} marginLeft=${1} flexShrink=${0}><${Img} e=${thumb} cols=${cols} rows=${2} /><//>
          <${Box} flexDirection="column" marginLeft=${1} flexGrow=${1} flexShrink=${1}>
            <${Text} wrap="truncate-end"><${Text} bold inverse=${on}>${title}<//>${more}<//>
            <${Text} wrap="truncate-end" dimColor>${' '.repeat(w + 1)}${meta}<//>
          <//>
        <//>`
        : ui`<${Box} key=${c.key} height=${1}>
          <${Marker} on=${on} />
          ${gfx && ui`<${Box} marginLeft=${1} flexShrink=${0}><${Img} e=${thumb} cols=${cols} rows=${1} /><//>`}
          <${Box} flexGrow=${1} flexShrink=${1}>
            <${Text} wrap="truncate-end" inverse=${on}>
              <${Text} dimColor> ${String(i + 1).padStart(w)} <//>${c.ep.name || c.alias}${more}
              <${Text} dimColor>${'  '}${meta}<//>
            <//>
          <//>
        <//>`;
    };
    return { key: c.key, height: rows, render };
  });
}

export function trackItems({ gfx, s, focus }) {
  const items = [];
  const focusable = [];
  let i = 0;
  for (const t of tracksView(s)) {
    if (t.day)
      items.push({ key: `d${items.length}`, el: ui`<${Text} key=${`d${items.length}`} bold> ${t.day}<//>` });
    const on = i === focus;
    const when = t.live
      ? 'Playing'
      : new Date(t.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const key = `t${i}`;
    const render = () => {
      const [thumb, cols] = gfx && t.ep ? thumbImage(gfx, t.ep, 1) : [null, 0];
      return ui`<${Box} key=${key} height=${1}>
        <${Marker} on=${on} />
        <${Box} width=${10} flexShrink=${0}>
          <${Text} color=${t.live ? 'green' : undefined} dimColor=${!t.live}> ${when}<//>
        <//>
        ${gfx && ui`<${Box} width=${gfx.sq(1) + 1} flexShrink=${0}><${Img} e=${thumb} cols=${cols} rows=${1} /><//>`}
        <${Box} flexGrow=${1} flexShrink=${1}>
          <${Text} wrap="truncate-end">
            <${Text} inverse=${on}>${trackName(t)}<//>
            <${Text} dimColor>${'  '}${t.ep?.name || t.alias} · ${fmtTime(t.offset)}<//>
          <//>
        <//>
      <//>`;
    };
    items.push({ key, render });
    focusable.push({ index: items.length - 1, track: t });
    i++;
  }
  return { items, focusable };
}

// --- previews -------------------------------------------------------------------------

// A line of a preview. It keeps its row when the preview overflows, rather
// than being squeezed out by the lines below it.
const Line = ({ children, ...props }) =>
  ui`<${Box} flexShrink=${0}><${Text} wrap="truncate-end" ...${props}>${children || ' '}<//><//>`;

export function QueuePreview({ gfx, s, card: c, width, height }) {
  const url = c?.ep.image || c?.ep.thumb;
  const color = useAccent(gfx, url, undefined);
  if (!c) return null;
  const eps = [c.ep, ...c.stack.map((st) => st.ep || s.eps[st.alias]).filter(Boolean)];
  const lines = [];
  let art = null;
  if (gfx) {
    const n = Math.min(3, eps.length);
    const rows = Math.max(4, Math.min(height - 9, Math.round(((width * gfx.cw) / gfx.ch) * 0.62)));
    const step = Math.round(rows * gfx.ch * 0.06);
    const size = rows * gfx.ch - step * (n - 1);
    const cols = Math.min(width, Math.ceil((size + step * (n - 1)) / gfx.cw));
    const e = gfx.image(`stack:${eps.slice(0, n).map((x) => x.alias)}:${rows}`, cols, rows, async () => {
      // The front cover has to load; any behind it that don't are left out.
      const [front, ...behind] = await Promise.allSettled(
        eps.slice(0, n).map((x) => gfx.art.image(x.image || x.thumb, 400)),
      );
      if (front.status === 'rejected') throw front.reason;
      const covers = [front.value, ...behind.filter((r) => r.status === 'fulfilled').map((r) => r.value)];
      const img = P.stack(covers, size);
      // Keep the box's proportions when a cover behind went missing.
      return P.draw(
        P.blank(size + step * (n - 1), size + step * (n - 1)),
        img,
        0,
        size + step * (n - 1) - img.h,
      );
    });
    art = ui`<${Box} height=${rows + 1} flexShrink=${0}><${Img} e=${e} cols=${cols} rows=${rows} /><//>`;
  }
  const followed = s.follows.shows.some((h) => h.alias === c.ep.show);
  lines.push(ui`<${Line} key="name" bold color=${color}>${c.ep.name || c.alias}<//>`);
  lines.push(
    ui`<${Line} key="show" dimColor>${[`${followed ? '♥ ' : ''}${showName(s, c.ep.show)}`, c.ep.location].filter(Boolean).join(' · ')}<//>`,
  );
  lines.push(ui`<${Line} key="notes" dimColor>${cardInfo(s, c).notes.join(' · ')}<//>`);
  lines.push(ui`<${Line} key="tags">${[...c.ep.genres, ...c.ep.moods].join(' · ')}<//>`);
  if (eps.length > 1) {
    lines.push(
      ui`<${Line} key="sgap"> <//>`,
      ui`<${Line} key="stack" dimColor>${eps.length} in this stack, newest first<//>`,
    );
    for (const ep of eps.slice(1, 4))
      lines.push(ui`<${Line} key=${ep.alias} dimColor>  ${fmtDate(ep.date)}  ${ep.name || ep.alias}<//>`);
  }
  if (c.ep.tracks?.length) {
    lines.push(
      ui`<${Line} key="tgap"> <//>`,
      ui`<${Line} key="tl" dimColor>Tracklist · ${c.ep.tracks.length}<//>`,
    );
    c.ep.tracks.forEach((t, i) =>
      lines.push(ui`<${Line} key=${`t${i}`}>${fmtTime(t.offset).padStart(9)}  ${trackName(t)}<//>`),
    );
  }
  return ui`<${Box} flexDirection="column" width=${width} height=${height} marginLeft=${2} overflow="hidden" flexShrink=${0}>
    ${art}${lines}
  <//>`;
}

export function TrackPreview({ gfx, s, track: t, width, height }) {
  const ep = t?.ep;
  const color = useAccent(gfx, ep?.image, undefined);
  if (!ep) return null;
  const tracks = ep.tracks || [];
  const index = tracks.findIndex((x) => x.offset === t.offset);
  const isNow = s.now?.alias === t.alias;
  const dur = s.progress[t.alias]?.dur || (isNow && s.now.dur) || (tracks.at(-1)?.offset ?? t.offset) + 300;
  const pos = isNow ? livePosition(s, null) : s.progress[t.alias]?.pos || 0;
  let art = null;
  let tl = null;
  if (gfx) {
    const rows = Math.max(4, Math.min(height - 8, Math.round(((width * gfx.cw) / gfx.ch) * 0.55)));
    const [e, cols] = coverImage(gfx, ep.image || ep.thumb, rows);
    art = ui`<${Box} height=${rows + 1} flexShrink=${0}><${Img} e=${e} cols=${cols} rows=${rows} /><//>`;
    tl = timelineImage(gfx, 'track', width, 1, { ep, dur, pos, color: color || '#5ac878', focus: index });
  }
  return ui`<${Box} flexDirection="column" width=${width} height=${height} marginLeft=${2} overflow="hidden" flexShrink=${0}>
    ${art}
    <${Line} bold color=${color}>${trackName(t)}<//>
    <${Line} dimColor>${ep.name || t.alias}<//>
    <${Line} dimColor>
      ${index >= 0 ? `Track ${index + 1} of ${tracks.length} · ` : ''}starts ${fmtTime(t.offset)} of ${fmtTime(dur)}
    <//>
    <${Line}> <//>
    ${tl && ui`<${Img} e=${tl} cols=${width} rows=${1} />`}
    ${tl && ui`<${Line} dimColor>${isNow ? 'This track, and where you are' : 'This track, and how far you got'}<//>`}
  <//>`;
}

// --- hosts ----------------------------------------------------------------------------

// The grid's geometry, shared with the keys (j/k move a row).
export function hostGrid(gfx, columns, height) {
  const tileRows = Math.max(3, Math.min(6, Math.floor((height - 8) / 2) - 1));
  const tileCols = gfx.sq(tileRows);
  return { tileRows, tileCols, per: Math.max(1, Math.floor((columns - 2) / (tileCols + 2))) };
}

const latestOf = (s, alias) =>
  Object.values(s.eps)
    .filter((e) => e.show === alias)
    .sort((a, b) => b.date - a.date);

export function HostGrid({ gfx, s, focus, columns, height }) {
  const { shows, genres } = hostsView(s, buildProfile(s));
  const { tileRows, tileCols, per } = hostGrid(gfx, columns, height);
  const sel = shows[Math.min(focus, shows.length - 1)];
  const selUrl = sel && (latestOf(s, sel.alias)[0]?.image || latestOf(s, sel.alias)[0]?.thumb);
  const color = useAccent(gfx, selUrl, '#ffffff');
  const top = useRef(0);
  const fit = Math.max(1, Math.floor((height - 7) / (tileRows + 1)));
  const at = Math.floor(focus / per);
  if (at < top.current) top.current = at;
  if (at >= top.current + fit) top.current = at - fit + 1;
  const grid = [];
  for (let r = top.current; r < Math.min(top.current + fit, Math.ceil(shows.length / per)); r++) {
    grid.push(
      ui`<${Box} key=${r} gap=${2} height=${tileRows + 1}>
        ${shows.slice(r * per, r * per + per).map((h, k) => {
          const i = r * per + k;
          const on = i === focus;
          const ep = latestOf(s, h.alias)[0];
          const url = ep?.image || ep?.thumb;
          const [w, hh] = gfx.px(tileCols, tileRows);
          const e =
            url &&
            gfx.image(
              `host:${url}:${tileCols}x${tileRows}:${on ? color : ''}`,
              tileCols,
              tileRows,
              async () => {
                const img = P.cover(await gfx.art.image(url, 400), w, hh);
                const framed = on
                  ? P.frame(img, Math.max(3, Math.round(hh * 0.035)), [...rgbOf(color), 255])
                  : P.darken(img, 0.75);
                return P.rounded(framed, Math.round(hh * 0.04));
              },
            );
          return ui`<${Box} key=${h.alias} flexDirection="column" width=${tileCols}>
            <${Img} e=${e} cols=${tileCols} rows=${tileRows} />
            <${Text} wrap="truncate-end" inverse=${on} dimColor=${!on}>${h.name}<//>
          <//>`;
        })}
      <//>`,
    );
  }
  const eps = sel
    ? latestOf(s, sel.alias).slice(0, Math.max(1, Math.floor((columns - 2) / (gfx.sq(2) + 13))))
    : [];
  return ui`<${Box} flexDirection="column" paddingX=${1} height=${height} overflow="hidden">
    <${Text} bold>Following (${shows.length})<//>
    ${grid}
    ${
      sel &&
      ui`<${Box} flexDirection="column" marginTop=${0}>
      <${Text} bold>Latest from ${sel.name}<//>
      <${Box} gap=${1} height=${2}>
        ${eps.map((ep) => {
          const [e, cols] = thumbImage(gfx, ep, 2, cardInfo(s, { ep, why: [] }).pct);
          const status =
            s.now?.alias === ep.alias
              ? 'playing'
              : s.queue.some((q) => q.alias === ep.alias)
                ? 'queued'
                : s.done[ep.alias]
                  ? 'heard'
                  : '';
          return ui`<${Box} key=${ep.alias} width=${cols + 12}>
            <${Img} e=${e} cols=${cols} rows=${2} />
            <${Box} flexDirection="column" marginLeft=${1}>
              <${Text} dimColor>${fmtDate(ep.date).slice(0, 6)}<//>
              <${Text} dimColor>${status}<//>
            <//>
          <//>`;
        })}
      <//>
    <//>`
    }
    <${Text}> <//>
    <${Text} wrap="truncate-end" dimColor>Your sound  ${genres.join(' · ') || 'builds up as you save, finish and queue episodes.'}<//>
    <${Text} wrap="truncate-end" dimColor>Synced from My NTS ${ago(s.follows.syncedAt)}${s.syncError ? ` · ${s.syncError}` : ''}<//>
  <//>`;
}

// --- turntable ------------------------------------------------------------------------

const DECK_RATIO = P.deckLayout(100).w / 100;

// The header's turntable: the record turning while it plays, and the arm
// following how far through the episode you are. The arm moves a pixel every
// few minutes; each move is a new image, and the last one stays up until it's
// drawn, so nothing blinks.
function useTurntable(gfx, url, rows, cols, v) {
  const S = rows * gfx.ch;
  const { R } = P.deckLayout(S);
  const steps = Math.max(8, Math.round(R * (0.93 - P.LABEL * P.STOP))); // about a pixel a step
  const step = v.dur ? Math.min(steps, Math.round((v.pos / v.dur) * steps)) : 0;
  const want = gfx.turntable(`deck:${url}:${S}:${step}`, { url, S, t: step / steps }, { cols, rows });
  const last = useRef(null);
  if (want.ready) last.current = want;
  else if (last.current?.url !== url) last.current = null;
  if (want.ready) want.url = url;
  const shown = gfx.keep(want.ready ? want : last.current);
  gfx.spin(shown, v.playing);
  return shown;
}
