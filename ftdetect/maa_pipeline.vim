augroup MaaPipelineFiletype
  au!
  au BufNewFile,BufRead *.json,*.jsonc lua require("maa-pipeline.detect").autoset(vim.api.nvim_get_current_buf())
augroup END
