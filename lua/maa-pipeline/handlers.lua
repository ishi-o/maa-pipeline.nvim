local methods = {
  trigger_completion = "maa-pipeline/triggerCompletion",
  show_references = "maa-pipeline/showReferences",
  show_text = "maa-pipeline/showText",
  runtime_log = "maa-pipeline/runtimeLog",
  configure_controller = "maa-pipeline/configureController",
  request_input = "maa-pipeline/requestInput",
}

return {
  [methods.configure_controller] = function(_, result, ctx)
    vim.schedule(function()
      local client = vim.lsp.get_client_by_id(ctx.client_id)
      if not client then
        return
      end
      require("maa-pipeline.controller").select(client, result.root, result.controller, function()
        if result.task then
          client:request("workspace/executeCommand", {
            command = "maa-pipeline.runTask",
            arguments = { result.root, result.task },
          })
        end
      end)
    end)
  end,
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
  [methods.runtime_log] = function(_, result, ctx)
    vim.schedule(function()
      local name = "maa-pipeline://runtime"
      local buffer = vim.fn.bufnr(name)
      if buffer < 0 then
        buffer = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_buf_set_name(buffer, name)
        vim.bo[buffer].buftype = "nofile"
        vim.bo[buffer].bufhidden = "hide"
        vim.bo[buffer].swapfile = false
        vim.bo[buffer].filetype = "log"
      end
      vim.b[buffer].maa_pipeline_client_id = ctx.client_id
      local message = string.format("[%s] %s", (result.level or "info"):upper(), result.message or "")
      vim.bo[buffer].modifiable = true
      vim.api.nvim_buf_set_lines(buffer, -1, -1, false, { message })
      vim.bo[buffer].modifiable = false
      if vim.fn.bufwinid(buffer) < 0 then
        vim.cmd("botright 10split")
        vim.api.nvim_win_set_buf(0, buffer)
      end
    end)
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
