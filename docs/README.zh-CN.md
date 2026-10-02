# maa-pipeline.nvim

中文 | [English](https://github.com/ishi-o/maa-pipeline.nvim/blob/main/docs/README.md)

基于 [Maa Support Extension](https://github.com/neko-para/maa-support-extension)
中的解析器和索引，为 Neovim 提供 MaaFramework Pipeline 支持

## 功能

- LSP 功能：补全、悬停提示、跳转与引用、诊断、Code Lens、代码操作、内联提示、文档链接、工作区符号和颜色支持
- Maa JSON/JSONC Pipeline 的文件类型检测
- 直接运行 MaaFramework 任务
- 运行日志支持原生 `ft=log` 高亮、来源和类型高亮、Lua 过滤、折叠、JSON 或文本导出
- 使用 ImageCropper 进行截图裁剪

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
require("maa-pipeline.nvim").setup({
  stop_hotkey = nil, -- 注册停止全局热键；为 nil 时不注册
  log = {
    key = {
      click = "<CR>", -- 按光标处来源、任务 ID 或名称过滤；false 或 "" 表示不注册
      filter = "f", -- 输入 Lua 过滤表达式；false 或 "" 表示不注册
      help = "?", -- 查看过滤帮助；false 或 "" 表示不注册
      keymap = "g?", -- 查看当前缓冲区快捷键；false 或 "" 表示不注册
      close = "zc", -- 折叠光标处条目；false 或 "" 表示不注册
      open = "zv", -- 展开光标处条目；false 或 "" 表示不注册
    },
    render = nil, -- 自定义渲染，见“深入”
  },
})

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

Windows 下 `maa-runtime` 会始终以管理员权限启动，因为 `Seize` 等输入行为需要与
目标应用保持相同权限级别，Neovim 本身保持普通权限

## 命令

| 命令 | 说明 |
| --- | --- |
| `:MaaPipelineSelectController` | 选择并配置 Maa 控制器 |
| `:MaaPipelineStop` | 停止正在运行的 Maa 任务 |
| `:MaaPipelineRun` | 运行光标所在的 Maa 任务 |
| `:MaaPipelineScreenshot` | 选择控制器、截图、裁剪，并保存图片或复制 ROI |
| `:MaaPipelineLogFilter [expression]` | 使用 Lua 表达式过滤运行日志；空表达式清除过滤 |
| `:MaaPipelineLogExportJson` | 将过滤后的运行日志导出为 JSON |
| `:MaaPipelineLogExportText` | 将过滤后的运行日志导出为纯文本 |

## 代码操作

| 操作 | 说明 |
| --- | --- |
| `Run Maa task` | 运行光标所在任务 |
| `Select Maa controller` | 选择 `interface.json/jsonc` 中声明的控制器 |
| `ScreenShot` | 截图并裁剪 |
| `Extract locale` | 将可本地化的任务引用移动到本地化文件 |

## 进阶

### 日志过滤

在运行日志缓冲区按 `f`，输入 Lua 表达式，留空清除，输入 `?` 查看帮助。表达式里字段可直接使用，不需要 `entry.` 前缀：

```lua
level == "error"
level == "error" or level == "warn"
family == "Reco"
taskId == 3
algorithm == "TemplateMatch"
name and name:lower():find("startup", 1, true)
raw and raw:find("recognition", 1, true)
```

可用字段：`level`、`source`、`family`、`phase`、`name`、`raw`、`kind`、`ids`、`taskId`、`nodeId`、`recoId`、`actionId`、`wfId`、`reco`、`algorithm`、`text`、`score`、`box`、`action`、`actionDetails`、`details`、`list`、`nested`、`elapsed`，以及原始的 `entry`

### 自定义渲染

```lua
require("maa-pipeline.nvim").setup({
  log = {
    render = {
      render = function(entry)
        return { entry.raw or "" }, {}
      end,
      render_details = function(entry)
        return { vim.inspect(entry.details) }
      end,
    },
  },
})
```

也可以直接调用：

```lua
require("maa-pipeline.log").use({
  render = function(entry)
    return { entry.raw or "" }, {}
  end,
  render_details = function(entry)
    return { vim.inspect(entry.details) }
  end,
})
```

## 架构

- Neovim 运行 Lua 客户端，并启动内置的 Node.js LSP 服务端
- LSP 服务端使用 `@nekosu/maa-pipeline-manager` 解析项目，并启动独立的
  `maa-runtime` 子进程
- `maa-runtime` 使用 `@nekosu/maa-server` 创建控制器、资源和任务实例，
  并启动 `interface.json` 里声明的外置 agent
