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
load_module("ssb_json")
load_module("ssb_catalog_data")
load_module("ssb_library")
local designer_native = load_module("ssb_native_designer")
load_module("ssb_docking")
local machine_paste = load_module("ssb_machine_paste")
local store_module = load_module("ssb_store")
local ui = load_module("ssb_ui")
local development_command_file = os.getenv("SSB_DEV_COMMAND_FILE")
local development = development_command_file ~= nil and development_command_file ~= ""
local store
local attached
local last_designer_ui
local failed_hud
local designer_active = false

local function find_hud()
    local session, session_error = designer_native.find_session()
    if not session then return nil, session_error end
    return session.hud
end

local function try_attach()
    local hud = find_hud()
    if not native.is_valid(hud) then
        if attached then
            last_designer_ui = attached
            ui.detach(attached)
            attached = nil
        end
        failed_hud = nil
        return
    end
    if attached then
        ui.poll(attached)
        local same_hud = attached.hud:GetAddress() == hud:GetAddress()
        local same_tree = native.is_valid(attached.widget_tree)
            and attached.widget_tree:GetAddress() == hud.WidgetTree:GetAddress()
        if same_hud and same_tree and native.is_valid(attached.library_button) then
            return
        end
        last_designer_ui = attached
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
    last_designer_ui = state
    print("[StationSectionBlueprints] Native designer UI attached\n")
end

local function poll()
    ExecuteInGameThread(function()
        local ok, err = xpcall(function()
            local session = designer_native.find_session()
            if session then
                designer_active = true
            elseif designer_active then
                local previous = attached or last_designer_ui
                if previous then
                    ui.on_designer_exit(previous)
                    ui.mount_pending_machine_bar(previous)
                end
                designer_active = false
            end
            try_attach()
            if not session and machine_paste.ready_machine_count() > 0 then
                ui.mount_pending_machine_bar(last_designer_ui)
            end
        end, debug.traceback)
        if not ok then
            print("[StationSectionBlueprints] UI update failed: " .. tostring(err) .. "\n")
        end
    end)
    ExecuteWithDelay(200, poll)
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

if os.getenv("SSB_DEBUG_SANDBOX") == "1" then
    local ok_sb, sb_mod = pcall(load_module, "ssb_debug_sandbox")
    if ok_sb and type(sb_mod) == "table" and type(sb_mod.start) == "function" then
        sb_mod.start()
    else
        print("[StationSectionBlueprints] Debug sandbox helper unavailable: " .. tostring(sb_mod) .. "\n")
    end
end

print("[StationSectionBlueprints] Loaded native section blueprint library\n")
