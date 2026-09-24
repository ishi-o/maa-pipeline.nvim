local M = {}
local detect = require("maa-pipeline.detect")

function M.setup()
  if not vim.lsp.config then
    error("maa-pipeline.nvim requires Neovim 0.11 or newer")
  end

  detect.setup_autoset()
  detect.autoset(0)
  vim.lsp.config("maa_pipeline", {})
end

function M.project_root(bufnr)
  return detect.project_root(bufnr)
end

function M.is_maa_project(root)
  return detect.is_maa_project(root)
end

return M
