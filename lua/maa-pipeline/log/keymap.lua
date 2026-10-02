local M = {}

local keys = {
  click_filter = "<CR>",
  filter = "f",
  filter_help = "?",
  keymap_help = "g?",
  close_fold = "zc",
  open_fold = "zv",
}

local function valid(value)
  return value and value ~= "" and value ~= false
end

function M.set(new_keys)
  new_keys = new_keys or {}
  for name, value in pairs(new_keys) do
    if keys[name] ~= nil then
      keys[name] = value
    end
  end
end

function M.setup(buffer, actions)
  if valid(keys.click_filter) then
    vim.keymap.set("n", keys.click_filter, actions.click_filter, {
      buffer = buffer,
      silent = true,
      desc = "Maa log: filter by token under cursor",
    })
  end
  if valid(keys.filter) then
    vim.keymap.set("n", keys.filter, actions.filter, {
      buffer = buffer,
      silent = true,
      desc = "Maa log: filter by Lua expression",
    })
  end
  if valid(keys.filter_help) then
    vim.keymap.set("n", keys.filter_help, actions.filter_help, {
      buffer = buffer,
      silent = true,
      desc = "Maa log: filter help",
    })
  end
  if valid(keys.keymap_help) then
    vim.keymap.set("n", keys.keymap_help, actions.keymap_help, {
      buffer = buffer,
      silent = true,
      desc = "Maa log: keymap help",
    })
  end
  if valid(keys.close_fold) then
    vim.keymap.set("n", keys.close_fold, "zc", {
      buffer = buffer,
      silent = true,
      desc = "Maa log: close fold",
    })
  end
  if valid(keys.open_fold) then
    vim.keymap.set("n", keys.open_fold, "zv", {
      buffer = buffer,
      silent = true,
      desc = "Maa log: open fold under cursor",
    })
  end
end

return M
