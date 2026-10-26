# Nuts to Soup

A Chrome extension for listening through NTS Radio's archive: one ranked queue of every new episode, a history of the tracks you've heard, and playback that resumes where you left off. It drives NTS's own player, so plays still count for the hosts and show up in your NTS history.

## Install

1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Click the toolbar icon to open the side panel.

On install, the extension opens My NTS in a background tab for a few seconds to read your follows, saved episodes and history, then closes it. You need to be signed in to nts.live. The same sync runs once a day, and you can run it from the Hosts tab.

## How it works

- **Queue.** Every 30 minutes the extension reads NTS's public Latest feed and adds every episode it sees, so nothing is missed however irregularly you check. Episodes are often added a day or two after they air, so it tracks episode IDs rather than dates. The queue is sorted by how well each mix fits what you save, finish and queue, with hosts you follow (the heart on NTS) ranked higher.
- **Order.** Mixes you've placed by hand come first, then partly played ones, then a chain where each pick weighs its own score against how well it follows the previous one: shared genres, moods and tracklist artists, and a similar intensity.
- **Reordering.** Drag a mix by its grip (or focus it and press Alt+↑/↓). Everything down to where you dropped it keeps the order you see; the rest stays ranked.
- **Playing.** Play on a row loads that mix in your NTS tab (opening one if needed) and the mix that was playing goes to the top of the queue.
- **Tracks.** Each track is logged as it starts playing, using NTS's tracklist timestamps. Click one to jump to its start, in the same mix if it's still playing or by reloading it.
- **Adding.** Drag an episode link from any nts.live tab onto the side panel, paste links into it, or right-click an episode link (or episode page) and choose **Add to Nuts to Soup**.

### Why NTS used to lose your place

NTS saves your position to your account only when playback stops: pause, switching episodes, or reaching the end. If you quit Chrome, restart, or Chrome's Memory Saver puts a paused tab to sleep, the saved position is your last pause or zero. NTS also fetches saved positions after the page loads, and an episode that loads first starts at 0. This extension keeps its own positions per episode and corrects the start.

## Keys (side panel)

| | |
|---|---|
| `J` / `K` | move |
| `Enter` | play |
| `Alt` + `↑` / `↓` | move the focused mix |
| `X` | remove |
| `Space` | play / pause |
| `N` | next |
| `1` `2` `3` | queue / tracks / hosts |

## Files

- `background.js`: polling, sync, queue state, playback commands
- `content.js`: runs on nts.live; position tracking and resume, loading episodes, reading My NTS
- `lib/nts.js`: public NTS API
- `lib/rank.js`: scoring, taste profile, queue order
- `lib/store.js`: storage layout
- `panel/`: the side panel

No build step. Edit, then press reload on `chrome://extensions`. Reload any open nts.live tabs afterwards, since their old content script stops talking to the extension.

## Things that depend on NTS's site

These are the parts most likely to break if NTS changes their front end:

- `.mixcloud-btn` + `data-*` attributes: how episodes are loaded
- `localStorage.activeEpisode`: which episode is playing and where
- `.footer-player--episode-player`: the footer player (play/pause, Mixcloud iframe)
- `.my-nts__list-container .article-list-item`: My NTS lists
- `/api/v2/search/episodes`: Latest (offset caps out around 300)
