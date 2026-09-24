# maa-pipeline.nvim

[中文](README.zh-CN.md) | English

For all Maa projects.

Neovim support for MaaFramework pipelines, reusing the parser and index from
[Maa Support Extension](https://github.com/neko-para/maa-support-extension).

It provides filetype detection, completion, hover, navigation, diagnostics,
Code Lens, code actions, inlay hints, document links, workspace symbols, and
color support for Maa pipeline files.

## Install

<details>
<summary>lazy.nvim</summary>

```lua
{
  "ishi-o/maa-pipeline.nvim",
  build = "npm install --include=dev && npm run build",
  config = function()
    require("maa-pipeline.nvim").setup()
  end,
}
```

Requires Node.js and npm.

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
```

Requires Node.js, npm, and Git. The hook builds the server after the first
install and after updates.

</details>

## Configuration

The default configuration is:

```lua
require("maa-pipeline.nvim").setup({
  cmd = nil, -- LSP command; nil uses the bundled server
  filetypes = { "maa-pipeline.jsonc" }, -- compound filetype; every Maa JSON file uses JSONC
  root_markers = { "interface.json", "interface.jsonc", ".git" }, -- project root markers
  mode = "auto", -- "auto": detect src/MaaCore; "maa": MAA syntax; "framework": MaaFramework syntax
  locale = "en", -- "en": English; "zh": Chinese diagnostics and hover text
  enabled = true, -- enable the LSP; filetype detection remains active when false
  on_attach = nil, -- called when the LSP attaches to a buffer
  on_launch = nil, -- function({ root, task }); runs a task selected through Code Lens
  handlers = {}, -- overrides custom LSP notification handlers by method name
  init_options = {}, -- extra LSP initialization options
})
```

For example, to force Maa mode and Chinese messages:

```lua
require("maa-pipeline.nvim").setup({
  mode = "maa",
  locale = "zh",
})
```
