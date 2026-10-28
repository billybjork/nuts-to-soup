-- Nuts to Soup in Rex: play/pause, skip and next track from anywhere, and
-- the player in a floating pane.
--
-- Copy this into ~/.config/rex/init.lua (or save it beside that file and
-- `require` it), then run `rex config reload`. The actions run the `nts`
-- command that `npm run install-host` (in tui/) puts in ~/.local/bin.
--
-- Press Ctrl+Cmd+N, then:
--   Space    play / pause
--   N        skip to the next episode
--   Shift+N  next track
--   S        what's playing, as a notification
--   P        the player (nts tui) in a floating pane; again to close it

local nts = os.getenv("HOME") .. "/.local/bin/nts"
local prefix = "ctrl+cmd+n"
local player = "nts-player" -- the player pane's label, to find it again

-- Runs nts and returns what it printed. rex.exec lets the server go on
-- handling keys while it waits: starting an episode can take a few seconds,
-- and starting Chrome up to ten more.
local function run(...)
  local r, err = rex.exec({ nts, ... }, { timeout = 28 })
  if r == nil then error(err, 0) end
  local out = (r.ok and r.stdout or r.stderr):gsub("^nts: ", ""):gsub("%s+$", "")
  if not r.ok then error(out, 0) end
  return out
end

local function notify(title, text)
  rex.exec({
    "osascript",
    "-e", "on run argv",
    "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
    "-e", "end run",
    title, text,
  })
end

rex.action{
  name = "nts_toggle",
  title = "NTS: Play / Pause",
  category = "Nuts to Soup",
  run = function() return { result = run("toggle") } end,
}

rex.action{
  name = "nts_skip",
  title = "NTS: Skip to the Next Episode",
  category = "Nuts to Soup",
  run = function() return { result = run("skip") } end,
}

rex.action{
  name = "nts_next",
  title = "NTS: Next Track",
  category = "Nuts to Soup",
  run = function() return { result = run("next") } end,
}

rex.action{
  name = "nts_status",
  title = "NTS: What's Playing",
  category = "Nuts to Soup",
  run = function(ctx)
    local text = run("status")
    if ctx.origin == "key" or ctx.origin == "palette" then
      local first, rest = text:match("^([^\n]*)\n?(.*)$")
      notify(first, rest ~= "" and rest or first)
    end
    return { status = text }
  end,
}

-- The floating layer holding the player, if one is open in this session.
local function player_layer()
  local view, err = rex.session.view{}
  if view == nil then error(err, 0) end
  for _, w in ipairs(view.windows or {}) do
    for _, layer in ipairs(w.layers or {}) do
      for _, b in ipairs(layer.blocks or {}) do
        if b.label == player and layer.kind ~= "tiled" then return layer.layer_id end
      end
    end
  end
end

rex.action{
  name = "nts_player",
  title = "NTS: Toggle Player",
  category = "Nuts to Soup",
  run = function()
    local open = player_layer()
    if open then
      local _, err = rex.session.close_layer{ layer_id = open }
      if err ~= nil then error(err, 0) end
      return { closed = open }
    end
    -- Quitting the player (q) closes the pane, and its layer with it.
    local r, err = rex.session.new_layer{
      bounds = { 0.15, 0.1, 0.7, 0.8 },
      focus = true,
      layout = rex.layout.block{
        flavor = "com.superlogical.terminal.shell",
        label = player,
        options = { command = { nts, "tui" }, shell = "none" },
      },
    }
    if r == nil then error(err, 0) end
    return { opened = r.layer_id }
  end,
}

rex.bind(prefix .. ">space", "nts_toggle")
rex.bind(prefix .. ">n", "nts_skip")
rex.bind(prefix .. ">shift+n", "nts_next")
rex.bind(prefix .. ">s", "nts_status")
rex.bind(prefix .. ">p", "nts_player")
