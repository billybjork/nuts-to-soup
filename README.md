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

|                   |                          |
| ----------------- | ------------------------ |
| `J` / `K`         | move                     |
| `Enter`           | play                     |
| `Shift` + `Enter` | play next                |
| `Alt` + `↑` / `↓` | move the focused card    |
| `X`               | remove                   |
| `Space`           | play / pause             |
| `N`               | skip to the next episode |
| `Shift` + `N`     | next track               |
| `1` `2` `3`       | queue / tracks / hosts   |

## Terminal

`nts` controls the extension from any terminal: `nts toggle`, `nts skip`, `nts next`, and `nts tui` (or `nts player`) for a full-screen player. Chrome still does the playing, in your NTS tab, so plays count for hosts and show up in your NTS history. Chrome has to be running, but you don't need to look at it.

```
nts CLI / TUI ──NDJSON over a Unix socket──▶ native host ──native messaging──▶ the extension ──▶ NTS tab
```

### Install

macOS only for now. Needs Node.js 22.13 or newer.

```sh
cd tui
npm install
npm run install-host
```

Then reload the extension at `chrome://extensions`, and reload any open nts.live tabs. `install-host` writes:

- the host manifest, `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.billybjork.nuts_to_soup.json`, allowing only this extension (its ID comes from the `key` in `manifest.json`)
- `~/Library/Application Support/nuts-to-soup/host`, which runs `tui/host.js`. The host listens on `bridge.sock` in the same folder (owner-only) and logs to `host.log`
- `~/.local/bin/nts`. Pass `--bin DIR` to put it somewhere else

Chrome starts native hosts with a minimal environment, so both wrappers run the `node` you installed with by its absolute path. Run `npm run install-host` again after switching Node versions, and `npm run uninstall-host` to remove all of the above.

The extension connects to the host when Chrome starts, and reconnects on its own if the connection drops. Chrome keeps an extension's service worker running while it has a native connection open (Chrome 105+), so terminal commands don't wait for it to start. If you use the extension in two Chrome profiles, the first one to connect serves the terminal.

### CLI

```
nts status [--json]          what's playing, where, and the current track
nts toggle                   play or pause
nts play                     play (resume)
nts pause                    pause
nts play <n | alias | url>   play queue card n, an episode, or an NTS link (added if new)
nts skip                     next episode
nts next                     next track in this episode
nts queue [-n N] [--json]    the queue in play order, as the panel shows it
nts add <url>...             add episode links
nts sync                     sync from My NTS
nts tui                      the full-screen player (also: nts player)
```

If Chrome isn't running, `nts` starts it in the background (`open -g`) and waits up to 10 seconds for the extension to connect. Commands that start playback can still need a click on play in the NTS tab, as in the panel (Chrome won't always start Mixcloud episodes without one). `nts` brings the tab to the front and says so.

### TUI

`nts tui` (or `nts player`) shows the queue (stacked by show), what's playing with its progress and current track, and the Tracks and Hosts views. It updates as the extension's state changes. Keys are the panel's: `J`/`K`, `Enter` play, `Shift`+`Enter` play next (or `T`, for terminals that can't tell it from `Enter`), `Alt`+`↑`/`↓` reorder, `X` remove, `Space` play/pause, `N` skip, `Shift`+`N` next track, `1` `2` `3` views, `Q` quit. If Chrome quits, it waits and reconnects when Chrome is back.

### Rex

