local M = {}

local help = require("maa-pipeline.log.help")
local keymap = require("maa-pipeline.log.keymap")

local buffer_name = "maa-pipeline://runtime"
local namespace = vim.api.nvim_create_namespace("maa_pipeline_log")

local state = {
  entries = {},
  filter = {},
  line_entries = {},
  line_tokens = {},
  line_kinds = {},
}

local render

local family_hl = {
  Task = "MaaPipelineLogTask",
  Node = "MaaPipelineLogNode",
  Next = "MaaPipelineLogNext",
  Reco = "MaaPipelineLogReco",
  Action = "MaaPipelineLogAction",
  Loading = "MaaPipelineLogLoading",
  Freeze = "MaaPipelineLogFreeze",
  Ctrl = "MaaPipelineLogCtrl",
  Plain = "MaaPipelineLogPlain",
}

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

local function contains(list, value)
  return #list == 0 or vim.tbl_contains(list, value)
end

local function matches(entry, filter)
  if type(filter) == "function" then
    local ok, result = pcall(filter, entry)
    return ok and result == true
  end

  filter = filter or {}
  if filter.source and not contains(filter.source, entry.source) then
    return false
  end
  if filter.family and not contains(filter.family, entry.family or "Plain") then
    return false
  end
  if filter.phase and not contains(filter.phase, entry.phase or "") then
    return false
  end
  if filter.algorithm and not contains(filter.algorithm, field(entry.reco, "algorithm") or "") then
    return false
  end
  if filter.taskId ~= nil and field(entry.ids, "taskId") ~= filter.taskId then
    return false
  end
  if filter.name then
    local name = field(entry, "name")
    if not name or not name:lower():find(filter.name:lower(), 1, true) then
      return false
    end
  end
  if filter.level and not contains(filter.level, entry.level or "info") then
    return false
  end
  if filter.text then
    local raw = entry.raw or ""
    if not raw:lower():find(filter.text:lower(), 1, true) then
      return false
    end
  end
  return true
end

local function fmt_box(box)
  return "[" .. table.concat(box, ",") .. "]"
end

local function fmt_ids(entry)
  local ids = {}
  local values = {
    { key = "taskId", label = "task_id" },
    { key = "nodeId", label = "node_id" },
    { key = "recoId", label = "reco_id" },
    { key = "actionId", label = "action_id" },
    { key = "wfId", label = "wf_id" },
  }
  for _, value in ipairs(values) do
    local id = field(entry.ids, value.key)
    if id then
      table.insert(ids, string.format("%s=%s", value.label, id))
    end
  end
  return #ids > 0 and string.format(" (%s)", table.concat(ids, ", ")) or ""
end

local function segment(parts, segments, text, hl, token_kind, token_value)
  local start = #parts + 1
  table.insert(parts, text)
  table.insert(segments, {
    start = start,
    finish = #parts,
    hl = hl,
    token_kind = token_kind,
    token_value = token_value,
  })
end

local function render_header(parts, segments, entry)
  segment(parts, segments, string.format("[%s]", (entry.level or "info"):upper()))
  segment(parts, segments, " ")
  segment(
    parts,
    segments,
    string.format("[%s]", entry.source or "unknown"),
    "MaaPipelineLogSource",
    "source",
    entry.source or "unknown"
  )
  segment(parts, segments, " ")
end

local function render_name(parts, segments, name)
  segment(parts, segments, name, nil, "name", name)
  segment(parts, segments, " ")
end

local renderers = {}

function renderers.Task(context)
  local parts, segments, entry = context.parts, context.segments, context.entry
  segment(parts, segments, "[Task]", family_hl.Task)
  segment(parts, segments, " " .. context.phase)
  if context.name ~= "" then
    render_name(parts, segments, context.name)
  end
  segment(parts, segments, fmt_ids(entry))
  return parts, segments
end

function renderers.Node(context)
  local parts, segments, entry = context.parts, context.segments, context.entry
  segment(parts, segments, "[Node]", family_hl.Node)
  segment(parts, segments, " " .. context.phase)
  if context.name ~= "" then
    render_name(parts, segments, context.name)
  end
  segment(parts, segments, fmt_ids(entry))
  return parts, segments
