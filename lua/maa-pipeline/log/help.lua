local M = {}

M.filter = {
  "Lua log filter",
  "",
  "Available variables:",
  "  level source family phase name raw kind",
  "  ids taskId nodeId recoId actionId wfId",
  "  reco algorithm text score box",
  "  action actionDetails details list nested elapsed",
  "",
  "Examples:",
  '  level == "error"',
  '  level == "error" or level == "warn"',
  '  family == "Reco"',
  "  taskId == 3",
  '  algorithm == "TemplateMatch"',
  '  name and name:lower():find("startup", 1, true)',
  '  raw and raw:find("recognition", 1, true)',
  "",
  "Empty expression clears the filter",
}

M.buffer = {
  "Maa pipeline log buffer keymaps",
  "",
  "  <CR>  filter by source, task id, or name under cursor",
  "  f     prompt for a Lua filter expression",
  "  ?     show filter help",
  "  g?    show keymap help",
  "  zc    close fold",
  "  zv    open fold under cursor",
}

function M.popup(title, lines)
  local body = { title, "" }
  vim.list_extend(body, lines)

  local width = 0
  for _, line in ipairs(body) do
    width = math.max(width, vim.fn.strdisplaywidth(line))
  end

  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, body)
  vim.bo[buf].modifiable = false
  vim.bo[buf].bufhidden = "wipe"

  vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    row = 1,
    col = 1,
    width = width + 2,
    height = #body,
    style = "minimal",
    border = "rounded",
  })

  vim.keymap.set("n", "q", "<cmd>close<cr>", { buffer = buf, silent = true })
  vim.keymap.set("n", "<Esc>", "<cmd>close<cr>", { buffer = buf, silent = true })
end

function M.show_filter()
  M.popup("Lua log filter", M.filter)
end

function M.show_buffer()
  M.popup("Maa pipeline log buffer keymaps", M.buffer)
end

return M
