local M = {}

local ffi = require("ffi")
local uv = vim.uv
local registered = false
local timer

ffi.cdef([[
  typedef struct { long x; long y; } POINT;
  typedef struct { void *hwnd; unsigned int message; unsigned long long wParam; unsigned long long lParam;
    unsigned long time; POINT pt; unsigned long lPrivate; } MSG;
  int RegisterHotKey(void *hwnd, int id, unsigned int modifiers, unsigned int key);
  int UnregisterHotKey(void *hwnd, int id);
  int PeekMessageW(MSG *message, void *hwnd, unsigned int min, unsigned int max, unsigned int remove);
  int TranslateMessage(const MSG *message);
  long DispatchMessageW(const MSG *message);
]])

local key_codes = {
  A = 0x41, B = 0x42, C = 0x43, D = 0x44, E = 0x45, F = 0x46,
  G = 0x47, H = 0x48, I = 0x49, J = 0x4A, K = 0x4B, L = 0x4C,
  M = 0x4D, N = 0x4E, O = 0x4F, P = 0x50, Q = 0x51, R = 0x52,
  S = 0x53, T = 0x54, U = 0x55, V = 0x56, W = 0x57, X = 0x58,
  Y = 0x59, Z = 0x5A,
}
for index = 1, 24 do
  key_codes["F" .. index] = 0x6F + index
end
for index = 0, 9 do
  key_codes[tostring(index)] = 0x30 + index
end

local function parse(spec)
  local modifiers = 0
  local key
  for part in spec:upper():gmatch("[^+]+") do
    if part == "CTRL" then
      modifiers = modifiers | 0x2
    elseif part == "ALT" then
      modifiers = modifiers | 0x1
    elseif part == "SHIFT" then
      modifiers = modifiers | 0x4
    elseif key_codes[part] then
      key = key_codes[part]
    else
      return nil
    end
  end
  return modifiers, key
end

function M.register(spec, callback)
  if not spec or jit.os ~= "Windows" then
    return false
  end
  local modifiers, key = parse(spec)
  if not key or registered then
    return false
  end
  registered = ffi.C.RegisterHotKey(nil, 1, modifiers, key) ~= 0
  if not registered then
    return false
  end

  local message = ffi.new("MSG[1]")
  timer = uv.new_timer()
  timer:start(50, 50, function()
    while ffi.C.PeekMessageW(message, nil, 0x0312, 0x0312, 1) ~= 0 do
      ffi.C.TranslateMessage(message[0])
      ffi.C.DispatchMessageW(message[0])
      vim.schedule(callback)
    end
  end)
  return true
end

function M.unregister()
  if timer then
    timer:stop()
    timer:close()
    timer = nil
  end
  if registered then
    ffi.C.UnregisterHotKey(nil, 1)
    registered = false
  end
end

return M
