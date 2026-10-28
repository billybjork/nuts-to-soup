// The worker owns writes. Per-episode keys keep progress updates small;
// normalization at reads tolerates older versions and malformed records.
export const progressKey = (alias) => `p:${alias}`;
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const array = (value) => (Array.isArray(value) ? value : []);
const number = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
const strings = (value) => [...new Set(array(value).filter((v) => typeof v === 'string' && v))];
const map = (value) =>
  Object.assign(
    Object.create(null),
    Object.fromEntries(
      Object.entries(record(value)).filter(([, timestamp]) => Number.isFinite(timestamp) && timestamp >= 0),
    ),
  );
const position = (value) => ({
  ...value,
  pos: number(value.pos),
  dur: number(value.dur),
  at: number(value.at),
});

export function normalize(all = {}) {
  const progress = Object.create(null);
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('p:') && v && typeof v === 'object') progress[k.slice(2)] = position(v);
  }
  const eps = Object.create(null);
  for (const [alias, ep] of Object.entries(record(all.eps))) {
    if (!ep || typeof ep !== 'object' || typeof ep.path !== 'string') continue;
    eps[alias] = {
      ...ep,
      alias,
      date: number(ep.date),
      name: typeof ep.name === 'string' ? ep.name : '',
      genres: strings(ep.genres),
      moods: strings(ep.moods),
      artists: strings(ep.artists),
      intensity: Number.isFinite(ep.intensity) ? ep.intensity : null,
    };
    if (ep.missing) {
      delete eps[alias].detail;
      delete eps[alias].tracks;
    }
    if (ep.tracks != null && !Array.isArray(ep.tracks)) delete eps[alias].tracks;
    else if (Array.isArray(eps[alias].tracks))
      eps[alias].tracks = eps[alias].tracks
        .filter((t) => t && Number.isFinite(t.offset) && t.offset >= 0 && typeof t.title === 'string')
        .map((t) => ({
          ...t,
          artist: typeof t.artist === 'string' ? t.artist : '',
          duration: number(t.duration),
        }))
        .sort((a, b) => a.offset - b.offset);
  }
  const queue = [
    ...new Map(
      array(all.queue)
        .filter((q) => q && typeof q.alias === 'string')
        .map((q) => {
          const entry = { alias: q.alias, addedAt: number(q.addedAt) };
          if (Number.isFinite(q.rank)) entry.rank = q.rank;
          return [q.alias, entry];
        }),
    ).values(),
  ];
  const follows = record(all.follows);
  return {
    eps,
    queue,
    plays: array(all.plays)
      .filter((p) => p && typeof p.alias === 'string' && Number.isFinite(p.offset))
      .slice(0, 500),
    dismissed: map(all.dismissed),
    done: map(all.done),
    follows: {
      shows: array(follows.shows)
        .filter((s) => s && typeof s.alias === 'string')
        .map((s) => ({ ...s, name: typeof s.name === 'string' ? s.name : s.alias })),
      syncedAt: number(follows.syncedAt),
    },
    saved: strings(all.saved),
    history: strings(all.history),
    seen: strings(all.seen),
    now:
      all.now && typeof all.now.alias === 'string'
        ? { ...position(all.now), playing: all.now.playing === true, selectedAt: number(all.now.selectedAt) }
        : null,
    chainFrom: typeof all.chainFrom === 'string' ? all.chainFrom : null,
    settings: {
      autoAdvance: typeof all.settings?.autoAdvance === 'boolean' ? all.settings.autoAdvance : true,
    },
    polledAt: number(all.polledAt),
    syncError: typeof all.syncError === 'string' ? all.syncError : null,
    progress,
  };
}

export async function load() {
  return normalize(await chrome.storage.local.get(null));
}
export const save = (patch) => chrome.storage.local.set(patch);
export const isDone = (p) =>
  !!p &&
  Number.isFinite(p.dur) &&
  Number.isFinite(p.pos) &&
  p.dur > 0 &&
  p.pos >= Math.max(p.dur * 0.9, p.dur - 60);
