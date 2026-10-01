local M = {}

local buffer_name = "maa-pipeline://runtime"

local state = {
  entries = {},
  filter = {},
  expanded = {},
  line_entries = {},
  line_tokens = {},
}

local adapter

local function is_null(value)
  return value == nil or value == vim.NIL
end

local function field(object, key)
  if is_null(object) then
    return nil
  end
  local value = object[key]
  if is_null(value) then
    return nil
  end
  return value
end

local function level_hl(entry)
  local level = entry.level or "info"
  if level == "error" then
    return "logError"
  end
  if level == "warn" then
    return "logWarn"
  end
  if level == "debug" or level == "verbose" or level == "silly" or level == "http" then
    return "logDebug"
  end
  return "logInfo"
end

local function family_hl(family)
  if family == "Task" then
    return "MaaPipelineLogTask"
  end
  if family == "Node" then
    return "MaaPipelineLogNode"
  end
  if family == "Next" then
    return "MaaPipelineLogNext"
  end
  if family == "Reco" then
    return "MaaPipelineLogReco"
  end
  if family == "Action" then
    return "MaaPipelineLogAction"
  end
  if family == "Loading" then
    return "MaaPipelineLogLoading"
  end
  if family == "Freeze" then
    return "MaaPipelineLogFreeze"
  end
  if family == "Ctrl" then
    return "MaaPipelineLogCtrl"
  end
  return "MaaPipelineLogPlain"
end

local function matches(entry, filter)
  if filter.source and not vim.tbl_contains(filter.source, entry.source) then
    return false
  end
  if filter.family and not vim.tbl_contains(filter.family, entry.family or "Plain") then
    return false
  end
  if filter.phase and not vim.tbl_contains(filter.phase, entry.phase or "") then
    return false
  end
  if filter.algorithm then
    local algorithm = field(entry.reco, "algorithm") or ""
    if not vim.tbl_contains(filter.algorithm, algorithm) then
      return false
    end
  end
  if filter.taskId and field(entry.ids, "taskId") ~= filter.taskId then
    return false
  end
  if filter.name then
    local name = field(entry, "name")
    if not name or not name:lower():find(filter.name:lower(), 1, true) then
      return false
    end
  end
  if filter.level and not vim.tbl_contains(filter.level, entry.level) then
    return false
  end
  if filter.text and not entry.raw:lower():find(filter.text:lower(), 1, true) then
    return false
  end
  return true
end

local function fmt_box(box)
  return "[" .. table.concat(box, ",") .. "]"
end

local function fmt_ids(entry)
  local ids = {}
  local task_id = field(entry.ids, "taskId")
  local node_id = field(entry.ids, "nodeId")
  local reco_id = field(entry.ids, "recoId")
  local action_id = field(entry.ids, "actionId")
  local wf_id = field(entry.ids, "wfId")
  if task_id then
    table.insert(ids, string.format("task_id=%s", task_id))
  end
  if node_id then
    table.insert(ids, string.format("node_id=%s", node_id))
  end
  if reco_id then
    table.insert(ids, string.format("reco_id=%s", reco_id))
  end
  if action_id then
    table.insert(ids, string.format("action_id=%s", action_id))
  end
  if wf_id then
    table.insert(ids, string.format("wf_id=%s", wf_id))
  end
  return #ids > 0 and string.format(" (%s)", table.concat(ids, ", ")) or ""
end

local function segment(parts, segments, text, hl, token_kind, token_value)
  local start = #parts + 1
  table.insert(parts, text)
  local finish = #parts
  table.insert(segments, { start = start, finish = finish, hl = hl })
  if token_kind and token_value then
    table.insert(segments, {
      start = start,
      finish = finish,
      token = { kind = token_kind, value = token_value },
    })
  end
end

