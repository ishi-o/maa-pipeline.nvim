local source = debug.getinfo(1, "S").source:sub(2)
local plugin_root = vim.fn.fnamemodify(source, ":h:h")

return {
  cmd = { "node", plugin_root .. "/server/dist/maa-pipeline-lsp.mjs" },
  filetypes = { "maa-pipeline.jsonc" },
  root_markers = { "interface.json", "interface.jsonc", ".git" },
  init_options = {
    mode = "auto",
    locale = "en",
  },
}
