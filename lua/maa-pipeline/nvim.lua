local M = {}
local detect = require("maa-pipeline.detect")
local controller = require("maa-pipeline.controller")
local hotkey = require("maa-pipeline.hotkey")

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

local function execute(client, command, arguments)
  client:request("workspace/executeCommand", {
    command = command,
    arguments = arguments,
  }, function(error)
    vim.schedule(function()
      if error then
        vim.notify(error.message or tostring(error), vim.log.levels.ERROR)
      end
    end)
  end)
end

local function run_task_at_cursor(client)
  local params = vim.lsp.util.make_range_params(0, client.offset_encoding)
  params.context = { diagnostics = {} }
  client:request("textDocument/codeAction", params, function(error, actions)
    vim.schedule(function()
      if error then
        vim.notify(error.message or tostring(error), vim.log.levels.ERROR)
        return
      end

      local run_actions = vim.tbl_filter(function(action)
        return action.title and action.title:match("^Run Maa task: ") ~= nil
      end, actions or {})
      local action = run_actions[1]
      if not action then
        vim.notify("No Maa task at cursor", vim.log.levels.WARN)
        return
      end

      execute(client, action.command.command, action.command.arguments)
    end)
  end)
end

local function stop_task()
  local client = current_client()
  if not client then
    vim.notify("maa_pipeline is not running", vim.log.levels.WARN)
    return
  end
  execute(client, "maa-pipeline.stopTask", {})
end

function M.setup(options)
  if not vim.lsp.config then
    error("maa-pipeline.nvim requires Neovim 0.11 or newer")
  end

  options = options or {}
  detect.setup_autoset()
  detect.autoset(0)
  vim.lsp.config("maa_pipeline", {
    init_options = {
      mode = options.mode,
      locale = options.locale,
      runtime = options.runtime,
    },
  })
  if options.stop_hotkey then
    local registered = hotkey.register(options.stop_hotkey, stop_task)
    if not registered then
      vim.schedule(function()
        vim.notify("Failed to register MaaPipelineStop hotkey: " .. options.stop_hotkey, vim.log.levels.WARN)
      end)
    end
  elseif jit.os == "Windows" then
    vim.schedule(function()
      vim.notify("MaaPipelineStop hotkey is disabled; set setup({ stop_hotkey = \"Ctrl+Alt+S\" }) to enable it", vim.log.levels.INFO)
    end)
  end
  vim.api.nvim_create_user_command("MaaPipelineSelectController", function()
    local client = current_client()
    if not client then
      vim.notify("maa_pipeline is not running", vim.log.levels.WARN)
      return
    end
    controller.select(client, detect.project_root(0))
  end, { desc = "Select and configure a Maa controller", force = true })
  vim.api.nvim_create_user_command("MaaPipelineStop", stop_task, {
    desc = "Stop the running Maa task",
    force = true,
  })
  vim.api.nvim_create_user_command("MaaPipelineRun", function()
    local client = current_client()
    if not client then
      vim.notify("maa_pipeline is not running", vim.log.levels.WARN)
      return
    end
    run_task_at_cursor(client)
  end, { desc = "Run the Maa task at the cursor", force = true })
  vim.api.nvim_create_user_command("MaaPipelineScreenshot", function()
    local client = current_client()
    if not client then
      vim.notify("maa_pipeline is not running", vim.log.levels.WARN)
      return
    end
    local root = detect.project_root(0)
    controller.select(client, root, nil, function()
      execute(client, "maa-pipeline.takeScreenshot", { root })
    end)
  end, { desc = "Select a controller, take a screenshot, and copy its ROI", force = true })
end

function M.project_root(bufnr)
  return detect.project_root(bufnr)
end

function M.is_maa_project(root)
  return detect.is_maa_project(root)
end

return M
