-- Optional debug-only sandbox helper (loaded ONLY when SSB_DEBUG_SANDBOX=1 via start-debug.ps1 -EnableDebugSandbox).
-- Excluded from release packages by scripts/package.ps1. Never runs during normal gameplay.

local native = require("ssb_native")
local designer_native = require("ssb_native_designer")
local toast = require("ssb_toast")

local M = {}

local DEBOUNCE_SECONDS = 0.30
local READBACK_DELAY_MS = 250

local runtime = _G.__StationSectionBlueprintsDebugSandbox
if not runtime then
    runtime = { registered = false, last_f9 = 0, last_f10 = 0 }
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
    -- Prefer exact leaf class BP_PlayerController_C to avoid scanning base classes or colliding with DesignerController.
    for _, cls in ipairs({ "BP_PlayerController_C", "DMSPlayerController" }) do
        local ok, controllers = pcall(FindAllOf, cls)
        if ok and type(controllers) == "table" and #controllers > 0 then
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
            if #candidates == 1 then
                return candidates[1]
            elseif #candidates > 1 then
                return nil, "controller_not_unique:" .. cls .. ":" .. tostring(#candidates)
            end
        end
    end
    return nil, "controller_not_found"
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

local function read_creative_flag(pc)
    local player = find_local_player()
    if player then
        local ok_read, val = pcall(function() return player.bCreative end)
        if ok_read and type(val) == "boolean" then return val end
    end
    if is_live(pc) then
        local ok_pc, val = pcall(function() return pc.bCreative end)
        if ok_pc and type(val) == "boolean" then return val end
    end
    return nil
end

local function debounced(field)
    local now = os.clock()
    if now - (runtime[field] or 0) < DEBOUNCE_SECONDS then
        return true
    end
    runtime[field] = now
    return false
end

function M.toggle_creative()
    local pc, err = find_local_controller()
    if not pc then
        log("toggle_creative skipped: " .. tostring(err))
        toast.show("创造模式切换", "请先加载或进入一个存档世界后再按 F9", "warn", 3.5, "debug_creative")
        return false, err
    end
    local current = read_creative_flag(pc) or false
    local next_state = not current
    local ok_call, call_err = pcall(function()
        pc:SetCreativeMode(next_state)
    end)
    if not ok_call then
        log("SetCreativeMode failed: " .. tostring(call_err))
        toast.show("创造模式切换失败", tostring(call_err), "error", 4.0, "debug_creative")
        return false, call_err
    end
    -- Also sync active Designer session's bCreativeMode if toggled while inside Station Designer.
    local session = designer_native.find_session()
    if session and native.is_valid(session.designer) then
        pcall(function() session.designer.bCreativeMode = next_state end)
    end
    log("SetCreativeMode(" .. tostring(next_state) .. ") dispatched (before=" .. tostring(current) .. ")")
    toast.show(
        "创造模式",
        next_state and "正在开启创造模式（等待下帧确认）..." or "正在关闭创造模式（等待下帧确认）...",
        "info",
        2.5,
        "debug_creative"
    )
    if type(ExecuteWithDelay) == "function" and type(ExecuteInGameThread) == "function" then
        ExecuteWithDelay(READBACK_DELAY_MS, function()
            ExecuteInGameThread(function()
                local actual = read_creative_flag(pc)
                if actual == nil then actual = next_state end
                toast.show(
                    "创造模式",
                    actual and "已开启（免材料建造；F10 可解锁全科技）" or "已关闭（恢复生存模式）",
                    actual and "success" or "warn",
                    3.5,
                    "debug_creative"
                )
            end)
        end)
    end
    return true, next_state
end

function M.unlock_all_research()
    local pc, err = find_local_controller()
    if not pc then
        log("unlock_all_research skipped: " .. tostring(err))
        toast.show("全科技解锁", "请先加载或进入一个存档世界后再按 F10", "warn", 3.5, "debug_research")
        return false, err
    end
    local ok_call, call_err = pcall(function()
        pc:SetCreativeUnlockAllResearch()
    end)
    if not ok_call then
        log("SetCreativeUnlockAllResearch failed: " .. tostring(call_err))
        toast.show("全科技解锁失败", tostring(call_err), "error", 4.0, "debug_research")
        return false, call_err
    end
    log("SetCreativeUnlockAllResearch() dispatched (takes effect next simulation tick)")
    toast.show("全科技解锁", "已解锁全部科技、配方与空间站模块（下帧生效）", "success", 3.5, "debug_research")
    return true
end

function M.start()
    if runtime.registered then return true end
    if type(RegisterKeyBind) ~= "function" or type(Key) ~= "table" or type(Key.F9) ~= "number" then
        log("RegisterKeyBind or Key.F9 unavailable")
        return false
    end
    local ok1, err1 = pcall(RegisterKeyBind, Key.F9, function()
        if debounced("last_f9") then return end
        ExecuteInGameThread(function() M.toggle_creative() end)
    end)
    if not ok1 then
        log("F9 bind failed: " .. tostring(err1))
        return false
    end
    if type(Key.F10) == "number" then
        local ok2, err2 = pcall(RegisterKeyBind, Key.F10, function()
            if debounced("last_f10") then return end
            ExecuteInGameThread(function() M.unlock_all_research() end)
        end)
        if not ok2 then
            log("F10 bind failed: " .. tostring(err2))
        end
    else
        log("Key.F10 unavailable; unlock_all_research hotkey skipped")
    end
    runtime.registered = true
    log("Debug sandbox hotkeys active: F9 = toggle native Creative Mode, F10 = unlock all research")
    return true
end

return M