end

function renderers.Next(context)
  local parts, segments, entry = context.parts, context.segments, context.entry
  local values = field(entry, "list") or {}
  local list = {}
  for _, item in ipairs(values) do
    table.insert(list, type(item) == "string" and item or (field(item, "name") or "?"))
  end
  segment(parts, segments, "[Next]", family_hl.Next)
  segment(parts, segments, " " .. context.phase)
  if context.name ~= "" then
    render_name(parts, segments, context.name)
    segment(parts, segments, "-> ")
  end
  segment(parts, segments, table.concat(list, ", "))
  return parts, segments
end

function renderers.Reco(context)
  local parts, segments, entry = context.parts, context.segments, context.entry
  local reco = field(entry, "reco") or {}
  local algorithm = field(reco, "algorithm") or ""
  local text = field(reco, "text")
  local score = field(reco, "score")
  local box = field(reco, "box")
  segment(parts, segments, "[Reco]", family_hl.Reco)
  segment(parts, segments, " " .. context.phase)
  if context.name ~= "" then
    render_name(parts, segments, context.name)
    segment(parts, segments, "· ")
  end
  segment(parts, segments, algorithm)
  if text then
    segment(parts, segments, " " .. string.format("%q", text))
  end
  if score then
    segment(parts, segments, " " .. tostring(score))
  end
  if box then
    segment(parts, segments, " box=" .. fmt_box(box))
  end
  segment(parts, segments, fmt_ids(entry))
  return parts, segments
end

function renderers.Action(context)
  local parts, segments, entry = context.parts, context.segments, context.entry
  local details = field(entry, "actionDetails") or {}
  local action = field(entry, "action") or field(details, "action") or ""
  local box = field(details, "box")
  segment(parts, segments, "[Action]", family_hl.Action)
  segment(parts, segments, " " .. context.phase)
  if action ~= "" then
    segment(parts, segments, action)
  end
  if box then
    segment(parts, segments, " box=" .. fmt_box(box))
  end
  segment(parts, segments, fmt_ids(entry))
  return parts, segments
end

function renderers.Ctrl(context)
  local parts, segments, entry = context.parts, context.segments, context.entry
  local action = field(entry, "action") or context.name
  segment(parts, segments, "[Ctrl]", family_hl.Ctrl)
  segment(parts, segments, " ")
  if action ~= "" then
    segment(parts, segments, action, nil, "name", action)
  end
  segment(parts, segments, fmt_ids(entry))
  return parts, segments
end

function renderers.Loading(context)
  local parts, segments, entry = context.parts, context.segments, context.entry
  local path = field(entry, "entry") or field(entry, "name") or ""
  segment(parts, segments, "[Loading]", family_hl.Loading)
  segment(parts, segments, " " .. context.phase)
  segment(parts, segments, "Bundle " .. path)
  return parts, segments
end

function renderers.Freeze(context)
  local parts, segments, entry = context.parts, context.segments, context.entry
  local elapsed = field(entry, "elapsed")
  segment(parts, segments, "[Freeze]", family_hl.Freeze)
  segment(parts, segments, " " .. context.phase)
  if context.name ~= "" then
    render_name(parts, segments, context.name)
  end
  if elapsed then
    segment(parts, segments, string.format("elapsed=%sms", elapsed))
  end
  segment(parts, segments, fmt_ids(entry))
  return parts, segments
end

function renderers.Plain(context)
  local parts, segments = context.parts, context.segments
  segment(parts, segments, "[Plain]", family_hl.Plain)
  segment(parts, segments, " " .. context.phase)
  if context.name ~= "" then
    segment(parts, segments, context.name)
  end
  return parts, segments
end

local function render_entry(entry)
  local parts = {}
  local segments = {}
  render_header(parts, segments, entry)

  if entry.kind == "plain" then
    local body = entry.raw:gsub("^%[.-%]%s*", "")
    segment(parts, segments, "[Plain]", family_hl.Plain)
    segment(parts, segments, " ")
    segment(parts, segments, body)
    return parts, segments
  end

  local family = entry.family or "Plain"
  local context = {
    entry = entry,
    parts = parts,
    segments = segments,
    phase = entry.phase and (entry.phase .. " ") or "",
    name = field(entry, "name") or field(entry, "entry") or "",
  }
  return renderers[family](context)
