# maa-pipeline.nvim

[中文](https://github.com/ishi-o/maa-pipeline.nvim/blob/main/docs/README.zh-CN.md) | English

Neovim support for MaaFramework pipelines, reusing the parser and index from
[Maa Support Extension](https://github.com/neko-para/maa-support-extension).

## Features

- LSP features: completion, hover, navigation, references, diagnostics,
  Code Lens, code actions, inlay hints, document links, workspace symbols,
  and color support
- Filetype detection for Maa JSON/JSONC pipelines
- Run MaaFramework tasks directly from Neovim
- Runtime logs with native `ft=log` highlighting, source/kind highlights,
  Lua filtering, folding, and JSON or text export
- Screenshot cropping with ImageCropper

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
require("maa-pipeline.nvim").setup({
  stop_hotkey = nil, -- e.g. "Ctrl+Alt+S"; no global hotkey is registered when nil
})

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

On Windows, `maa-runtime` starts with administrator permissions because input
actions such as `Seize` require the same elevation as the target application.
Neovim itself remains unelevated.

## Commands

| Command | Description |
| --- | --- |
| `:MaaPipelineSelectController` | Select and configure a Maa controller |
| `:MaaPipelineStop` | Stop the running Maa task |
| `:MaaPipelineRun` | Run the Maa task at the cursor |
| `:MaaPipelineScreenshot` | Select a controller, take a screenshot, crop it, and save or copy its ROI |
| `:MaaPipelineLogFilter [expression]` | Filter runtime logs with a Lua expression; an empty expression clears the filter |
| `:MaaPipelineLogExportJson` | Export filtered runtime logs as JSON |
| `:MaaPipelineLogExportText` | Export filtered runtime logs as plain text |

## Code Actions

| Action | Description |
| --- | --- |
| `Run Maa task` | Run the task at the cursor |
| `Select Maa controller` | Select a controller declared in `interface.json/jsonc` |
| `ScreenShot` | Take and crop a screenshot |
| `Extract locale` | Move a localizable task reference into the localization file |

## Going Further

### Buffer Shortcuts

| Scope | Key | Action |
| --- | --- | --- |
| Runtime log | `<CR>` | Filter by the clicked source, task ID, or name |
| Runtime log | `f` | Prompt for a Lua filter expression |
| Runtime log | `zc` | Close the log fold |
| Runtime log | `zv` | Open the log fold under the cursor |
| ImageCropper | `S` | Save the cropped image |
| ImageCropper | `R` / `C` | Copy the ROI without saving an image |

### Custom Render

```lua
local render = {
  render = function(entry)
    return { entry.raw or "" }, {}
  end,
  render_details = function(entry)
    return { vim.inspect(entry.details) }
  end,
}

require("maa-pipeline.log").use(render)
```

## Architecture

- Neovim runs the Lua client and starts the bundled Node.js LSP server.
- The LSP server parses projects with `@nekosu/maa-pipeline-manager` and starts
  a separate `maa-runtime` process.
- `maa-runtime` uses `@nekosu/maa-server` to create controller, resource, and
  task instances, then launches external agents declared in `interface.json`.
