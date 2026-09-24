# maa-pipeline.nvim

中文 | [English](README.md)

为所有 Maa 项目提供支持。

基于 [Maa Support Extension](https://github.com/neko-para/maa-support-extension)
中的解析器和索引，为 Neovim 提供 MaaFramework Pipeline 支持。

支持文件类型检测、补全、悬停提示、跳转与引用、诊断、Code Lens、代码操作、内联提示、文档链接、工作区符号和颜色支持。

## 安装

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

需要 Node.js 和 npm。

</details>

<details>
<summary>vim.pack（Neovim 0.12+）</summary>

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

需要 Node.js、npm 和 Git。首次安装或更新后，该钩子会自动构建服务器。

</details>

## 配置

默认配置如下：

```lua
require("maa-pipeline.nvim").setup({
  cmd = nil, -- LSP 启动命令；nil 使用插件自带的服务器
  filetypes = { "maa-pipeline.jsonc" }, -- 复合文件类型；所有 Maa JSON 文件均按 JSONC 处理
  root_markers = { "interface.json", "interface.jsonc", ".git" }, -- 项目根目录标记
  mode = "auto", -- "auto"：检测 src/MaaCore；"maa"：使用 MAA 语法；"framework"：使用 MaaFramework 语法
  locale = "en", -- "en"：英文；"zh"：中文诊断和悬停文本
  enabled = true, -- 是否启用 LSP；false 时仍保留文件类型检测
  on_attach = nil, -- LSP 附加到缓冲区时调用
  on_launch = nil, -- function({ root, task })；处理 Code Lens 选择的任务
  handlers = {}, -- 按方法名覆盖自定义 LSP 通知处理器
  init_options = {}, -- 额外的 LSP 初始化选项
})
```

例如，强制使用 Maa 模式并显示中文消息：

```lua
require("maa-pipeline.nvim").setup({
  mode = "maa",
  locale = "zh",
})
```
