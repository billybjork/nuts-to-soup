// Public NTS API (CORS-open, CDN-cached for 15 minutes). No auth needed.

export const NTS = 'https://www.nts.live';
const API = `${NTS}/api/v2`;

// Shows whose episodes are one-off guests; following them means nothing.
export const GUESTS = 'guests';

// Not a musical signal, so it's left out of moods.
const IGNORED_MOODS = new Set(['safe for work']);

async function getJSON(path) {
  const res = await fetch(API + path, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`NTS ${res.status} ${path}`);
  return res.json();
}

export function parsePath(path) {
  const m = /^\/shows\/([a-zA-Z0-9_-]+)\/episodes\/([a-zA-Z0-9_-]+)(?=[/?#]|$)/.exec(path || '');
  return m ? { show: m[1], alias: m[2], path: m[0] } : null;
}

// Genre ids differ between endpoints, so tags are keyed by lowercased name.
const tags = (xs) => [
  ...new Set(
    (Array.isArray(xs) ? xs : [])
      .map((x) =>
        String(x?.name || x?.value || '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  ),
];

const moods = (xs) => tags(xs).filter((m) => !IGNORED_MOODS.has(m));

// Same preference as NTS's own play buttons, so we play what NTS would.
function pickSource(sources) {
  const url = (s) => (Array.isArray(sources) ? sources : []).find((x) => x?.source === s)?.url;
  return url('mixcloud') || url('soundcloud') || null;
}

export function fromSearch(r) {
  const p = parsePath(r?.article?.path);
  if (!p) return null;
  return {
    alias: p.alias,
    show: p.show,
    path: p.path,
    name: String(r.title || '').trim(),
    date: Date.parse(r.local_date) || 0,
    location: r.location || '',
    // The 200px "small" size comes from a host that often 503s; 400px doesn't.
    image: r.image?.medium || r.image?.small || '',
    thumb: r.image?.thumb || '',
    genres: tags(r.genres),
    moods: moods(r.moods),
    src: pickSource(r.audio_sources),
  };
}

function fromDetail(d) {
  return {
    alias: d.episode_alias,
    show: d.show_alias,
    path: `/shows/${d.show_alias}/episodes/${d.episode_alias}`,
    name: String(d.name || '').trim(),
    date: Date.parse(d.broadcast) || 0,
    location: d.location_long || '',
    image: d.media?.picture_medium || d.media?.picture_small || '',
    thumb: d.media?.picture_thumb || '',
    genres: tags(d.genres),
    moods: moods(d.moods),
    intensity: d.intensity != null && Number.isFinite(Number(d.intensity)) ? Number(d.intensity) : null,
    src: pickSource(d.audio_sources),
    detail: true,
  };
}

// The search endpoint 422s past offset ~300 (about ten days of episodes).
export const LATEST_MAX_OFFSET = 300;

export async function fetchLatest(offset, limit) {
  const d = await getJSON(`/search/episodes?offset=${offset}&limit=${limit}`);
  return d.results.map(fromSearch).filter(Boolean);
}

export async function fetchEpisode(path) {
  const parsed = parsePath(path);
  if (!parsed) throw new Error('Invalid episode path');
  const detail = fromDetail(await getJSON(parsed.path));
  if (detail.alias !== parsed.alias || detail.show !== parsed.show)
    throw new Error('NTS returned a different episode');
  return detail;
}

// Tracks in play order, with their start and length in seconds.
export async function fetchTracks(path) {
  const parsed = parsePath(path);
  if (!parsed) throw new Error('Invalid episode path');
  const d = await getJSON(`${parsed.path}/tracklist`);
  return d.results
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({
      artist: String(t.artist || '').trim(),
      title: String(t.title || '').trim(),
      offset: t.offset ?? t.offset_estimate,
      duration: Math.max(0, Number(t.duration ?? t.duration_estimate) || 0),
    }))
    .filter((t) => t.title && Number.isFinite(t.offset) && t.offset >= 0)
    .sort((a, b) => a.offset - b.offset);
}

// The track playing at `pos` seconds, if the tracklist covers it.
export const trackAt = (tracks, pos) => {
  const t = tracks.findLast((x) => x.offset <= pos);
  return t && pos < t.offset + (t.duration || Infinity) ? t : null;
};