end

local function render_entry_details(entry)
  local lines = {}
  local details = field(entry, "details")
  if details then
    local ok, encoded = pcall(vim.json.encode, details)
    table.insert(lines, ok and encoded or vim.inspect(details))
  end
  local list = field(entry, "list")
  if list then
    table.insert(lines, "NextList:")
    for _, item in ipairs(list) do
      table.insert(lines, vim.inspect(item))
    end
  end
  local nested = field(entry, "nested")
  if nested then
    table.insert(lines, "Nested recognizers:")
    for _, nested_entry in ipairs(nested) do
      table.insert(lines, table.concat(render_entry(nested_entry), ""))
    end
  end
  return lines
end

local default_render = { render = render_entry, render_details = render_entry_details }

local function configure_window(win)
  local window = vim.wo[win]
  window.foldmethod = "expr"
  window.foldexpr = "v:lua.require('maa-pipeline.log').foldexpr()"
  window.foldlevel = 0
  window.foldenable = true
end

local function make_filter(expression)
  local factory, factory_error = load(
    string.format(
      [[
return function(entry)
  local level, source, family, phase, name, raw, kind = entry.level, entry.source, entry.family, entry.phase, entry.name, entry.raw, entry.kind
  local ids = entry.ids
  local taskId = ids and ids.taskId
  local nodeId = ids and ids.nodeId
  local recoId = ids and ids.recoId
  local actionId = ids and ids.actionId
  local wfId = ids and ids.wfId
  local reco = entry.reco
  local algorithm = reco and reco.algorithm
  local text = reco and reco.text
  local score = reco and reco.score
  local box = reco and reco.box
  local action = entry.action
  local actionDetails = entry.actionDetails
  local details = entry.details
  local list = entry.list
  local nested = entry.nested
  local elapsed = entry.elapsed
  return %s
end
]],
      expression
    ),
    "MaaPipelineLogFilter"
  )
  if not factory then
    return nil, factory_error
  end
  local ok, filter = pcall(factory)
  if not ok or type(filter) ~= "function" then
    return nil, "invalid filter"
  end
  return filter
end

function M.filter_help()
  help.show_filter()
end

function M.keymap_help()
  help.show_buffer()
end

local function ensure_buffer(client_id)
  local buffer = vim.fn.bufnr(buffer_name)
  if buffer < 0 then
    buffer = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(buffer, buffer_name)
    vim.bo[buffer].buftype = "nofile"
    vim.bo[buffer].bufhidden = "hide"
    vim.bo[buffer].swapfile = false
    vim.bo[buffer].filetype = "log"
    vim.api.nvim_create_autocmd("BufWinEnter", {
      buffer = buffer,
      callback = function()
        configure_window(vim.api.nvim_get_current_win())
      end,
    })
    keymap.setup(buffer, {
      click_filter = M.click_filter,
      filter = M.filter,
      filter_help = M.filter_help,
      keymap_help = M.keymap_help,
    })
  end
  vim.b[buffer].maa_pipeline_client_id = client_id
  vim.cmd("highlight default link MaaPipelineLogSource Title")
  for _, highlight in pairs(family_hl) do
    local target = highlight == "MaaPipelineLogTask" and "Title"
      or highlight == "MaaPipelineLogNode" and "Identifier"
      or highlight == "MaaPipelineLogNext" and "Statement"
      or highlight == "MaaPipelineLogReco" and "Type"
      or highlight == "MaaPipelineLogAction" and "Function"
      or highlight == "MaaPipelineLogLoading" and "Special"
      or highlight == "MaaPipelineLogFreeze" and "PreProc"
      or highlight == "MaaPipelineLogCtrl" and "Constant"
      or "Normal"
    vim.cmd(string.format("highlight default link %s %s", highlight, target))
  end
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

