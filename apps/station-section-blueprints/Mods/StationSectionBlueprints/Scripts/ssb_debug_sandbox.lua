-- Optional debug-only sandbox helper (loaded ONLY when SSB_DEBUG_SANDBOX=1 via start-debug.ps1 -EnableDebugSandbox).
-- Excluded from release packages by scripts/package.ps1. Never runs during normal gameplay.

local native = require("ssb_native")

local M = {}
local runtime = _G.__StationSectionBlueprintsDebugSandbox
if not runtime then
    runtime = { registered = false }
    _G.__StationSectionBlueprintsDebugSandbox = runtime
end

local function log(message)
    print("[StationSectionBlueprints DebugSandbox] " .. tostring(message) .. "\n")
end

local function is_live(object)
    if not native.is_valid(object) then return false end
    local flags = (EObjectFlags and (EObjectFlags.RF_ClassDefaultObject | EObjectFlags.RF_ArchetypeObject)) or 0
    if flags ~= 0 then
        local ok, flagged = pcall(function() return object:HasAnyFlags(flags) end)
        if not ok or flagged == true then return false end
    end
    return true
end

local function find_local_controller()
    if type(FindAllOf) ~= "function" then return nil, "FindAllOf_unavailable" end
    local ok, controllers = pcall(FindAllOf, "DMSPlayerController")
    if not ok or type(controllers) ~= "table" then return nil, "controller_scan_failed" end
    local candidates = {}
    for _, pc in ipairs(controllers) do
        if is_live(pc) then
            local loc_ok, is_local = pcall(function() return pc:IsLocalController() end)
            if loc_ok and is_local == true then
                candidates[#candidates + 1] = pc
            end
        end
    end
    if #candidates == 0 then
        for _, pc in ipairs(controllers) do
            if is_live(pc) then candidates[#candidates + 1] = pc end
        end
    end
    if #candidates ~= 1 then return nil, "controller_not_unique:" .. tostring(#candidates) end
    return candidates[1]
end

local function find_local_player()
    if type(FindAllOf) ~= "function" then return nil end
    local ok, players = pcall(FindAllOf, "BP_PlayerObject_C")
    if not ok or type(players) ~= "table" then return nil end
    for _, player in ipairs(players) do
        if is_live(player) then
            local loc_ok, is_local = pcall(function() return player.bLocal end)
            if loc_ok and is_local == true then return player end
        end
    end
    return nil
end

function M.toggle_creative()
    local pc, err = find_local_controller()
    if not pc then
        log("toggle_creative skipped: " .. tostring(err))
        return false, err
    end
    local player = find_local_player()
    local current = false
    if player then
        local ok_read, val = pcall(function() return player.bCreative end)
        if ok_read and type(val) == "boolean" then current = val end
    end
    local next_state = not current
    local ok_call, call_err = pcall(function()
        pc:SetCreativeMode(next_state)
    end)
    if not ok_call then
        log("SetCreativeMode failed: " .. tostring(call_err))
        return false, call_err
    end
    log("SetCreativeMode(" .. tostring(next_state) .. ") dispatched (takes effect next simulation tick)")
    return true, next_state
end

function M.unlock_all_research()
    local pc, err = find_local_controller()
    if not pc then
        log("unlock_all_research skipped: " .. tostring(err))
        return false, err
    end
    local ok_call, call_err = pcall(function()
        pc:SetCreativeUnlockAllResearch()
    end)
    if not ok_call then
        log("SetCreativeUnlockAllResearch failed: " .. tostring(call_err))
        return false, call_err
    end
    log("SetCreativeUnlockAllResearch() dispatched (takes effect next simulation tick)")
    return true
end

function M.start()
    if runtime.registered then return true end
    if type(RegisterKeyBind) ~= "function" or type(Key) ~= "table" or type(Key.F9) ~= "number" then
        log("RegisterKeyBind or Key.F9 unavailable")
        return false
    end
    local ok1, err1 = pcall(RegisterKeyBind, Key.F9, function()
        ExecuteInGameThread(function() M.toggle_creative() end)
    end)
    if not ok1 then
        log("F9 bind failed: " .. tostring(err1))
        return false
    end
    if type(ModifierKey) == "table" and type(ModifierKey.SHIFT) == "number" then
        local ok2, err2 = pcall(RegisterKeyBind, Key.F9, { ModifierKey.SHIFT }, function()
            ExecuteInGameThread(function() M.unlock_all_research() end)
        end)
        if not ok2 then
            log("Shift+F9 bind failed: " .. tostring(err2))
        end
    end
    runtime.registered = true
    log("Debug sandbox hotkeys active: F9 = toggle native Creative Mode, Shift+F9 = unlock all research")
    return true
end

return M
