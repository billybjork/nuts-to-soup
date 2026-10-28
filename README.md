# Nuts to Soup

A Chrome extension for listening through NTS Radio's archive: one ranked queue of every new episode, a history of the tracks you've heard, and playback that resumes where you left off. It drives NTS's own player, so plays still count for the hosts and show up in your NTS history.

## Install

1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Click the toolbar icon, or press `Control`+`N` (`Alt`+`Shift`+`N` on Windows/Linux), to open the side panel. Change the shortcut at `chrome://extensions/shortcuts`.

On install, the extension opens My NTS in a background tab for a few seconds to read your follows, saved episodes and history, then closes it. You need to be signed in to nts.live. The same sync runs once a day, and you can run it from the Hosts tab.

## How it works

- **Queue.** Every 30 minutes the extension reads NTS's public Latest feed and adds every episode it sees, so nothing is missed however irregularly you check. Episodes are often added a day or two after they air, so it tracks episode IDs rather than dates. The queue is sorted by how well each episode fits what you save, finish and queue, with hosts you follow (the heart on NTS) ranked higher.
- **Stacks.** Episodes from the same show share one card, with the next covers peeking out behind and a count you can click to see the rest. A stack plays newest first, one episode per turn: after you hear an episode from a show, at least three others play before that show comes up again. Placing a stack by hand (dragging it, or Play next) overrides that. Guest episodes are never stacked.
- **Order.** Cards you've placed by hand come first, then partly played ones, then a chain where each pick weighs its own score against how well it follows the previous one: shared genres, moods and tracklist artists, and a similar intensity.
- **Reordering.** Drag a card by its grip (or focus it and press Alt+↑/↓), or choose **Play next** from its ··· menu. Everything down to where you picked it up or dropped it, whichever is lower, keeps the order you see. The rest stays ranked, in the same order as before.
- **Playing.** Play on a card loads that episode in your NTS tab (opening one if needed) and the episode that was playing goes to the top of the queue. Play/pause in the panel picks up in that tab if the episode is still loaded there, and otherwise loads it again where you left off, so it works after the tab was closed, reloaded or put to sleep, or Chrome restarted. If a stream dies (NTS's SoundCloud streams expire a few hours after loading, so this happens after a long pause), NTS is made to fetch a new one and it carries on from where it stopped.
- **Skipping.** Skip (⏭ on the now-playing card) moves on to the next card and takes the current episode out of the queue. Skipping in the first five minutes counts against it, like removing it. Next track (the small ▸▸ beside the current track) jumps to the next tracklist entry in the same episode.
- **Tracks.** Each track is logged as it starts playing, using NTS's tracklist timestamps. Click one to jump to its start, in the same episode if it's still playing or by reloading it.
- **Adding.** Drag an episode link from any nts.live tab onto the side panel, paste links into it, or right-click an episode link (or episode page) and choose **Add to Nuts to Soup**.

### Why NTS used to lose your place

NTS saves your position to your account only when playback stops: pause, switching episodes, or reaching the end. If you quit Chrome, restart, or Chrome's Memory Saver puts a paused tab to sleep, the saved position is your last pause or zero. NTS also fetches saved positions after the page loads, and an episode that loads first starts at 0. This extension keeps its own positions per episode and corrects the start.

## Keys (side panel)

| | |
|---|---|
| `J` / `K` | move |
| `Enter` | play |
| `Shift` + `Enter` | play next |
| `Alt` + `↑` / `↓` | move the focused card |
| `X` | remove |
| `Space` | play / pause |
| `N` | skip to the next episode |
| `Shift` + `N` | next track |
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
- `sndcdn.com` segment URLs with a CloudFront `Policy`: when a paused stream expires (`/api/v2/resolve-stream` starts a new one)
- an `error` event (code 4) on the episode's `<audio>`: the only thing that makes NTS fetch a new stream for the episode it has