[`tui/rex/init.lua`](tui/rex/init.lua) is an example [Rex](https://www.superlogical.com/rex) config. Copy it into `~/.config/rex/init.lua` (or `require` it from there) and run `rex config reload`. It adds five Rex actions. These run inside Rex, not in a shell: pick them from the command palette (type "NTS"), or run `rex do nts_toggle` and so on. Each runs the `nts` command in the last column, which you can also type in any terminal.

| Rex action   | Palette title                 | Runs         |
| ------------ | ----------------------------- | ------------ |
| `nts_toggle` | NTS: Play / Pause             | `nts toggle` |
| `nts_skip`   | NTS: Skip to the Next Episode | `nts skip`   |
| `nts_next`   | NTS: Next Track               | `nts next`   |
| `nts_status` | NTS: What's Playing           | `nts status` |
| `nts_player` | NTS: Toggle Player            | `nts tui`    |

**Toggle Player** opens `nts tui` in a pane beside the focused one, and closes it again. Quitting the player with `Q` closes it too. The actions run `nts` with `rex.exec`, which doesn't hold up the Rex server while a command waits. To bind one to a key, add a line such as `rex.bind("cmd+shift+m", "nts_player")`. Try an action before reloading with `rex do tui/rex/init.lua --action nts_status`. The actions expect `nts` in `~/.local/bin`; if you installed it elsewhere with `--bin`, change the path at the top of the file.

## Files

- `background.js`: polling, sync, queue state, playback commands
- `content.js`: runs on nts.live; position tracking and resume, loading episodes, reading My NTS
- `lib/nts.js`: public NTS API
- `lib/rank.js`: scoring, taste profile, queue order
- `lib/store.js`: storage layout
- `lib/view.js`: what the panel and the terminal show, from the stored state
- `lib/messages.js`: message validation
- `panel/`: the side panel
- `tui/`: the terminal bridge, `nts` CLI and TUI (its own package.json; the extension itself has no dependencies)

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

## Development checks

Use Node.js 22.13 or newer, run `npm ci`, then `npm run check`. This runs ESLint,
Prettier's formatting check, and Node's test runner. GitHub Actions runs the same
command on pushes and pull requests. `npm run format` applies formatting;
`npm run test:coverage` reports imported-module coverage (the simulated content
script and panel are executed dynamically and are not included in that report). Dependencies are development-only;
Chrome still loads the source files directly without a build step.

Tests cover ranking, API normalization, malformed storage, message validation,
concurrent sync, stale playback reports, command failures, and content-script
lifecycle behavior. Panel tests use jsdom to exercise rendering, keyboard
handling, and visible errors. Browser APIs and media are simulated; these tests
do not establish compatibility with every live NTS or media-provider change. After changing playback, reload the extension and NTS tabs and check:

- Play, pause, seek and resume after reloading or discarding the player tab.
- End an episode with auto-advance enabled and disabled; verify a single advance.
- Sync signed in and signed out, and close the sync tab midway through.
- Drag/reorder cards and add links while playback updates arrive.
- Resume a SoundCloud stream after a long pause and play a Mixcloud episode.

Sync deadlines use Chrome alarms so worker suspension does not lose the timeout.
API requests time out after 20 seconds; failed metadata enrichment becomes
eligible for retry after 30 minutes instead of permanently caching a failure.

### State and failure handling

The service worker owns writes to extension storage. Content scripts claim a
playback session and attach its identity to progress and end reports. Reports
from an old tab, an old playback session, or an episode superseded by a panel
command cannot overwrite the selected episode. Worker mutations and playback
commands each run serially; sync has its own serial queue so network and tab
navigation do not hold up progress saves.

Read-time normalization handles missing legacy fields and malformed records
without rewriting the entire store. Existing inbox/pin migrations remain in
place. Metadata can be fetched again; queue entries, listening progress and
preferences are not automatically expired. Track history is limited to 500
entries and poll deduplication to 3,000 IDs. Large queues and per-episode progress
can still grow over time; no destructive retention policy is applied.

A partially scraped follows or saved list merges with the existing list. Only a
complete scrape replaces it. Completeness is inferred from a stable list count,
so slow or changed NTS pagination remains a site-dependent limitation. Empty
follows/saved results are treated as partial to avoid erasing preferences when a
page fails to load; clearing the last follow/save on NTS is therefore not yet
reflected automatically.

After updating this version, reload the extension and open NTS tabs together:
older injected scripts use the previous progress-writing protocol.
