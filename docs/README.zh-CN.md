# maa-pipeline.nvim

中文 | [English](https://github.com/ishi-o/maa-pipeline.nvim/blob/main/docs/README.md)

基于 [Maa Support Extension](https://github.com/neko-para/maa-support-extension)
中的解析器和索引，为 Neovim 提供 MaaFramework Pipeline 支持

支持文件类型检测、补全、悬停提示、跳转与引用、诊断、Code Lens、代码操作、内联提示、文档链接、工作区符号和颜色支持，也可以直接在 Neovim 中运行 MaaFramework 任务

## 安装

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
vim.lsp.enable("maa_pipeline")
```

</details>

## 配置

默认配置如下：

```lua
require("maa-pipeline.nvim").setup() -- 注册插件提供的默认配置

-- 可选接入外部 ImageCropper：
-- require("maa-pipeline.nvim").setup({
--   image_cropper_path = "D:/path/to/ImageCropper",
-- })

vim.lsp.config("maa_pipeline", {
  cmd = nil, -- nil 保留插件自带的 Node.js 命令；也可用列表指定其他命令
  filetypes = { "maa-pipeline.jsonc" }, -- 复合文件类型；所有 Maa JSON 文件均按 JSONC 处理
  root_markers = { "interface.json", "interface.jsonc", ".git" }, -- 项目根目录标记
  init_options = {
    mode = "auto", -- "auto"：检测 src/MaaCore；"maa"：使用 MAA 语法；"framework"：使用 MaaFramework 语法
    locale = "en", -- "en"：英文；"zh"：中文诊断和悬停文本
    runtime = {
      data_dir = vim.fn.stdpath("data") .. "/maa-pipeline.nvim", -- MaaFramework 下载文件和日志目录
      version = "latest", -- "latest" 解析为最新版本；填写精确 semver 可固定版本
      timeout = 60000, -- 控制器和 Agent 连接超时，单位毫秒；-1 表示不限制
      debug_mode = true, -- 写入 MaaFramework 调试日志
      save_draw = false, -- 保存识别过程图片
      save_on_error = true, -- 任务失败时保存识别数据
      daemon = false, -- 任务之间保持 Maa agent 常驻
    },
  },
  capabilities = nil, -- nil 使用 Neovim 默认能力；需要时可传入扩展后的客户端能力
  on_attach = nil, -- LSP 附加到缓冲区时调用
  handlers = {}, -- 自定义方法处理器会与插件默认处理器合并
})

vim.lsp.enable("maa_pipeline") -- 覆盖完成后再启用
```

例如，强制使用 Maa 模式并显示中文消息：

```lua
require("maa-pipeline.nvim").setup()

local capabilities = vim.lsp.protocol.make_client_capabilities()
capabilities.textDocument.completion.completionItem.snippetSupport = true -- 声明支持片段补全

vim.lsp.config("maa_pipeline", {
  capabilities = capabilities, -- 也可替换为 blink.cmp、nvim-cmp 等补全插件提供的 capabilities
  on_attach = function(client, bufnr) -- 在这里配置当前 LSP 客户端和缓冲区
    vim.keymap.set("n", "gd", vim.lsp.buf.definition, { buffer = bufnr })
  end,
  init_options = {
    mode = "maa",
    locale = "zh",
  },
})
vim.lsp.enable("maa_pipeline")
```

## 运行任务

使用 `Code Action` 执行光标选中的
运行日志会显示在一个小窗口中，使用 `:MaaPipelineStop` 停止任务
也可以使用 `:MaaPipelineRun` 直接执行光标所在的任务
首次运行会下载 MaaFramework；所选控制器需要目标游戏或应用时，请先打开它

`MaaPipelineStop` 支持用户指定 Windows 全局热键，游戏在前台时也能触发：

```lua
require("maa-pipeline.nvim").setup({
  stop_hotkey = "Ctrl+Alt+S",
})
```

未设置 `stop_hotkey` 时不注册全局热键。Windows 下 `maa-runtime` 会始终以管理员
权限启动，因为 `Seize` 等输入行为需要与目标应用保持相同权限级别。Neovim 本身
保持普通权限。

没有控制器配置时，运行任务会自动打开选择器
也可以在 `interface.json/jsonc` 或 Pipeline 文件中使用 `:MaaPipelineSelectController`

## 截图

在 `interface.json/jsonc` 或 Pipeline 文件中执行 `:MaaPipelineScreenshot`，
选择控制器后在 ImageCropper 中裁剪，再按提示输入图片名称。在
ImageCropper 中按 `S` 保存裁剪图，或按 `R`/`C` 只复制 ROI。裁剪图会
保存到当前资源的 `debug/screenshot`，选中的 ROI 会写入系统剪贴板。原
始截图通过上游 Maa server 与 MaaFramework SDK 完成。

## 架构

- Neovim 运行 Lua 客户端，并启动内置的 Node.js LSP 服务端。
- LSP 服务端使用 `@nekosu/maa-pipeline-manager` 解析项目，并启动独立的
  `maa-runtime` 子进程。
- `maa-runtime` 使用 `@nekosu/maa-server` 创建控制器、资源和任务实例，
  并启动 `interface.json` 里声明的外置 agent。
- 运行日志中，`<-- 方法` 表示 Neovim 调用 Maa runtime，`--> 方法` 表示
  Maa runtime 反向调用 Neovim。