local function append_line(buffer, entry, line, parts, segments, line_kind)
  local count = vim.api.nvim_buf_line_count(buffer)
  local start = count
  local finish = count
  if count == 1 and vim.api.nvim_buf_get_lines(buffer, 0, 1, false)[1] == "" then
    start = 0
    finish = 1
  end
  local row = start + 1
  state.line_entries[row] = entry
  state.line_kinds[row] = line_kind
  state.line_tokens[row] = nil
  vim.bo[buffer].modifiable = true
  vim.api.nvim_buf_set_lines(buffer, start, finish, false, { line })
  vim.bo[buffer].modifiable = false

  local tokens = {}
  for _, seg in ipairs(segments) do
    if seg.hl then
      local col_start, col_end = byte_range(parts, seg.start, seg.finish)
      vim.api.nvim_buf_add_highlight(buffer, namespace, seg.hl, start, col_start, col_end)
    end
    if seg.token_kind and seg.token_value then
      local col_start, col_end = byte_range(parts, seg.start, seg.finish)
      table.insert(tokens, {
        kind = seg.token_kind,
        value = seg.token_value,
        start = col_start,
        finish = col_end,
      })
    end
  end
  if #tokens > 0 then
    state.line_tokens[row] = tokens
  end
  return row
end

local function append_entry(buffer, entry)
  local parts, segments = render.render(entry)
  local details = render.render_details and render.render_details(entry) or {}
  local line_kind = #details > 0 and "entry" or "plain"
  append_line(buffer, entry, table.concat(parts, ""), parts, segments, line_kind)
  for _, detail in ipairs(details) do
    append_line(buffer, nil, detail, { detail }, {}, "detail")
  end
end

local function show_buffer(buffer)
  if vim.fn.bufwinid(buffer) >= 0 then
    return
  end
  vim.cmd("botright 10split")
  vim.api.nvim_win_set_buf(0, buffer)
  configure_window(0)
end

function M.use(new_render)
  render = new_render or default_render
end

function M.set_keys(new_keys)
  keymap.set(new_keys)
end

function M.set_fold_keys(fold_keys)
  keymap.set(fold_keys)
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
  append_entry(buffer, entry)
  show_buffer(buffer)
end

function M.set_filter(filter)
  state.filter = filter or {}
  local buffer = ensure_buffer(0)
  vim.bo[buffer].modifiable = true
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, {})
  vim.bo[buffer].modifiable = false
  vim.api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
  state.line_entries = {}
  state.line_tokens = {}
  state.line_kinds = {}
  for _, entry in ipairs(state.entries) do
    pcall(function()
      if matches(entry, state.filter) then
        append_entry(buffer, entry)
      end
    end)
  end
end

function M.foldexpr()
  local kind = state.line_kinds[vim.v.lnum]
  if kind == "entry" then
    return ">1"
  end
  if kind == "detail" then
    return "1"
  end
  return "0"
end

function M.filter(expression)
  if expression == nil then
    vim.ui.input({ prompt = "Lua log filter (<?> for help): " }, function(input)
      if input == nil then
        return
      end
      if input:match("^%s*%?%s*$") then
        M.filter_help()
        return
      end
      M.filter(input)
    end)
    return
  end
  if expression:match("^%s*$") then
    M.set_filter({})
    return
  end
  local filter, err = make_filter(expression)
  if not filter then
    vim.notify(err or "invalid filter", vim.log.levels.ERROR)
    return
  end
  M.set_filter(filter)
end

function M.click_filter()
  local row, col = unpack(vim.api.nvim_win_get_cursor(0))
  local tokens = state.line_tokens[row] or {}
  for _, token in ipairs(tokens) do
    if col >= token.start and col < token.finish then
      if token.kind == "source" then
        M.set_filter(function(value)
          return value.source == token.value
        end)
      elseif token.kind == "taskId" then
        local task_id = tonumber(token.value)
        M.set_filter(function(value)
          return field(value.ids, "taskId") == task_id
        end)
      elseif token.kind == "name" then
        M.set_filter(function(value)
          return field(value, "name") == token.value
        end)
      end
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
        table.insert(lines, table.concat(render.render(entry), ""))
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

M.use(default_render)

return M
