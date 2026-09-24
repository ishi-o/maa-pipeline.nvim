local methods = {
  trigger_completion = "maa-pipeline/triggerCompletion",
  show_references = "maa-pipeline/showReferences",
  show_text = "maa-pipeline/showText",
  launch_task = "maa-pipeline/launchTask",
  request_input = "maa-pipeline/requestInput",
}

return {
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
  [methods.launch_task] = function()
    vim.notify(
      "Override the maa-pipeline/launchTask handler with vim.lsp.config() to run Maa tasks",
      vim.log.levels.WARN
    )
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
