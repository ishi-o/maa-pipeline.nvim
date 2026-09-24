# maa-pipeline.nvim

[中文](README.zh-CN.md) | English

Neovim support for MaaFramework pipelines, reusing the parser and index from
[Maa Support Extension](https://github.com/neko-para/maa-support-extension).

It provides filetype detection, completion, hover, navigation, diagnostics,
Code Lens, code actions, inlay hints, document links, workspace symbols, and
color support for Maa pipeline files. MaaFramework tasks can also run directly
from Neovim.

## Install

<details>
<summary>lazy.nvim</summary>

```lua
{
  "ishi-o/maa-pipeline.nvim",
  build = "npm install --include=dev && npm run build",
  config = function()
    require("maa-pipeline.nvim").setup()
    vim.lsp.enable("maa_pipeline")
  end,
}
```

</details>

<details>
<summary>vim.pack (Neovim 0.12+)</summary>

```lua
vim.api.nvim_create_autocmd("PackChanged", {
  callback = function(event)
    local data = event.data
    if data.spec.name ~= "maa-pipeline.nvim" then
      return
    end
    if data.kind ~= "install" and data.kind ~= "update" then
      return
    end

    vim.system({ "npm", "install", "--include=dev" }, { cwd = data.path }):wait()
    vim.system({ "npm", "run", "build" }, { cwd = data.path }):wait()
  end,
})

vim.pack.add({
  "https://github.com/ishi-o/maa-pipeline.nvim",
})

require("maa-pipeline.nvim").setup()
vim.lsp.enable("maa_pipeline")
```

</details>

## Configuration

The default configuration is:

```lua
require("maa-pipeline.nvim").setup() -- register the bundled default config; no options are accepted

vim.lsp.config("maa_pipeline", {
  cmd = nil, -- nil keeps the bundled Node.js command; set a list to use another command
  filetypes = { "maa-pipeline.jsonc" }, -- compound filetype; every Maa JSON file uses JSONC
  root_markers = { "interface.json", "interface.jsonc", ".git" }, -- project root markers
  init_options = {
    mode = "auto", -- "auto": detect src/MaaCore; "maa": MAA syntax; "framework": MaaFramework syntax
    locale = "en", -- "en": English; "zh": Chinese diagnostics and hover text
    runtime = {
      data_dir = vim.fn.stdpath("data") .. "/maa-pipeline.nvim", -- MaaFramework downloads and logs
      version = "5.13.0", -- MaaFramework version used to run tasks
      registry = "https://registry.npmjs.org", -- npm registry used for MaaFramework downloads
      timeout = 60000, -- controller and Agent connection timeout in milliseconds; -1 disables it
      debug_mode = true, -- write MaaFramework debug logs
      save_draw = false, -- save recognition drawings
      save_on_error = true, -- save recognition data when a task fails
    },
  },
  capabilities = nil, -- nil uses Neovim defaults; provide extended client capabilities when needed
  on_attach = nil, -- called when the LSP attaches to a buffer
  handlers = {}, -- custom method handlers are merged with the bundled handlers
})

vim.lsp.enable("maa_pipeline") -- enable after applying overrides
```

For example, to force Maa mode and Chinese messages:

```lua
require("maa-pipeline.nvim").setup()

local capabilities = vim.lsp.protocol.make_client_capabilities()
capabilities.textDocument.completion.completionItem.snippetSupport = true -- advertise snippet completion support

vim.lsp.config("maa_pipeline", {
  capabilities = capabilities, -- replace this with capabilities from blink.cmp, nvim-cmp, or another client
  on_attach = function(client, bufnr) -- customize the attached client and buffer here
    vim.keymap.set("n", "gd", vim.lsp.buf.definition, { buffer = bufnr })
  end,
  init_options = {
    mode = "maa",
    locale = "zh",
  },
})
vim.lsp.enable("maa_pipeline")
```

## Run a task

Run `Code Action` and choose
`Run Maa task`. Output opens in a small log window. Use `:MaaPipelineStop` to
stop it. The first run downloads MaaFramework; open the target game or app when
the selected controller needs it.

If no controller is configured, running a task opens the selector. Use
`:MaaPipelineSelectController` from `interface.json/jsonc` or a pipeline file
to open it directly.
