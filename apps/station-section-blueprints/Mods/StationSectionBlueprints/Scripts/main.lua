local source = debug.getinfo(1, "S").source
local directory = source:match("^@(.*[/\\])") or ""
package.path = directory .. "?.lua;" .. package.path

local function load_module(name)
    local chunk, compile_error = loadfile(directory .. name .. ".lua", "t")
    if not chunk then
        error(compile_error)
    end
    local module = chunk()
    package.loaded[name] = module
    return module
end

local native = load_module("ssb_native")
load_module("ssb_library")
local designer_native = load_module("ssb_native_designer")
local store_module = load_module("ssb_store")
local ui = load_module("ssb_ui")
local development_command_file = os.getenv("SSB_DEV_COMMAND_FILE")
local development = development_command_file ~= nil and development_command_file ~= ""
local store
local attached
local failed_hud

local function find_hud()
    local session = designer_native.find_session()
    if session then
        return session.hud
    end

    local found = {}
    ForEachUObject(function(object)
        if native.class_name(object) ~= "WBP_DesignerHUD_C" then
            return
        end
        local full_name = native.full_name(object)
        if full_name:find("Default__", 1, true) or not full_name:find("GameInstance", 1, true) then
            return
        end
        found[object:GetAddress()] = object
    end)
    local hud
    for _, object in pairs(found) do
        if hud then
            return nil, "multiple_designer_huds"
        end
        hud = object
    end
    return hud
end

local function try_attach()
    local hud = find_hud()
    if not native.is_valid(hud) then
        if attached then
            ui.detach(attached)
            attached = nil
        end
        failed_hud = nil
        return
    end
    if attached then
        local same_hud = attached.hud:GetAddress() == hud:GetAddress()
        local same_tree = native.is_valid(attached.widget_tree)
            and attached.widget_tree:GetAddress() == hud.WidgetTree:GetAddress()
        if same_hud and same_tree and native.is_valid(attached.library_button) then
            return
        end
        ui.detach(attached)
        attached = nil
    end
    if failed_hud == hud:GetAddress() then
        return
    end
    local designer = designer_native.find_designer()
    if not native.is_valid(designer) then
        return
    end
    if not store then
        local opened, open_error = store_module.open({ development = development })
        if not opened then
            failed_hud = hud:GetAddress()
            print("[StationSectionBlueprints] Blueprint library open failed: " .. tostring(open_error) .. "\n")
            return
        end
        store = opened
    end
    local attach_ok, state, attach_error = pcall(ui.attach, hud, designer, store_module, store)
    if not attach_ok then
        state, attach_error = nil, state
    end
    if not state then
        failed_hud = hud:GetAddress()
        print("[StationSectionBlueprints] UI attach failed: " .. tostring(attach_error) .. "\n")
        return
    end
    attached = state
    print("[StationSectionBlueprints] Native designer UI attached\n")
end

local function poll()
    ExecuteInGameThread(function()
        local ok, err = xpcall(try_attach, debug.traceback)
        if not ok then
            print("[StationSectionBlueprints] UI update failed: " .. tostring(err) .. "\n")
        end
    end)
    ExecuteWithDelay(2000, poll)
end

if os.getenv("SSB_DISABLE_UI") ~= "1" then
    poll()
end

if os.getenv("SSB_PROBE_ON_START") == "1" then
    ExecuteWithDelay(5000, function()
        ExecuteInGameThread(function()
            local ok, err = xpcall(load_module("ssb_probe").run, debug.traceback)
            if not ok then
                print("[StationSectionBlueprints] Probe failed: " .. tostring(err) .. "\n")
            end
        end)
    end)
end

if os.getenv("SSB_ENTER_DESIGNER") == "1" then
    ExecuteWithDelay(7000, function()
        ExecuteInGameThread(function()
            local ok, err = xpcall(load_module("ssb_designer_probe").run, debug.traceback)
            if not ok then
                print("[StationSectionBlueprints] Designer development entry failed: " .. tostring(err) .. "\n")
            end
        end)
    end)
end

if development then
    load_module("ssb_dev_runner").start(development_command_file)
end

print("[StationSectionBlueprints] Loaded native section blueprint library\n")
