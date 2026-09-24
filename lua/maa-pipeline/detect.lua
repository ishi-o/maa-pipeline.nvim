local M = {}

local function exists(path)
  return vim.uv.fs_stat(path) ~= nil
end

local function is_file(path)
  local stat = vim.uv.fs_stat(path)
  return stat and stat.type == "file"
end

function M.interface_file(root)
  for _, name in ipairs({ "interface.json", "interface.jsonc" }) do
    local file = root .. "/" .. name
    if is_file(file) then
      return file
    end
  end
end

function M.project_root(bufnr)
  local name = vim.api.nvim_buf_get_name(bufnr or 0)
  if name == "" then
    return vim.fn.getcwd()
  end
  local start = vim.fs.dirname(name)
  local found = vim.fs.find({ "interface.json", "interface.jsonc" }, {
    path = start,
    upward = true,
    type = "file",
  })
  if #found > 0 then
    return vim.fs.dirname(found[1])
  end
  return start
end

function M.is_maa_project(root)
  return exists(root .. "/src/MaaCore")
    or (exists(root .. "/tasks") and exists(root .. "/template"))
end

function M.is_pipeline_file(name)
  if not name or name == "" then
    return false
  end
  local normalized = name:gsub("\\", "/")
  if not normalized:match("%.jsonc?$") then
    return false
  end
  local base = vim.fs.basename(normalized)
  if base == "interface.json" or base == "interface.jsonc" or base == "default_pipeline.json" then
    return true
  end
  if normalized:match("/pipeline/[^/]+%.jsonc?$") or normalized:match("/tasks/[^/]+%.jsonc?$") then
    return true
  end
  local found = vim.fs.find({ "interface.json", "interface.jsonc" }, {
    path = vim.fs.dirname(name),
    upward = true,
    type = "file",
  })
  return #found > 0
end

function M.autoset(bufnr)
  bufnr = bufnr or 0
  local name = vim.api.nvim_buf_get_name(bufnr)
  if M.is_pipeline_file(name) then
    vim.bo[bufnr].filetype = "maa-pipeline.jsonc"
    return true
  end
  return false
end

function M.setup_autoset()
  local group = vim.api.nvim_create_augroup("MaaPipelineFiletype", { clear = true })
  vim.api.nvim_create_autocmd({ "BufRead", "BufNewFile" }, {
    group = group,
    pattern = "*.json,*.jsonc",
    callback = function(args)
      M.autoset(args.buf)
    end,
  })
end

return M