local function default_render(entry)
  local parts = {}
  local segments = {}

  local level_text = string.format("[%s]", (entry.level or "info"):upper())
  segment(parts, segments, level_text, level_hl(entry))
  segment(parts, segments, " ", "MaaPipelineLogPlain")

  local source_text = string.format("[%s]", entry.source or "unknown")
  segment(parts, segments, source_text, "MaaPipelineLogSource", "source", entry.source or "unknown")
  segment(parts, segments, " ", "MaaPipelineLogPlain")

  if entry.kind == "plain" then
    local body = entry.raw:gsub("^%[[^%]]+%]%s*", "")
    segment(parts, segments, body, "MaaPipelineLogPlain")
    return parts, segments
  end

  local family = entry.family or "Plain"
  local phase = entry.phase and string.format("%s ", entry.phase) or ""
  local name = field(entry, "name") or field(entry, "entry") or ""

  if family == "Task" then
    segment(parts, segments, string.format("[Task] %s", phase), family_hl("Task"))
    if name ~= "" then
      segment(parts, segments, name, "MaaPipelineLogPlain", "name", name)
      segment(parts, segments, " ", "MaaPipelineLogPlain")
    end
    segment(parts, segments, fmt_ids(entry), "MaaPipelineLogPlain")
    return parts, segments
  elseif family == "Node" then
    segment(parts, segments, string.format("[Node] %s", phase), family_hl("Node"))
    if name ~= "" then
      segment(parts, segments, name, "MaaPipelineLogPlain", "name", name)
      segment(parts, segments, " ", "MaaPipelineLogPlain")
    end
    segment(parts, segments, fmt_ids(entry), "MaaPipelineLogPlain")
    return parts, segments
  elseif family == "Next" then
    local list = {}
    for _, item in ipairs(entry.list or {}) do
      table.insert(list, type(item) == "string" and item or (field(item, "name") or "?"))
    end
    segment(parts, segments, string.format("[Next] %s", phase), family_hl("Next"))
    if name ~= "" then
      segment(parts, segments, name, "MaaPipelineLogPlain", "name", name)
      segment(parts, segments, " -> ", "MaaPipelineLogPlain")
    end
    segment(parts, segments, table.concat(list, ", "), "MaaPipelineLogPlain")
    return parts, segments
  elseif family == "Reco" then
    local reco = is_null(entry.reco) and nil or entry.reco
    local algo = field(reco, "algorithm") or ""
    local score = field(reco, "score")
    local text = field(reco, "text")
    local box = field(reco, "box")
    segment(parts, segments, string.format("[Reco] %s", phase), family_hl("Reco"))
    if name ~= "" then
      segment(parts, segments, name, "MaaPipelineLogPlain", "name", name)
      segment(parts, segments, " · ", "MaaPipelineLogPlain")
    end
    segment(parts, segments, algo, "MaaPipelineLogPlain")
    if text then
      segment(parts, segments, " " .. string.format("%q", text), "MaaPipelineLogPlain")
    end
    if score then
      segment(parts, segments, " " .. tostring(score), "MaaPipelineLogPlain")
    end
    if box then
      segment(parts, segments, " box=" .. fmt_box(box), "MaaPipelineLogPlain")
    end
    segment(parts, segments, fmt_ids(entry), "MaaPipelineLogPlain")
    return parts, segments
  elseif family == "Action" then
    local details = is_null(entry.actionDetails) and nil or entry.actionDetails
    local act = field(entry, "action") or field(details, "action") or ""
    local box = field(details, "box")
    segment(parts, segments, string.format("[Action] %s", phase), family_hl("Action"))
    if act ~= "" then
      segment(parts, segments, act, "MaaPipelineLogPlain")
    end
    if box then
      segment(parts, segments, " box=" .. fmt_box(box), "MaaPipelineLogPlain")
    end
    segment(parts, segments, fmt_ids(entry), "MaaPipelineLogPlain")
    return parts, segments
  elseif family == "Ctrl" then
    local act = field(entry, "action") or name
    segment(parts, segments, "[Ctrl] ", family_hl("Ctrl"))
    if act ~= "" then
      segment(parts, segments, act, "MaaPipelineLogPlain", "name", act)
    end
    segment(parts, segments, fmt_ids(entry), "MaaPipelineLogPlain")
    return parts, segments
  elseif family == "Loading" then
    local path = field(entry, "entry") or field(entry, "name") or ""
    segment(parts, segments, "[Loading] ", family_hl("Loading"))
    segment(parts, segments, "Bundle " .. path, "MaaPipelineLogPlain")
    return parts, segments
  elseif family == "Freeze" then
    segment(parts, segments, string.format("[Freeze] %s", phase), family_hl("Freeze"))
    if name ~= "" then
      segment(parts, segments, name, "MaaPipelineLogPlain", "name", name)
      segment(parts, segments, " ", "MaaPipelineLogPlain")
    end
    local elapsed = field(entry, "elapsed")
    if elapsed then
      segment(parts, segments, string.format("elapsed=%sms", elapsed), "MaaPipelineLogPlain")
    end
    segment(parts, segments, fmt_ids(entry), "MaaPipelineLogPlain")
    return parts, segments
  end
  segment(parts, segments, string.format("[Plain] %s", phase), family_hl("Plain"))
  if name ~= "" then
    segment(parts, segments, name, "MaaPipelineLogPlain")
  end
  return parts, segments
