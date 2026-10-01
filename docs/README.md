# maa-pipeline.nvim

[中文](https://github.com/ishi-o/maa-pipeline.nvim/blob/main/docs/README.zh-CN.md) | English

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
require("maa-pipeline.nvim").setup() -- register the bundled default config

-- Optional integration with an external ImageCropper checkout:
-- require("maa-pipeline.nvim").setup({
--   image_cropper_path = "D:/path/to/ImageCropper",
-- })

vim.lsp.config("maa_pipeline", {
  cmd = nil, -- nil keeps the bundled Node.js command; set a list to use another command
  filetypes = { "maa-pipeline.jsonc" }, -- compound filetype; every Maa JSON file uses JSONC
  root_markers = { "interface.json", "interface.jsonc", ".git" }, -- project root markers
  init_options = {
    mode = "auto", -- "auto": detect src/MaaCore; "maa": MAA syntax; "framework": MaaFramework syntax
    locale = "en", -- "en": English; "zh": Chinese diagnostics and hover text
    runtime = {
      data_dir = vim.fn.stdpath("data") .. "/maa-pipeline.nvim", -- MaaFramework downloads and logs
      version = "latest", -- "latest" resolves to the newest version; an exact semver pins it
      timeout = 60000, -- controller and Agent connection timeout in milliseconds; -1 disables it
      debug_mode = true, -- write MaaFramework debug logs
      save_draw = false, -- save recognition drawings
      save_on_error = true, -- save recognition data when a task fails
      daemon = false, -- keep Maa agents alive between tasks
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
stop it, or use `:MaaPipelineRun` to execute the task under the cursor. The
first run downloads MaaFramework; open the target game or app when the
selected controller needs it.

`MaaPipelineStop` supports a user-specified global hotkey on Windows, so the task can be
stopped while the game is in the foreground:

```lua
require("maa-pipeline.nvim").setup({
  stop_hotkey = "Ctrl+Alt+S",
})
```

No hotkey is registered unless `stop_hotkey` is set. On Windows, `maa-runtime` always starts
with administrator permissions because input actions such as `Seize` require the same
elevation as the target application. Neovim itself remains unelevated.

If no controller is configured, running a task opens the selector. Use
`:MaaPipelineSelectController` from `interface.json/jsonc` or a pipeline file
to open it directly.

## Take a screenshot

Run `:MaaPipelineScreenshot` from `interface.json/jsonc` or a pipeline file,
select a controller, crop the image in ImageCropper, and enter an image name
when prompted. Press `S` in ImageCropper to save a cropped image, or `R`/`C`
to copy its ROI without saving an image. The cropped image is saved to
`debug/screenshot` in the active resource and the selected ROI is copied to the
system clipboard. The initial screenshot is taken through the upstream Maa
server and MaaFramework SDK.

## Architecture

- Neovim runs the Lua client and starts the bundled Node.js LSP server.
- The LSP server parses projects with `@nekosu/maa-pipeline-manager` and starts
  a separate `maa-runtime` process.
- `maa-runtime` uses `@nekosu/maa-server` to create controller, resource, and
  task instances, then launches external agents declared in `interface.json`.
- Runtime logs show `<-- method` for calls from Neovim into the Maa runtime and
  `--> method` for calls from the runtime back into Neovim.
