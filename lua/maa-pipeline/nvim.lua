local M = {}
local detect = require("maa-pipeline.detect")
local controller = require("maa-pipeline.controller")

local function current_client()
  local clients = vim.lsp.get_clients({ name = "maa_pipeline", bufnr = 0 })
  local client = clients[1]
  if not client then
    local client_id = vim.b.maa_pipeline_client_id
    client = client_id and vim.lsp.get_client_by_id(client_id) or nil
  end
  if not client then
    clients = vim.lsp.get_clients({ name = "maa_pipeline" })
    client = #clients == 1 and clients[1] or nil
  end
  return client
end

function M.setup()
  if not vim.lsp.config then
    error("maa-pipeline.nvim requires Neovim 0.11 or newer")
  end

  detect.setup_autoset()
  detect.autoset(0)
  vim.lsp.config("maa_pipeline", {})
  vim.api.nvim_create_user_command("MaaPipelineSelectController", function()
    local client = current_client()
    if not client then
      vim.notify("maa_pipeline is not running", vim.log.levels.WARN)
      return
    end
    controller.select(client, detect.project_root(0))
  end, { desc = "Select and configure a Maa controller", force = true })
  vim.api.nvim_create_user_command("MaaPipelineStop", function()
    local client = current_client()
    if not client then
      vim.notify("maa_pipeline is not running", vim.log.levels.WARN)
      return
    end
    client:request("workspace/executeCommand", {
      command = "maa-pipeline.stopTask",
      arguments = {},
    })
  end, { desc = "Stop the running Maa task", force = true })
end

function M.project_root(bufnr)
  return detect.project_root(bufnr)
end

function M.is_maa_project(root)
  return detect.is_maa_project(root)
end

return M