end

local function default_render_details(entry)
  local lines = {}
  local details = field(entry, "details")
  if details then
    local ok, encoded = pcall(vim.json.encode, details)
    if ok then
      table.insert(lines, encoded)
    else
      table.insert(lines, vim.inspect(details))
    end
  end
  if entry.list then
    table.insert(lines, "NextList:")
    for _, item in ipairs(entry.list) do
      table.insert(lines, "  " .. vim.inspect(item))
    end
  end
  if entry.nested then
    table.insert(lines, "Nested recognizers:")
    for _, nested_entry in ipairs(entry.nested) do
      table.insert(lines, "  " .. table.concat(default_render(nested_entry), ""))
    end
  end
  return lines
end

local default_adapter = { render = default_render, render_details = default_render_details }

local function ensure_buffer(client_id)
  local buffer = vim.fn.bufnr(buffer_name)
  if buffer < 0 then
    buffer = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(buffer, buffer_name)
    vim.bo[buffer].buftype = "nofile"
    vim.bo[buffer].bufhidden = "hide"
    vim.bo[buffer].swapfile = false
    vim.bo[buffer].filetype = "log"
    vim.api.nvim_buf_clear_namespace(buffer, -1, 0, -1)
  end
  vim.b[buffer].maa_pipeline_client_id = client_id
  vim.cmd("highlight default link MaaPipelineLogSource Normal")
  vim.cmd("highlight default link MaaPipelineLogPlain Normal")
  vim.cmd("highlight default link MaaPipelineLogTask Title")
  vim.cmd("highlight default link MaaPipelineLogNode Identifier")
  vim.cmd("highlight default link MaaPipelineLogNext Statement")
  vim.cmd("highlight default link MaaPipelineLogReco Type")
  vim.cmd("highlight default link MaaPipelineLogAction Function")
  vim.cmd("highlight default link MaaPipelineLogLoading Special")
  vim.cmd("highlight default link MaaPipelineLogFreeze PreProc")
  vim.cmd("highlight default link MaaPipelineLogCtrl Constant")
  vim.keymap.set("n", "<CR>", M.click_filter, { buffer = buffer, silent = true })
  vim.keymap.set("n", "<Tab>", M.toggle_expand, { buffer = buffer, silent = true })
  return buffer
end

local function byte_range(parts, start_index, finish_index)
  local start = 0
  for i = 1, start_index - 1 do
    start = start + #parts[i]
  end
  local finish = start
  for i = start_index, finish_index do
    finish = finish + #parts[i]
  end
  return start, finish
end

local function append_line(buffer, entry, parts, segments)
  local line = table.concat(parts, "")
  local count = vim.api.nvim_buf_line_count(buffer)
  local start = count
  local finish = count
  if count == 1 and vim.api.nvim_buf_get_lines(buffer, 0, 1, false)[1] == "" then
    start = 0
    finish = 1
  end
  vim.bo[buffer].modifiable = true
  vim.api.nvim_buf_set_lines(buffer, start, finish, false, { line })
  vim.bo[buffer].modifiable = false
  local tokens = {}
  for _, seg in ipairs(segments) do
    local col_start, col_end = byte_range(parts, seg.start, seg.finish)
    if seg.hl then
      vim.api.nvim_buf_add_highlight(buffer, -1, seg.hl, start, col_start, col_end)
    end
    if seg.token then
      table.insert(tokens, {
        kind = seg.token.kind,
        value = seg.token.value,
        start = col_start,
        finish = col_end,
      })
    end
  end
  state.line_entries[start + 1] = entry
  if #tokens > 0 then
    state.line_tokens[start + 1] = tokens
  end
