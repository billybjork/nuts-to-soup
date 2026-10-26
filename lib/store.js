// Everything lives in chrome.storage.local. Playback progress is one key per
// episode ("p:<alias>") so the content script can write it without racing
// the service worker's read-modify-write of the bigger keys.

export const progressKey = (alias) => `p:${alias}`;

export async function load() {
  const all = await chrome.storage.local.get(null);
  const progress = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('p:')) progress[k.slice(2)] = v;
  }
  return {
    eps: all.eps || {}, // alias -> episode metadata
    queue: all.queue || [], // [{alias, addedAt, rank?}]; rank is a manual position
    plays: all.plays || [], // tracks heard, newest first: [{alias, path, artist, title, offset, at}]
    dismissed: all.dismissed || {}, // alias -> ts
    done: all.done || {}, // alias -> ts (listened to the end)
    follows: all.follows || { shows: [], syncedAt: 0 }, // from My NTS
    saved: all.saved || [], // bookmarked episode aliases, from My NTS
    history: all.history || [], // recently played aliases, from My NTS
    seen: all.seen || [], // every alias the Latest poller has seen
    now: all.now || null, // {alias, path, playing, pos, dur, at}
    settings: { autoAdvance: true, ...all.settings },
    polledAt: all.polledAt || 0,
    syncError: all.syncError || null,
    progress,
  };
}

export const save = (patch) => chrome.storage.local.set(patch);

export const isDone = (p) => !!p && p.dur > 0 && p.pos >= p.dur - 60;
