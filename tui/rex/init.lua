-- Nuts to Soup in Rex: play/pause, skip and next track, and the player in
-- a pane beside the one you're in. Find them in the command palette under
-- "NTS", or run them with `rex do nts_toggle` and so on.
--
-- Copy this into ~/.config/rex/init.lua (or save it beside that file and
-- `require` it), then run `rex config reload`. The actions run the `nts`
-- command that `npm run install-host` (in tui/) puts in ~/.local/bin.

local nts = os.getenv("HOME") .. "/.local/bin/nts"
local player = "nts-player" -- the player pane's label, to find it again

-- Runs nts and returns what it printed. rex.exec lets the server go on
-- handling keys while it waits: starting an episode can take a few seconds,
-- and starting Chrome up to ten more.
local function run(...)
  local r, err = rex.exec({ nts, ... }, { timeout = 28 })
  if r == nil then error(err, 0) end
  local out = (r.ok and r.stdout or r.stderr):gsub("^nts: ", ""):gsub("%s+$", "")
  if r.ok then return out end
  if r.timed_out then error("nts timed out", 0) end
  if out == "" then out = "nts failed (" .. (r.signal or ("exit " .. r.code)) .. ")" end
  error(out, 0)
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
  run = function() return { status = run("status") } end,
}

-- The player's pane, if one is open in this session.
local function player_block()
  local view, err = rex.session.view{}
  if view == nil then error(err, 0) end
  for _, w in ipairs(view.windows or {}) do
    for _, layer in ipairs(w.layers or {}) do
      for _, b in ipairs(layer.blocks or {}) do
        if b.label == player then return b.block_id end
      end
    end
  end
end

rex.action{
  name = "nts_player",
  title = "NTS: Toggle Player",
  category = "Nuts to Soup",
  run = function(ctx)
    local open = player_block()
    if open then
      local _, err = rex.call("block.close", { session_id = ctx.session_id, block_id = open })
      if err ~= nil then error(err, 0) end
      return { closed = open }
    end
    -- Beside the focused pane. Quitting the player (q) closes it.
    local r, err = rex.session.new_split{
      anchor_id = ctx.block_id,
      direction = "horizontal",
      side = "after",
      ratio = 0.55,
      focus = true,
      layout = rex.layout.block{
        flavor = "com.superlogical.terminal.shell",
        label = player,
        options = { command = { nts, "tui" }, shell = "none" },
      },
    }
    if r == nil then error(err, 0) end
    return { opened = r.block_ids[1] }
  end,
}
