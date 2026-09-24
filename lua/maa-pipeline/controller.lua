local M = {}

local function notify_error(error)
  vim.notify(error and (error.message or tostring(error)) or "Controller selection failed", vim.log.levels.ERROR)
end

local function request(client, command, arguments, callback)
  client:request("workspace/executeCommand", {
    command = command,
    arguments = arguments,
  }, function(error, result)
    vim.schedule(function()
      if error then
        notify_error(error)
        return
      end
      callback(result)
    end)
  end)
end

local function fill_fields(fields, index, values, done)
  local field = fields[index]
  if not field then
    done(values)
    return
  end
  if field.items then
    vim.ui.select(field.items, {
      prompt = field.label,
      format_item = function(item)
        return item.label
      end,
    }, function(item)
      if not item then
        return
      end
      values[field.key] = item.value
      fill_fields(fields, index + 1, values, done)
    end)
  else
    vim.ui.input({ prompt = field.label .. ": ", default = field.default }, function(value)
      if value == nil or (field.required and value == "") then
        return
      end
      if value ~= "" then
        if field.number then
          local number = tonumber(value)
          if not number then
            vim.notify(field.label .. " must be a number", vim.log.levels.WARN)
            fill_fields(fields, index, values, done)
            return
          end
          values[field.key] = number
        else
          values[field.key] = value
        end
      end
      fill_fields(fields, index + 1, values, done)
    end)
  end
end

local function configure(client, root, controller, after)
  request(client, "maa-pipeline.discoverController", { root, controller.name }, function(result)
    if not result then
      return
    end
    local save = function(config)
      request(client, "maa-pipeline.configureController", { root, controller.name, config }, function(saved)
        if saved and after then
          after()
        end
      end)
    end
    if result.items then
      if #result.items == 0 then
        vim.notify("No matching Maa controller target was found", vim.log.levels.WARN)
        return
      end
      vim.ui.select(result.items, {
        prompt = "Select " .. controller.name .. " target",
        format_item = function(item)
          return item.label
        end,
      }, function(item)
        if item then
          save(item.config)
        end
      end)
    else
      for _, field in ipairs(result.fields or {}) do
        if field.items and #field.items == 0 then
          vim.notify("No options were found for " .. field.label, vim.log.levels.WARN)
          return
        end
      end
      fill_fields(result.fields or {}, 1, {}, function(values)
        save({ [result.config_key] = values })
      end)
    end
  end)
end

function M.select(client, root, preferred, after)
  request(client, "maa-pipeline.listControllers", { root }, function(controllers)
    controllers = controllers or {}
    if preferred then
      local controller = vim.iter(controllers):find(function(item)
        return item.name == preferred
      end)
      if controller then
        configure(client, root, controller, after)
        return
      end
    end
    vim.ui.select(controllers, {
      prompt = "Select Maa controller",
      format_item = function(item)
        return string.format("%s (%s)%s", item.name, item.type or "Unknown", item.current and " *" or "")
      end,
    }, function(controller)
      if controller then
        configure(client, root, controller, after)
      end
    end)
  end)
end

return M
