local M = {}

local buffer_name = "maa-pipeline://runtime"

local function append(client_id, level, message)
  vim.schedule(function()
    local buffer = vim.fn.bufnr(buffer_name)
    if buffer < 0 then
      buffer = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_name(buffer, buffer_name)
      vim.bo[buffer].buftype = "nofile"
      vim.bo[buffer].bufhidden = "hide"
      vim.bo[buffer].swapfile = false
      vim.bo[buffer].filetype = "log"
    end
    vim.b[buffer].maa_pipeline_client_id = client_id

    local text = string.format("[%s] %s", (level or "info"):upper(), message or "")
    local lines = vim.split(text, "\n", { plain = true })
    for index, line in ipairs(lines) do
      lines[index] = line:gsub("\r$", "")
    end

    vim.bo[buffer].modifiable = true
    local current = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
    if #current == 1 and current[1] == "" then
      current = {}
    end
    vim.list_extend(current, lines)
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, current)
    vim.bo[buffer].modifiable = false

    if vim.fn.bufwinid(buffer) < 0 then
      vim.cmd("botright 10split")
      vim.api.nvim_win_set_buf(0, buffer)
    end
  end)
end

function M.info(client_id, message)
  append(client_id, "info", message)
end

function M.warn(client_id, message)
  append(client_id, "warn", message)
end

function M.error(client_id, error, fallback)
  append(client_id, "error", error and (error.message or tostring(error)) or fallback)
end

return M
