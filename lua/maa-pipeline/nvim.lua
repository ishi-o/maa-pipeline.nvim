local M = {}
local detect = require("maa-pipeline.detect")

local defaults = {
  cmd = nil,
  filetypes = { "maa-pipeline.jsonc" },
  root_markers = { "interface.json", "interface.jsonc", ".git" },
  mode = "auto",
  locale = "en",
  enabled = true,
  on_attach = nil,
  on_launch = nil,
  handlers = {},
  init_options = {},
}

local methods = {
  trigger_completion = "maa-pipeline/triggerCompletion",
  show_references = "maa-pipeline/showReferences",
  show_text = "maa-pipeline/showText",
  launch_task = "maa-pipeline/launchTask",
  request_input = "maa-pipeline/requestInput",
}

local function plugin_root()
  local source = debug.getinfo(1, "S").source
  if source:sub(1, 1) == "@" then
    source = source:sub(2)
  end
  return vim.fn.fnamemodify(source, ":h:h:h")
end

local function default_cmd()
  return { "node", plugin_root() .. "/server/dist/maa-pipeline-lsp.mjs" }
end

local function merged_config(opts)
  local cfg = vim.tbl_deep_extend("force", {}, defaults, opts or {})
  cfg.cmd = cfg.cmd or default_cmd()
  cfg.init_options = vim.tbl_deep_extend("force", {
    mode = cfg.mode,
    locale = cfg.locale,
  }, cfg.init_options or {})
  return cfg
end

local function default_handlers(cfg)
  return {
    [methods.trigger_completion] = function()
      vim.schedule(function()
        if vim.lsp.completion and vim.lsp.completion.get then
          vim.lsp.completion.get()
        else
          vim.api.nvim_feedkeys(vim.keycode("<C-x><C-o>"), "n", false)
        end
      end)
    end,
    [methods.show_references] = function(_, result, ctx)
      vim.schedule(function()
        local client = vim.lsp.get_client_by_id(ctx.client_id)
        local encoding = client and client.offset_encoding or "utf-16"
        local items = vim.lsp.util.locations_to_items(result.locations or {}, encoding)
        vim.fn.setqflist({}, " ", { title = "Maa pipeline references", items = items })
        vim.cmd.copen()
      end)
    end,
    [methods.show_text] = function(_, result)
      vim.schedule(function()
        local buffer = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_buf_set_name(buffer, "maa-pipeline://" .. (result.title or "preview"))
        vim.api.nvim_buf_set_lines(buffer, 0, -1, false, vim.split(result.content or "", "\n", { plain = true }))
        vim.bo[buffer].filetype = "jsonc"
        vim.bo[buffer].modifiable = false
        vim.api.nvim_set_current_buf(buffer)
      end)
    end,
    [methods.launch_task] = function(_, result)
      if cfg.on_launch then
        vim.schedule(function()
          cfg.on_launch(result)
        end)
      else
        vim.notify("Set on_launch to run Maa tasks from Code Lens", vim.log.levels.WARN)
      end
    end,
    [methods.request_input] = function(_, result, ctx)
      vim.schedule(function()
        vim.ui.input({ prompt = (result.title or "Value") .. ": " }, function(value)
          if not value or value == "" then
            return
          end
          local client = vim.lsp.get_client_by_id(ctx.client_id)
          if client then
            client:request("workspace/executeCommand", {
              command = result.command,
              arguments = vim.list_extend(vim.deepcopy(result.arguments or {}), { value }),
            })
          end
        end)
      end)
    end,
  }
end

local function handlers(cfg)
  return vim.tbl_deep_extend("force", default_handlers(cfg), cfg.handlers or {})
end

local function legacy_start(bufnr, cfg)
  vim.lsp.start({
    name = "maa_pipeline",
    cmd = cfg.cmd,
    filetypes = cfg.filetypes,
    root_dir = detect.project_root(bufnr),
    init_options = cfg.init_options,
    on_attach = cfg.on_attach,
    handlers = handlers(cfg),
  }, { bufnr = bufnr })
end

function M.setup(opts)
  local cfg = merged_config(opts)
  detect.setup_autoset()
  detect.autoset(0)

  if vim.fn.has("nvim-0.11") == 1 and vim.lsp.config and vim.lsp.enable then
    vim.lsp.config("maa_pipeline", {
      cmd = cfg.cmd,
      filetypes = cfg.filetypes,
      root_markers = cfg.root_markers,
      init_options = cfg.init_options,
      on_attach = cfg.on_attach,
      handlers = handlers(cfg),
    })
    vim.lsp.enable("maa_pipeline", cfg.enabled)
    return
  end

  local group = vim.api.nvim_create_augroup("MaaPipelineLsp", { clear = true })
  if cfg.enabled then
    vim.api.nvim_create_autocmd("FileType", {
      group = group,
      pattern = cfg.filetypes,
      callback = function(args)
        legacy_start(args.buf, cfg)
      end,
    })
  end
end

function M.project_root(bufnr)
  return detect.project_root(bufnr)
end

function M.is_maa_project(root)
  return detect.is_maa_project(root)
end

return M