end

function M.use(new_adapter)
  adapter = new_adapter or default_adapter
end

function M.append(client_id, result)
  local entry = result.entry
  if is_null(entry) then
    entry = {
      kind = "plain",
      level = result.level or "info",
      source = result.source or "maa-runtime",
      ids = {},
      raw = result.message or "",
    }
  end
  table.insert(state.entries, entry)
  if not matches(entry, state.filter) then
    return
  end

  local buffer = ensure_buffer(client_id)
  local parts, segments = adapter.render(entry)
  append_line(buffer, entry, parts, segments)
  if vim.fn.bufwinid(buffer) < 0 then
    vim.cmd("botright 10split")
    vim.api.nvim_win_set_buf(0, buffer)
  end
end

function M.set_filter(filter)
  state.filter = filter or {}
  local buffer = ensure_buffer(0)
  vim.bo[buffer].modifiable = true
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, {})
  vim.bo[buffer].modifiable = false
  state.line_entries = {}
  state.line_tokens = {}
  for _, entry in ipairs(state.entries) do
    local ok = pcall(function()
      if matches(entry, state.filter) then
        local parts, segments = adapter.render(entry)
        append_line(buffer, entry, parts, segments)
        local key = vim.inspect(entry)
        if state.expanded[key] then
          for _, detail in ipairs(adapter.render_details and adapter.render_details(entry) or {}) do
            append_line(buffer, entry, { "  " .. detail }, { { start = 1, finish = 1, hl = "MaaPipelineLogPlain" } })
          end
        end
      end
    end)
    if not ok then
      -- 单条渲染失败不中断重放
    end
  end
end

function M.toggle_expand()
  local win = vim.api.nvim_get_current_win()
  local row = vim.api.nvim_win_get_cursor(win)[1]
  local entry = state.line_entries[row]
  if not entry then
    return
  end
  local key = vim.inspect(entry)
  state.expanded[key] = not state.expanded[key]
  M.set_filter(state.filter)
  local count = vim.api.nvim_buf_line_count(0)
  local target = math.min(row, count)
  if target >= 1 then
    pcall(vim.api.nvim_win_set_cursor, win, { target, 0 })
  end
end

function M.click_filter()
  local win = vim.api.nvim_get_current_win()
  local row = vim.api.nvim_win_get_cursor(win)[1]
  local col = vim.api.nvim_win_get_cursor(win)[2]
  local entry = state.line_entries[row]
  if not entry then
    return
  end
  local tokens = state.line_tokens[row] or {}
  for _, token in ipairs(tokens) do
    if col >= token.start and col < token.finish then
      if token.kind == "source" then
        state.filter.source = { token.value }
      elseif token.kind == "taskId" then
        state.filter.taskId = tonumber(token.value)
      elseif token.kind == "name" then
        state.filter.name = token.value
      end
      M.set_filter(state.filter)
      return
    end
  end
end

function M.export(format)
  local buffer = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buffer, "maa-pipeline://runtime-export-" .. (format or "text"))
  local lines = {}
  for _, entry in ipairs(state.entries) do
    if matches(entry, state.filter) then
      if format == "json" then
        table.insert(lines, vim.json.encode(entry))
      else
        local parts = adapter.render(entry)
        table.insert(lines, table.concat(parts, ""))
      end
    end
  end
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].buftype = "nofile"
  vim.bo[buffer].bufhidden = "hide"
  vim.bo[buffer].swapfile = false
  vim.bo[buffer].filetype = format == "json" and "json" or "log"
  vim.api.nvim_set_current_buf(buffer)
end

function M.info(client_id, message)
  M.append(client_id, { level = "info", message = message, source = "maa-runtime" })
end

function M.warn(client_id, message)
  M.append(client_id, { level = "warn", message = message, source = "maa-runtime" })
end

function M.error(client_id, error, fallback)
  local message = error and (error.message or tostring(error)) or fallback
  M.append(client_id, { level = "error", message = message, source = "maa-runtime" })
end

M.use(default_adapter)

return M
