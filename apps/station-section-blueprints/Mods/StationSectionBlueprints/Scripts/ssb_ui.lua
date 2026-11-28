local native = require("ssb_native")
local designer_native = require("ssb_native_designer")
local blueprint_library = require("ssb_library")
local docking = require("ssb_docking")
local machine_paste = require("ssb_machine_paste")
local theme = require("ssb_ui_theme")
local toast = require("ssb_toast")

local M = {}

local DRAWER_WIDTH = 420
local DRAWER_HEIGHT = 620
local DRAWER_SCROLL_HEIGHT = 470

local runtime = _G.__StationSectionBlueprintsUIRuntime
if not runtime then
    runtime = { actions = {}, keybind_registered = false, machine_reports = {} }
    _G.__StationSectionBlueprintsUIRuntime = runtime
end

local ERROR_MESSAGES = {
    empty_selection = "请先在原生设计器中选择积木",
    empty_native_clipboard = "原生剪贴板没有可保存的积木",
    invalid_name = "请输入有效的蓝图名称",
    invalid_folder = "文件夹路径无效",
    missing_folder = "目标文件夹不存在",
    folder_exists = "目标文件夹已存在",
    folder_not_empty = "只能删除空文件夹",
    folder_cycle = "不能把文件夹移动到自身内部",
    missing_blueprint = "蓝图不存在或已被移除",
    native_save_failed = "游戏未能保存蓝图",
    native_load_failed = "游戏未能读取蓝图",
    native_delete_failed = "游戏未能删除蓝图文件",
    clipboard_reload_failed = "原生剪贴板未能装入蓝图",
    empty_blueprint = "蓝图中没有积木",
    placement_already_active = "请先使用原版确认或取消当前放置预览",
    blueprint_stats_mismatch = "蓝图负载与索引统计不一致，已停止粘贴",
    station_only = "局部蓝图仅支持空间站设计模式",
    blueprint_type_unavailable = "无法确认当前原生设计器类型",
}

local function log(message)
    print("[StationSectionBlueprints UI] " .. tostring(message) .. "\n")
end

local function trace(message)
    if os.getenv("SSB_DEV_COMMAND_FILE") then
        log("trace " .. tostring(message))
    end
end

local function from_text(value)
    return theme.from_text(value)
end

local function set_text(widget, value)
    return theme.set_text(widget, value)
end

local function visibility(widget, visible, mode)
    theme.set_visibility(widget, visible, mode)
end

local function set_status(state, value, tone, toast_title, toast_tag)
    if state and native.is_valid(state.status) then
        set_text(state.status, value)
        if tone then
            theme.set_text_color(state.status, theme.tone_color(tone))
        else
            theme.set_text_color(state.status, theme.PALETTE.text_secondary)
        end
    end
    log(value)
    if toast_title then
        toast.show(toast_title, value, tone or "info", 3.5, toast_tag)
    end
end

local function error_message(err)
    local key = tostring(err):match("^([^:]+)") or tostring(err)
    return ERROR_MESSAGES[key] or ("操作失败：" .. tostring(err))
end

local function dispatch_action(address, action)
    log("button press accepted once")
    ExecuteWithDelay(1, function()
        ExecuteInGameThread(function()
            if runtime.actions[address] ~= action or action.state.detached then
                return
            end
            local ok_action, action_error = xpcall(action.callback, debug.traceback)
            if not ok_action then
                set_status(action.state, "界面操作失败：" .. tostring(action_error), "error", "界面操作异常", "ssb_ui_error")
            end
        end)
    end)
end

local function dispatch_hovered()
    for address, action in pairs(runtime.actions) do
        if action.state.detached or not native.is_valid(action.widget) then
            runtime.actions[address] = nil
        elseif native.is_valid(action.widget.Button) then
            local ok, hovered = pcall(function()
                return action.widget.Button:IsHovered()
            end)
            if not ok then
                if not action.hover_failed then
                    log("native IsHovered failed: " .. tostring(hovered))
                    action.hover_failed = true
                end
            else
                action.hover_failed = false
                if hovered then
                    dispatch_action(address, action)
                end
            end
        end
    end
end

local function dispatch_designer_key(action)
    ExecuteInGameThread(function()
        if runtime.on_key then runtime.on_key(action) end
    end)
end

local function ensure_keybind()
    if runtime.keybind_registered then return true end
    local ok, err = pcall(RegisterKeyBind, Key.LEFT_MOUSE_BUTTON, function()
        ExecuteInGameThread(dispatch_hovered)
    end)
    if not ok then return nil, err end
    local bindings = {
        { key = Key.LEFT_MOUSE_BUTTON, modifiers = { ModifierKey.SHIFT }, action = "shift_left" },
        { key = Key.H, action = "lock" },
        { key = Key.MIDDLE_MOUSE_BUTTON, action = "lock" },
        { key = Key.TAB, action = "next_candidate" },
        { key = Key.TAB, modifiers = { ModifierKey.SHIFT }, action = "previous_candidate" },
        { key = Key.R, action = "rotate" },
        { key = Key.F, action = "mirror" },
        { key = Key.UP_ARROW, action = "forward" },
        { key = Key.DOWN_ARROW, action = "backward" },
        { key = Key.LEFT_ARROW, action = "left" },
        { key = Key.RIGHT_ARROW, action = "right" },
        { key = Key.PAGE_UP, action = "floor_up" },
        { key = Key.PAGE_DOWN, action = "floor_down" },
        { key = Key.RETURN, action = "confirm" },
        { key = Key.ALT or ModifierKey.ALT, action = "alt" },
    }
    for _, binding in ipairs(bindings) do
        if type(binding.key) ~= "number" then
            return nil, "missing_keybind_code:" .. tostring(binding.action)
        end
        local registered, register_error
        if binding.modifiers then
            for _, mod_key in ipairs(binding.modifiers) do
                if type(mod_key) ~= "number" then
                    return nil, "missing_modifier_code:" .. tostring(binding.action)
                end
            end
            registered, register_error = pcall(RegisterKeyBind, binding.key, binding.modifiers, function()
                dispatch_designer_key(binding.action)
            end)
        else
            registered, register_error = pcall(RegisterKeyBind, binding.key, function()
                dispatch_designer_key(binding.action)
            end)
        end
        if not registered then return nil, register_error end
    end
    runtime.keybind_registered = true
    return true
end

local function construct(state, path)
    trace("construct start " .. path)
    local widget, err = theme.construct(state.widget_tree or state.hud.WidgetTree, path)
    if not widget then return nil, err end
    trace("construct ok " .. path)
    return widget
end

local function add(state, parent, child, step, padding)
    trace("add start " .. step)
    local slot, err = theme.add_child(parent, child, padding)
    if not slot then return nil, step .. ":" .. tostring(err) end
    trace("add ok " .. step)
    return slot
end

local function mount(state, parent, child, step, padding)
    local slot, err = add(state, parent, child, step, padding)
    if not slot then
        return nil, err
    end
    state.mounted[#state.mounted + 1] = { parent = parent, child = child }
    return slot
end

local function mount_canvas(state, canvas, child, spec, step)
    local slot, err = theme.place_on_canvas(canvas, child, spec)
    if not slot then
        return nil, step .. ":" .. tostring(err)
    end
    state.mounted[#state.mounted + 1] = { parent = canvas, child = child }
    return slot
end

local function register_action(state, widget, callback)
    local address = widget:GetAddress()
    local record = { state = state, callback = callback, widget = widget }
    state.action_records[address] = record
    if state.active then
        runtime.actions[address] = record
    end
    return record
end

local function button(state, caption, callback, opts)
    trace("button create start " .. tostring(caption))
    local widget, err = theme.create_button(state.hud, state.owner, caption, opts)
    if not widget then return nil, err end
    trace("button create ok " .. tostring(caption))
    register_action(state, widget, callback)
    return widget
end

local function label(state, value, opts)
    return theme.create_text(state.hud, state.owner, state.widget_tree or state.hud.WidgetTree, value, opts)
end

local function input(state, hint)
    return theme.create_input(state.widget_tree or state.hud.WidgetTree, hint)
end

local Builder = {}
Builder.__index = Builder

function Builder.new(state, prefix)
    return setmetatable({ state = state, prefix = prefix }, Builder)
end

function Builder:fail(step, err)
    if not self.error then
        self.error = self.prefix .. "/" .. tostring(step) .. ":" .. tostring(err)
    end
    return nil
end

function Builder:make(path, step)
    if self.error then return nil end
    local widget, err = construct(self.state, path)
    if not widget then return self:fail(step, err) end
    return widget
end

function Builder:label(value, step, opts)
    if self.error then return nil end
    local widget, err = label(self.state, value, opts)
    if not widget then return self:fail(step, err) end
    return widget
end

function Builder:input(hint, step)
    if self.error then return nil, nil end
    local frame, field_or_err = input(self.state, hint)
    if not frame then return self:fail(step, field_or_err), nil end
    return frame, field_or_err
end

function Builder:button(caption, callback, step, opts)
    if self.error then return nil end
    local widget, err = button(self.state, caption, callback, opts)
    if not widget then return self:fail(step, err) end
    return widget
end

function Builder:divider(step)
    if self.error then return nil end
    local widget, err = theme.create_divider(self.state.widget_tree or self.state.hud.WidgetTree)
    if not widget then return self:fail(step, err) end
    return widget
end

function Builder:add(parent, child, step, padding)
    if self.error then return nil end
    local slot, err = add(self.state, parent, child, self.prefix .. "/" .. step, padding)
    if not slot then return self:fail("add", err) end
    return slot
end

function Builder:finish(widget)
    if self.error then return nil, self.error end
    return widget
end

local function close_drawer(state)
    if not state then return end
    state.drawer_open = false
    state.drawer_mode = nil
    visibility(state.drawer, false)
    visibility(state.save_form, false)
    visibility(state.library_panel, false)
end

local function open_drawer(state, mode)
    if not state or not native.is_valid(state.drawer) then
        return nil, "missing_drawer"
    end
    state.drawer_open = true
    state.drawer_mode = mode
    local is_save = mode == "save"
    visibility(state.save_form, is_save)
    visibility(state.library_panel, not is_save)
    if native.is_valid(state.drawer_title) then
        set_text(state.drawer_title, is_save and "保存局部蓝图" or "局部蓝图库")
    end
    visibility(state.drawer, true, theme.VISIBILITY.Visible)
    return true
end

local function parent_folder(folder)
    if folder == "" then return "" end
    return folder:match("^(.*)/[^/]+$") or ""
end

local refresh_library
local start_paste

local function select_blueprint(state, entry)
    state.selected_id = entry.id
    state.confirm_delete = nil
    set_text(state.selected_label, string.format("%s  (%d 积木 / %d 机器)", entry.name, entry.blocks, entry.machines))
    set_text(state.rename_input, entry.name)
    set_text(state.move_input, entry.folder)
    set_text(state.delete_button, "删除蓝图")
    visibility(state.details_card, true)
end

local function refresh_details(state)
    local entry = state.selected_id and state.store.library.entries[state.selected_id] or nil
    if not entry then
        state.selected_id = nil
        visibility(state.details_card, false)
        return
    end
    set_text(state.selected_label, string.format("%s  (%d 积木 / %d 机器)", entry.name, entry.blocks, entry.machines))
    visibility(state.details_card, true)
end

local function pool_button(state, caption, callback)
    state.list_refresh_index = state.list_refresh_index + 1
    local index = state.list_refresh_index
    local existing = state.list_pool[index]
    if existing and native.is_valid(existing.widget) then
        existing.record.callback = callback
        set_text(existing.widget, caption)
        visibility(existing.widget, true, theme.VISIBILITY.Visible)
        return existing.widget
    end
    local widget, err = button(state, caption, callback)
    if not widget then return nil, err end
    local added, add_error = add(state, state.list_container, widget, "library/list_pool", { 0, 0, 0, 4 })
    if not added then return nil, add_error end
    state.list_pool[index] = {
        widget = widget,
        record = state.action_records[widget:GetAddress()],
    }
    return widget
end

refresh_library = function(state)
    if state.detached or not native.is_valid(state.list_container) then return end
    if not state.store.library.folders[state.current_folder] then
        state.current_folder = ""
        state.selected_id = nil
    end
    local listing, err = state.store_api.list(state.store, state.current_folder)
    if not listing then
        set_status(state, error_message(err), "error", "蓝图库读取失败", "ssb_library")
        return nil, err
    end
    state.list_refresh_index = 0
    set_text(state.folder_label, "当前文件夹：" .. (state.current_folder == "" and "根目录" or state.current_folder))
    set_text(state.folder_input, state.current_folder)
    visibility(state.up_button, state.current_folder ~= "", theme.VISIBILITY.Visible)
    visibility(state.folder_tools, state.current_folder ~= "")
    for _, folder in ipairs(listing.folders) do
        local widget, button_error = pool_button(state, "[文件夹] " .. folder.name, function()
            state.current_folder = folder.path
            state.selected_id = nil
            state.confirm_delete_folder = nil
            set_text(state.delete_folder_button, "删除空文件夹")
            refresh_library(state)
        end)
        if not widget then return nil, button_error end
    end
    for _, entry in ipairs(listing.blueprints) do
        local caption = string.format("%s  |  %d 积木 / %d 机器", entry.name, entry.blocks, entry.machines)
        local widget, button_error = pool_button(state, caption, function()
            select_blueprint(state, entry)
        end)
        if not widget then return nil, button_error end
    end
    for index = state.list_refresh_index + 1, #state.list_pool do
        local item = state.list_pool[index]
        if item then
            item.record.callback = function() end
            visibility(item.widget, false)
        end
    end
    visibility(state.empty_label, #listing.folders == 0 and #listing.blueprints == 0)
    refresh_details(state)
    return listing
end

local function build_save_form(state)
    local b = Builder.new(state, "save_form")
    local form = b:make(theme.CLASSES.VERTICAL_BOX, "container")
    b:add(form, b:label("Shift+左键逐块增减选区，填好名称后保存", "hint", {
        size = 12, color = theme.PALETTE.text_secondary, wrap = DRAWER_WIDTH - 48,
    }), "hint", { 0, 0, 0, 8 })

    b:add(form, b:label("蓝图名称", "name_caption", {
        size = 12, color = theme.PALETTE.text_muted,
    }), "name_caption", { 0, 0, 0, 2 })
    local name_frame, name_field = b:input("输入蓝图名称", "name")
    state.name_input = name_field
    b:add(form, name_frame, "name", { 0, 0, 0, 8 })

    b:add(form, b:label("所属文件夹（可选）", "folder_caption", {
        size = 12, color = theme.PALETTE.text_muted,
    }), "folder_caption", { 0, 0, 0, 2 })
    local folder_frame, folder_field = b:input("例如：产线/西区；留空为根目录", "folder")
    state.save_folder_input = folder_field
    b:add(form, folder_frame, "folder", { 0, 0, 0, 10 })

    local machine_row = b:make(theme.CLASSES.HORIZONTAL_BOX, "machine_row")
    state.machine_checkbox = b:make(theme.CLASSES.CHECK_BOX, "machine_checkbox")
    if not b.error then
        state.machine_checkbox:SetIsChecked(false)
        state.machine_checkbox:SetIsEnabled(true)
    end
    local cb_slot = b:add(machine_row, state.machine_checkbox, "machine_checkbox", { 0, 0, 8, 0 })
    if cb_slot then pcall(function() cb_slot:SetVerticalAlignment(2) end) end
    local lbl_slot = b:add(machine_row, b:label("包含内部机器（自动剔除跨模块边缘建筑）", "machine_label", {
        size = 12, color = theme.PALETTE.text_primary, wrap = DRAWER_WIDTH - 84,
    }), "machine_label")
    if lbl_slot then pcall(function() lbl_slot:SetVerticalAlignment(2) end) end
    b:add(form, machine_row, "machine_row", { 0, 0, 0, 12 })

    b:add(form, b:button("保存选中积木", function()
        local folder = from_text(state.save_folder_input:GetText())
        if folder ~= "" then
            local normalized, normalize_error = blueprint_library.normalize_folder(folder)
            if not normalized then
                set_status(state, error_message(normalize_error), "warn", "保存失败", "ssb_save")
                return
            end
            folder = normalized
            if not state.store.library.folders[folder] then
                local created, create_error = state.store_api.create_folder(state.store, folder, state.designer)
                if not created then
                    set_status(state, error_message(create_error), "error", "创建文件夹失败", "ssb_save")
                    return
                end
            end
        end
        local entry, report_or_error = state.store_api.save_selection(state.store, state.designer, {
            name = from_text(state.name_input:GetText()),
            folder = folder,
            includes_machines = state.machine_checkbox:IsChecked(),
        })
        if not entry then
            set_status(state, error_message(report_or_error), "warn", "保存失败", "ssb_save")
            return
        end
        state.designer:ResetSelection()
        state.current_folder = entry.folder
        local message = string.format("已保存 %s：%d 积木，%d 机器", entry.name, entry.blocks, entry.machines)
        local report = report_or_error
        if type(report) == "table" then
            local excluded = (report.excluded_cross_boundary or 0) + (report.excluded_unpaired or 0)
            if excluded > 0 then
                message = message .. string.format("；剔除跨边界 %d，未配对地下带 %d",
                    report.excluded_cross_boundary or 0, report.excluded_unpaired or 0)
            end
        end
        set_status(state, message, "success", "局部蓝图已保存", "ssb_save")
        refresh_library(state)
    end, "submit"), "submit", { 0, 0, 0, 4 })
    return b:finish(form)
end

local function build_library_panel(state)
    local b = Builder.new(state, "library")
    local panel = b:make(theme.CLASSES.VERTICAL_BOX, "container")

    state.folder_label = b:label("当前文件夹：根目录", "folder_label", {
        size = 13, color = theme.PALETTE.tones.info, wrap = DRAWER_WIDTH - 48,
    })
    b:add(panel, state.folder_label, "folder_label", { 0, 0, 0, 6 })

    state.up_button = b:button("返回上级文件夹", function()
        state.current_folder = parent_folder(state.current_folder)
        state.selected_id = nil
        state.confirm_delete_folder = nil
        set_text(state.delete_folder_button, "删除空文件夹")
        refresh_library(state)
    end, "up")
    b:add(panel, state.up_button, "up", { 0, 0, 0, 6 })

    state.list_container = b:make(theme.CLASSES.VERTICAL_BOX, "list_container")
    b:add(panel, state.list_container, "list_container", { 0, 0, 0, 8 })
    state.empty_label = b:label("此文件夹为空", "empty_label", {
        size = 12, color = theme.PALETTE.text_muted,
    })
    b:add(state.list_container, state.empty_label, "empty_label", { 0, 4, 0, 4 })

    -- Selected blueprint details card (framed sub-card with primary Paste button at top)
    local details_panel, details_err = theme.create_framed_panel(state.widget_tree or state.hud.WidgetTree, {
        border_color = theme.PALETTE.border_subtle,
        border_width = 1.0,
        surface_color = theme.PALETTE.surface_alt,
        padding = { 10, 8, 10, 8 },
    })
    if not details_panel then return b:fail("details_card", details_err) end
    state.details_card = details_panel.outer
    state.details = details_panel.body

    state.selected_label = b:label("未选择蓝图", "selected_label", {
        size = 14, color = theme.PALETTE.tones.info, wrap = DRAWER_WIDTH - 68,
    })
    b:add(state.details, state.selected_label, "selected_label", { 0, 0, 0, 8 })

    b:add(state.details, b:button("用原版规划预览粘贴", function()
        start_paste(state)
    end, "paste"), "paste", { 0, 0, 0, 8 })

    b:add(state.details, b:divider("details_div"), "details_div", { 0, 0, 0, 8 })

    local rename_frame, rename_field = b:input("蓝图新名称", "rename_input")
    state.rename_input = rename_field
    b:add(state.details, rename_frame, "rename_input", { 0, 0, 0, 4 })
    b:add(state.details, b:button("重命名蓝图", function()
        local entry, err = state.store_api.rename(state.store, state.selected_id,
            from_text(state.rename_input:GetText()))
        if not entry then
            set_status(state, error_message(err), "warn", "重命名失败", "ssb_library")
            return
        end
        set_status(state, "蓝图已重命名为：" .. entry.name, "success", "蓝图已重命名", "ssb_library")
        refresh_library(state)
    end, "rename"), "rename", { 0, 0, 0, 8 })

    local move_frame, move_field = b:input("目标文件夹完整路径，根目录留空", "move_input")
    state.move_input = move_field
    b:add(state.details, move_frame, "move_input", { 0, 0, 0, 4 })
    b:add(state.details, b:button("移动到目标文件夹", function()
        local entry, err = state.store_api.move(state.store, state.selected_id,
            from_text(state.move_input:GetText()))
        if not entry then
            set_status(state, error_message(err), "warn", "移动失败", "ssb_library")
            return
        end
        state.current_folder = entry.folder
        set_status(state, "蓝图已移动", "success", "蓝图已移动", "ssb_library")
        refresh_library(state)
    end, "move"), "move", { 0, 0, 0, 8 })

    state.delete_button = b:button("删除蓝图", function()
        if state.confirm_delete ~= state.selected_id then
            state.confirm_delete = state.selected_id
            set_text(state.delete_button, "再次点击确认永久删除")
            return
        end
        local deleted, err = state.store_api.delete(state.store, state.selected_id)
        if not deleted then
            set_status(state, error_message(err), "error", "删除失败", "ssb_library")
            return
        end
        state.selected_id = nil
        state.confirm_delete = nil
        set_text(state.delete_button, "删除蓝图")
        set_status(state, "蓝图已删除", "warn", "蓝图已删除", "ssb_library")
        refresh_library(state)
    end, "delete")
    b:add(state.details, state.delete_button, "delete")
    b:add(panel, state.details_card, "details_card", { 0, 4, 0, 10 })

    -- Folder management tools
    b:add(panel, b:divider("folder_div"), "folder_div", { 0, 0, 0, 8 })
    b:add(panel, b:label("文件夹管理", "folder_section", {
        size = 12, color = theme.PALETTE.text_muted,
    }), "folder_section", { 0, 0, 0, 4 })

    local new_folder_frame, new_folder_field = b:input("新文件夹路径，可包含多层 /", "new_folder")
    state.new_folder_input = new_folder_field
    b:add(panel, new_folder_frame, "new_folder", { 0, 0, 0, 4 })
    b:add(panel, b:button("新建文件夹", function()
        local created, err = state.store_api.create_folder(state.store,
            from_text(state.new_folder_input:GetText()), state.designer)
        if not created then
            set_status(state, error_message(err), "warn", "创建文件夹失败", "ssb_library")
            return
        end
        state.current_folder = created
        set_status(state, "已创建文件夹：" .. created, "success", "文件夹已创建", "ssb_library")
        refresh_library(state)
    end, "create_folder"), "create_folder", { 0, 0, 0, 8 })

    state.folder_tools = b:make(theme.CLASSES.VERTICAL_BOX, "folder_tools")
    local folder_path_frame, folder_path_field = b:input("当前文件夹的新路径", "folder_path")
    state.folder_input = folder_path_field
    b:add(state.folder_tools, folder_path_frame, "folder_path", { 0, 0, 0, 4 })
    b:add(state.folder_tools, b:button("重命名或移动当前文件夹", function()
        local updated, err = state.store_api.rename_folder(state.store, state.current_folder,
            from_text(state.folder_input:GetText()))
        if not updated then
            set_status(state, error_message(err), "warn", "整理文件夹失败", "ssb_library")
            return
        end
        state.current_folder = updated
        state.selected_id = nil
        set_status(state, "已整理文件夹：" .. updated, "success", "文件夹已更新", "ssb_library")
        refresh_library(state)
    end, "rename_folder"), "rename_folder", { 0, 0, 0, 4 })
    state.delete_folder_button = b:button("删除空文件夹", function()
        if state.confirm_delete_folder ~= state.current_folder then
            state.confirm_delete_folder = state.current_folder
            set_text(state.delete_folder_button, "再次点击确认删除空文件夹")
            return
        end
        local removed, err = state.store_api.remove_folder(state.store, state.current_folder)
        if not removed then
            set_status(state, error_message(err), "warn", "删除文件夹失败", "ssb_library")
            state.confirm_delete_folder = nil
            set_text(state.delete_folder_button, "删除空文件夹")
            return
        end
        state.current_folder = parent_folder(state.current_folder)
        state.confirm_delete_folder = nil
        set_text(state.delete_folder_button, "删除空文件夹")
        set_status(state, "空文件夹已删除", "warn", "文件夹已删除", "ssb_library")
        refresh_library(state)
    end, "delete_folder")
    b:add(state.folder_tools, state.delete_folder_button, "delete_folder")
    b:add(panel, state.folder_tools, "folder_tools")
    return b:finish(panel)
end

local function build_drawer(state)
    local b = Builder.new(state, "drawer")
    local card, card_err = theme.create_framed_panel(state.widget_tree, {
        border_color = theme.PALETTE.border,
        border_width = 1.5,
        surface_color = theme.PALETTE.surface,
        padding = { 0, 0, 0, 0 },
    })
    if not card then return b:fail("frame", card_err) end

    -- Header strip matching Main Sequence dark sci-fi panels
    local header_bar, header_err = theme.create_border(state.widget_tree, theme.PALETTE.header, { 12, 8, 12, 8 })
    if not header_bar then return b:fail("header_bar", header_err) end
    local header_row = b:make(theme.CLASSES.HORIZONTAL_BOX, "header_row")
    state.drawer_title = b:label("局部蓝图库", "title", {
        size = 16, color = theme.PALETTE.tones.info,
    })
    local title_slot = b:add(header_row, state.drawer_title, "title")
    if title_slot then
        pcall(function() title_slot:SetSize({ Value = 1.0, SizeRule = 1 }) end)
        pcall(function() title_slot:SetVerticalAlignment(2) end)
    end
    local close_btn = b:button("关闭", function()
        close_drawer(state)
    end, "close", { clean = true })
    local close_slot = b:add(header_row, close_btn, "close")
    if close_slot then pcall(function() close_slot:SetVerticalAlignment(2) end) end
    b:add(header_bar, header_row, "header_row")
    b:add(card.body, header_bar, "header_bar")
    b:add(card.body, b:divider("header_div"), "header_div")

    -- Scrollable content area (same WidgetTree as WBP_DesignerHUD_C; zero cross-tree hijacking)
    local scroll_box_wrap = b:make(theme.CLASSES.SIZE_BOX, "scroll_wrap")
    if scroll_box_wrap then
        pcall(function() scroll_box_wrap:SetHeightOverride(DRAWER_SCROLL_HEIGHT) end)
    end
    local scroll_box = b:make(theme.CLASSES.SCROLL_BOX, "scroll_box")
    local content_pad = theme.create_border(state.widget_tree, { R = 0, G = 0, B = 0, A = 0 }, { 12, 10, 12, 10 })
    local content_box = b:make(theme.CLASSES.VERTICAL_BOX, "content_box")
    b:add(content_box, state.save_form, "save_form")
    b:add(content_box, state.library_panel, "library_panel")
    if content_pad then
        b:add(content_pad, content_box, "content_pad")
        b:add(scroll_box, content_pad, "scroll_content")
    else
        b:add(scroll_box, content_box, "scroll_content")
    end
    b:add(scroll_box_wrap, scroll_box, "scroll_box")
    b:add(card.body, scroll_box_wrap, "scroll_wrap")

    -- Footer status bar
    b:add(card.body, b:divider("footer_div"), "footer_div")
    local footer_bar, footer_err = theme.create_border(state.widget_tree, theme.PALETTE.surface_alt, { 12, 6, 12, 8 })
    if not footer_bar then return b:fail("footer_bar", footer_err) end
    b:add(footer_bar, state.status, "status")
    b:add(card.body, footer_bar, "footer_bar")

    return b:finish(card.outer)
end

local function block_map(blocks)
    local result = {}
    for _, block in ipairs(blocks or {}) do
        result[tostring(block.id)] = block
    end
    return result
end

local function count_new_blocks(before_blocks, after_blocks)
    local before = block_map(before_blocks)
    local count = 0
    for _, block in ipairs(after_blocks or {}) do
        if not before[tostring(block.id)] then count = count + 1 end
    end
    return count
end

local function blocks_signature(blocks)
    if type(blocks) ~= "table" then return "missing" end
    local values = {}
    for _, block in ipairs(blocks) do
        values[#values + 1] = table.concat({
            tostring(block.id), tostring(block.class_name), tostring(block.gx), tostring(block.gy),
            tostring(block.height), tostring(block.rot), tostring(block.palette_id),
        }, ":")
    end
    table.sort(values)
    return table.concat(values, "|")
end

local function end_paste(state, cancel_native)
    if not state.paste then return end
    local paste = state.paste
    state.paste = nil
    if paste.preview_hook then
        local removed, remove_error = designer_native.remove_preview_hook(paste.preview_hook)
        if not removed then log("preview hook cleanup: " .. tostring(remove_error)) end
    end
    if cancel_native and native.is_valid(state.designer) then
        designer_native.cancel_preview(state.designer)
    end
    visibility(state.paste_status_box or state.paste_status, false)
end

local function read_local_parameter(parameter)
    if parameter == nil then return nil end
    local ok, value = pcall(function() return parameter:Get() end)
    return ok and value or nil
end

local function preview_resolver(state, designer, intersect_val, hit_val)
    local paste = state.paste
    if not paste then return nil end
    local frame = designer_native.frame_actor_transform(designer)
    if not frame then return nil end
    local intersect = read_local_parameter(intersect_val)
    if not intersect then return nil end
    local native_cursor = docking.world_to_grid(frame.origin, frame.rotation, intersect)
    local cursor = {
        gx = native_cursor.gx / 4,
        gy = native_cursor.gy / 4,
        floor = native_cursor.height / 2,
    }
    local target
    local actor = designer.ViewTarget
    if native.is_valid(actor) then
        local id = designer_native.block_id_for_actor(designer, actor)
        if id then target = paste.block_by_id[tostring(id)] end
    end
    local hit_dir
    local hit = read_local_parameter(hit_val)
    if hit then
        local normal = hit.Normal or hit.ImpactNormal
        if normal then
            local local_normal = docking.world_to_grid({ X = 0, Y = 0, Z = 0 }, frame.rotation, normal)
            hit_dir = { x = local_normal.gx, y = local_normal.gy }
        end
    end
    local pose = paste.controller:update_hover(
        target, paste.before_blocks, cursor, hit_dir, paste.alt_held
    )
    local world = docking.grid_to_world(
        frame.origin, frame.rotation, pose.dgx * 4, pose.dgy * 4, pose.dfloor * 2
    )
    if native.is_valid(state.paste_status) then
        set_text(state.paste_status, paste.controller:status_text())
    end
    return { x = world.X, y = world.Y, z = world.Z, suppress_snapping = true }
end

start_paste = function(state)
    if state.paste then
        set_status(state, "请先确认或取消当前局部蓝图预览", "warn", "粘贴进行中", "ssb_paste")
        return
    end
    local before, before_error = designer_native.snapshot_frame_blocks(state.designer)
    if not before then
        set_status(state, "无法记录粘贴前积木：" .. tostring(before_error), "error", "粘贴失败", "ssb_paste")
        return
    end
    local preview, entry_or_error, section_doc, json_path = state.store_api.paste(
        state.store, state.designer, state.selected_id
    )
    if not preview then
        set_status(state, error_message(entry_or_error), "warn", "粘贴失败", "ssb_paste")
        return
    end
    local entry = entry_or_error
    local station_id_ok, station_id = pcall(function() return state.designer.Frame.ID end)
    state.paste = {
        entry = entry,
        section_doc = section_doc,
        json_path = json_path,
        before_blocks = before,
        block_by_id = block_map(before),
        controller = docking.new_controller(section_doc or { modules = {}, buildings = {} }, {
            includes_machines = entry.includes_machines,
        }),
        station_id = station_id_ok and station_id or nil,
        alt_held = false,
    }
    local hook, hook_error = designer_native.install_preview_hook(state.designer, function(designer, intersect, hit)
        return preview_resolver(state, designer, intersect, hit)
    end)
    if not hook then
        state.paste = nil
        designer_native.cancel_preview(state.designer)
        set_status(state, "无法接管局部预览：" .. tostring(hook_error), "error", "粘贴失败", "ssb_paste")
        return
    end
    state.paste.preview_hook = hook
    close_drawer(state)
    visibility(state.paste_status_box or state.paste_status, true, theme.VISIBILITY.HitTestInvisible)
    set_text(state.paste_status, state.paste.controller:status_text())
    set_status(state, string.format("局部预览已启动（%d 个积木）；H锁定，Tab方案，R旋转，Enter确认",
        preview.previews), "info", "局部预览已启动", "ssb_paste")
end

function M.poll(state)
    if not state or state.detached then return end
    local session = designer_native.find_session()
    if not session or not native.is_valid(state.designer)
        or session.designer:GetAddress() ~= state.designer:GetAddress() then
        return
    end
    local snapshot = designer_native.snapshot_frame_blocks(state.designer)
    if snapshot then state.last_blocks = snapshot end
    local paste = state.paste
    if not paste then return end
    local ok, preview_count = pcall(function() return #state.designer.PlacementPreviews end)
    if not ok then return end
    if preview_count > 0 then
        paste.empty_preview_polls = 0
        return
    end
    local after = snapshot
    local added = after and count_new_blocks(paste.before_blocks, after) or 0
    if added == 0 and (paste.empty_preview_polls or 0) < 1 then
        paste.empty_preview_polls = 1
        return
    end
    end_paste(state, false)
    if added == 0 then
        set_status(state, "局部预览已取消", "warn", "预览已取消", "ssb_paste")
        return
    end
    local transform, infer_error = docking.infer_placed_transform(
        paste.before_blocks, after, paste.section_doc or { modules = {} }
    )
    if paste.entry.includes_machines and paste.entry.machines > 0 then
        if not paste.section_doc then
            set_status(state, "壳体已确认，但缺少 Canonical JSON，室内机台未排队", "warn", "壳体已确认", "ssb_paste")
            return
        elseif not transform then
            set_status(state, "壳体已确认，但放置变换无法唯一闭合：" .. tostring(infer_error), "warn", "机台未排队", "ssb_paste")
            return
        elseif type(paste.station_id) ~= "number" or paste.station_id <= 0 then
            set_status(state, "壳体已确认，但空间站 ID 无效，室内机台未排队", "warn", "机台未排队", "ssb_paste")
            return
        end
        local queued, queue_error = machine_paste.queue_pending_job({
            json_path = paste.json_path,
            transform = transform,
            station_id = paste.station_id,
            machine_count = paste.entry.machines,
            creative_mode = false,
        })
        if not queued then
            set_status(state, "室内机台任务排队失败：" .. tostring(queue_error), "error", "机台排队失败", "ssb_paste")
            return
        end
        set_status(state, string.format("壳体已确认；退出并应用设计后可搭建 %d 台室内机台",
            paste.entry.machines), "success", "壳体已确认", "ssb_paste")
    else
        set_status(state, "局部蓝图壳体已确认", "success", "壳体已确认", "ssb_paste")
    end
end

function M.on_designer_exit(state)
    if not state or state.exit_processed then return end
    state.exit_processed = true
    end_paste(state, false)
    local before = blocks_signature(state.entry_baseline_blocks)
    local after = blocks_signature(state.last_blocks)
    if before == "missing" or after == "missing" then
        machine_paste.discard_pending_jobs()
        log("designer block baseline unavailable; pending machine jobs discarded")
    elseif before ~= after then
        local count = machine_paste.commit_pending_jobs()
        log(string.format("designer changes applied; committed %d machine jobs", count))
        if count > 0 then
            local ready = machine_paste.ready_machine_count()
            toast.show("待建室内机台就绪", string.format("共 %d 台室内机台等待确认搭建", ready), "info", 4.5, "ssb_machines")
        end
    else
        local count = machine_paste.discard_pending_jobs()
        log(string.format("designer changes discarded; discarded %d machine jobs", count))
    end
end

local function unmount_pending_machine_bar()
    runtime.pending_log_count = nil
    local bar = runtime.pending_bar
    if not bar then return end
    runtime.pending_bar = nil
    bar.state.detached = true
    bar.state.active = false
    for address, record in pairs(bar.state.action_records) do
        if runtime.actions[address] == record then runtime.actions[address] = nil end
    end
    for _, item in ipairs(bar.state.mounted) do
        if native.is_valid(item.parent) and native.is_valid(item.child) then
            pcall(function() item.parent:RemoveChild(item.child) end)
        end
    end
end

local function mount_pending_machine_bar(_)
    local count = machine_paste.ready_machine_count()
    if count == 0 then
        unmount_pending_machine_bar()
        return
    end
    local host = theme.find_active_hud_host({
        exclude_classes = { WBP_DesignerHUD_C = true },
    })
    if not host then
        if runtime.pending_log_count ~= count then
            runtime.pending_log_count = count
            log(string.format("待建室内机台：%d 台；等待世界 HUD 就绪（或调用 confirm_pending_machines）", count))
        end
        return
    end
    if runtime.pending_bar then
        local ok_same, same = pcall(function()
            return native.is_valid(runtime.pending_bar.host_hud)
                and runtime.pending_bar.host_hud:GetAddress() == host.hud:GetAddress()
                and native.is_valid(runtime.pending_bar.count_label)
        end)
        if ok_same and same then
            set_text(runtime.pending_bar.count_label, string.format("待建室内机台：%d 台", count))
            return
        end
        unmount_pending_machine_bar()
    end
    runtime.pending_log_count = nil
    local bar_state = {
        hud = host.hud,
        widget_tree = host.widget_tree,
        owner = host.owner,
        detached = false,
        active = false,
        mounted = {},
        action_records = {},
    }
    local card = theme.create_framed_panel(host.widget_tree, {
        border_color = theme.PALETTE.tones.info,
        border_width = 1.5,
        surface_color = theme.PALETTE.surface,
        padding = { 16, 10, 16, 10 },
    })
    if not card then return end
    local row = construct(bar_state, theme.CLASSES.HORIZONTAL_BOX)
    if not row then return end
    local count_label = label(bar_state, string.format("待建室内机台：%d 台", count), {
        size = 15, color = theme.PALETTE.text_primary,
    })
    local confirm = button(bar_state, "开始搭建", function() M.confirm_pending_machines() end, { clean = true })
    local dismiss = button(bar_state, "忽略", function() M.dismiss_pending_machines() end, { clean = true })
    if not count_label or not confirm or not dismiss then return end
    local s1 = add(bar_state, row, count_label, "machines/count", { 0, 0, 16, 0 })
    if s1 then pcall(function() s1:SetVerticalAlignment(2) end) end
    local s2 = add(bar_state, row, confirm, "machines/confirm", { 0, 0, 8, 0 })
    if s2 then pcall(function() s2:SetVerticalAlignment(2) end) end
    local s3 = add(bar_state, row, dismiss, "machines/dismiss")
    if s3 then pcall(function() s3:SetVerticalAlignment(2) end) end
    add(bar_state, card.body, row, "machines/row")
    local placed = mount_canvas(bar_state, host.canvas, card.outer, {
        anchors = { Minimum = { X = 0.5, Y = 1.0 }, Maximum = { X = 0.5, Y = 1.0 } },
        alignment = { X = 0.5, Y = 1.0 },
        position = { X = 0.0, Y = -96.0 },
        auto_size = true,
        z_order = 900,
    }, "machines/bar")
    if not placed then return end
    visibility(card.outer, true, theme.VISIBILITY.Visible)
    bar_state.active = true
    for address, record in pairs(bar_state.action_records) do
        runtime.actions[address] = record
    end
    runtime.pending_bar = { state = bar_state, host_hud = host.hud, count_label = count_label }
end

function M.mount_pending_machine_bar(state)
    return mount_pending_machine_bar(state)
end

function M.confirm_pending_machines()
    if runtime.machine_executing then return nil, "machine_job_already_active" end
    local jobs = machine_paste.take_ready_jobs()
    if #jobs == 0 then
        unmount_pending_machine_bar()
        return true
    end
    runtime.machine_executing = true
    runtime.machine_reports = {}
    unmount_pending_machine_bar()
    toast.show("室内机台搭建", string.format("正在执行 %d 组室内机台搭建任务...", #jobs), "info", 3.5, "ssb_machines")
    local index = 1
    local function run_next()
        local job = jobs[index]
        if not job then
            runtime.machine_executing = false
            local built, configured, errors = 0, 0, 0
            for _, report in ipairs(runtime.machine_reports) do
                built = built + (report.built or 0)
                configured = configured + (report.configured or 0)
                errors = errors + (report.config_errors or 0)
            end
            local summary = string.format("建造 %d 台，配置 %d 项，错误 %d 项", built, configured, errors)
            log(string.format("machine jobs complete: built=%d configured=%d config_errors=%d",
                built, configured, errors))
            toast.show("室内机台搭建完成", summary, errors > 0 and "warn" or "success", 4.5, "ssb_machines")
            return
        end
        index = index + 1
        local started, start_error = machine_paste.execute_job(job, function(progress)
            log(string.format("machine job %d/%d %s", index - 1, #jobs,
                tostring(progress.phase or "progress")))
        end, function(report)
            runtime.machine_reports[#runtime.machine_reports + 1] = report
            run_next()
        end)
        if not started then
            runtime.machine_reports[#runtime.machine_reports + 1] = {
                built = 0, configured = 0, config_errors = 1, start_error = start_error,
            }
            run_next()
        end
    end
    run_next()
    return true
end

function M.dismiss_pending_machines()
    if runtime.machine_executing then return nil, "machine_job_already_active" end
    local jobs = machine_paste.take_ready_jobs()
    unmount_pending_machine_bar()
    if #jobs > 0 then
        toast.show("室内机台任务", "已忽略待建室内机台队列", "warn", 3.0, "ssb_machines")
    end
    return #jobs
end

local function camera_yaw(session)
    local manager = session.controller.PlayerCameraManager
    if not native.is_valid(manager) then return nil end
    local ok, rotation = pcall(function() return manager:GetCameraRotation() end)
    return ok and rotation.Yaw or nil
end

runtime.on_key = function(action)
    local session = designer_native.find_session()
    if not session then return end
    local state = runtime.attached
    if not state or state.detached or not native.is_valid(state.designer)
        or state.designer:GetAddress() ~= session.designer:GetAddress() then
        return
    end
    local designer = session.designer
    if action == "shift_left" then
        local actor = designer.ViewTarget
        if not native.is_valid(actor) then return end
        local result, toggle_error = designer_native.toggle_block_in_selection(designer, actor)
        if result then
            set_status(state, string.format("%s积木 %d；当前选中 %d 块",
                result.action == "added" and "已选择" or "已取消", result.id, result.count),
                "info", "局部选区", "ssb_selection")
        else
            set_status(state, "无法切换选区：" .. tostring(toggle_error), "warn", "选区切换失败", "ssb_selection")
        end
        return
    end
    local paste = state.paste
    if not paste then return end
    local controller = paste.controller
    if action == "lock" then
        controller:toggle_lock()
        local locked = controller.mode == "locked"
        toast.show("局部预览锁定", locked and "已锁定当前位置，可用方向键/PgUp/PgDn微调，Enter确认" or "已解除锁定，恢复目标积木悬浮吸附",
            locked and "info" or "warn", 2.5, "ssb_paste_lock")
    elseif action == "next_candidate" or action == "previous_candidate" then
        local _, cycle_error = controller:cycle_candidate(action == "next_candidate" and 1 or -1)
        if cycle_error then set_status(state, "当前没有可轮换的对接候选", "warn", "无可用候选", "ssb_paste") end
    elseif action == "rotate" then
        controller:rotate_cw()
    elseif action == "mirror" then
        if not controller:can_mirror() then
            set_status(state, "包含室内机台时禁止镜像，以保护端口方向", "warn", "已禁止镜像", "ssb_paste")
            return
        end
    elseif action == "alt" then
        paste.alt_held = not paste.alt_held
    elseif action == "confirm" then
        if controller.mode ~= "locked" then
            set_status(state, "Enter 仅在 H 锁定后确认；悬浮时可直接左键", "warn", "尚未锁定预览", "ssb_paste")
            return
        end
        local confirmed, confirm_error = designer_native.confirm_preview(designer)
        if not confirmed then set_status(state, "原生确认失败：" .. tostring(confirm_error), "error", "确认失败", "ssb_paste") end
    elseif action == "left" or action == "right" or action == "forward" or action == "backward"
        or action == "floor_up" or action == "floor_down" then
        local yaw = camera_yaw(session)
        if not yaw then
            set_status(state, "无法读取相机朝向，未执行微调", "warn")
            return
        end
        local right = action == "right" and 1 or action == "left" and -1 or 0
        local forward = action == "forward" and 1 or action == "backward" and -1 or 0
        local floor = action == "floor_up" and 1 or action == "floor_down" and -1 or 0
        local _, nudge_error = controller:nudge(right, forward, floor, yaw)
        if nudge_error then set_status(state, "请先按 H 锁定预览再微调", "warn", "未锁定预览", "ssb_paste") end
    end
    if native.is_valid(state.paste_status) then
        set_text(state.paste_status, controller:status_text())
    end
end

function M.detach(state)
    if not state or state.detached then return true end
    end_paste(state, false)
    state.detached = true
    state.active = false
    if runtime.attached == state then runtime.attached = nil end
    for address, record in pairs(state.action_records or {}) do
        if runtime.actions[address] == record then
            runtime.actions[address] = nil
        end
    end
    for index = #(state.mounted or {}), 1, -1 do
        local item = state.mounted[index]
        if native.is_valid(item.parent) and native.is_valid(item.child) then
            local ok, err = pcall(function()
                item.parent:RemoveChild(item.child)
            end)
            if not ok then log("detach remove failed: " .. tostring(err)) end
        end
    end
    state.mounted = {}
    return true
end

local attaching_state

local function fail_attach(state, err)
    M.detach(state)
    attaching_state = nil
    return nil, err
end

local function attach_internal(hud, designer, store_api, store)
    if not native.is_valid(hud) or not native.is_valid(designer) then
        return nil, "invalid_ui_target"
    end
    if type(store_api) ~= "table" or type(store) ~= "table" or type(store.library) ~= "table" then
        return nil, "invalid_store_contract"
    end
    if not native.is_valid(hud.WidgetTree) or not native.is_valid(hud.SaveOptionsContainer) then
        return nil, "missing_native_designer_widgets"
    end
    local canvas = theme.find_canvas_in_hud(hud)
    if not canvas then
        return nil, "missing_native_hud_canvas"
    end
    local owner_ok, owner = pcall(function() return hud:GetOwningPlayer() end)
    if not owner_ok or not native.is_valid(owner) then return nil, "missing_owning_player" end
    local baseline, baseline_error = designer_native.snapshot_frame_blocks(designer)
    if not baseline then return nil, "designer_baseline_failed:" .. tostring(baseline_error) end

    local state = {
        hud = hud,
        canvas = canvas,
        widget_tree = hud.WidgetTree,
        designer = designer,
        owner = owner,
        store_api = store_api,
        store = store,
        current_folder = "",
        active = false,
        drawer_open = false,
        drawer_mode = nil,
        mounted = {},
        action_records = {},
        list_pool = {},
        list_refresh_index = 0,
        entry_baseline_blocks = baseline,
        last_blocks = baseline,
    }
    attaching_state = state

    local save_form, save_form_error = build_save_form(state)
    if not save_form then return fail_attach(state, save_form_error) end
    state.save_form = save_form

    local library_panel, library_error = build_library_panel(state)
    if not library_panel then return fail_attach(state, library_error) end
    state.library_panel = library_panel

    state.status = label(state, "就绪：Shift+左键多选保存，或在蓝图库中选择粘贴", {
        size = 12, color = theme.PALETTE.text_secondary, wrap = DRAWER_WIDTH - 28,
    })
    if not state.status then return fail_attach(state, "status_label_failed") end

    local drawer, drawer_error = build_drawer(state)
    if not drawer then return fail_attach(state, drawer_error) end
    state.drawer = drawer

    local drawer_slot, drawer_mount_error = mount_canvas(state, canvas, drawer, {
        anchors = { Minimum = { X = 1.0, Y = 0.5 }, Maximum = { X = 1.0, Y = 0.5 } },
        alignment = { X = 1.0, Y = 0.5 },
        position = { X = -24.0, Y = 40.0 },
        size = { X = DRAWER_WIDTH, Y = DRAWER_HEIGHT },
        auto_size = false,
        z_order = 850,
    }, "mount/drawer")
    if not drawer_slot then return fail_attach(state, drawer_mount_error) end

    state.save_button = button(state, "保存局部蓝图", function()
        local selected, select_error = designer_native.activate_select_tool(state.designer, state.hud)
        if not selected then
            set_status(state, "无法进入原生多选模式：" .. tostring(select_error), "error", "多选模式失败", "ssb_selection")
            return
        end
        set_text(state.save_folder_input, state.current_folder)
        open_drawer(state, "save")
        set_status(state, "已进入原生多选模式：Shift+左键选择积木后在右侧保存", "info", "进入多选模式", "ssb_selection")
    end)
    if not state.save_button then return fail_attach(state, "save_entry_button_failed") end

    state.library_button = button(state, "局部蓝图库", function()
        if state.drawer_open and state.drawer_mode == "library" then
            close_drawer(state)
            return
        end
        local refreshed, refresh_error = refresh_library(state)
        if not refreshed then
            set_status(state, error_message(refresh_error), "error", "蓝图库刷新失败", "ssb_library")
        end
        open_drawer(state, "library")
    end)
    if not state.library_button then return fail_attach(state, "library_entry_button_failed") end

    local mounted, mount_error = mount(state, hud.SaveOptionsContainer, state.save_button, "mount/save_entry")
    if not mounted then return fail_attach(state, mount_error) end
    mounted, mount_error = mount(state, hud.SaveOptionsContainer, state.library_button, "mount/library_entry")
    if not mounted then return fail_attach(state, mount_error) end

    -- Styled paste status badge mounted inside SaveOptionsContainer
    local paste_card = theme.create_framed_panel(state.widget_tree, {
        border_color = theme.PALETTE.tones.info,
        border_width = 1.0,
        surface_color = theme.PALETTE.surface,
        padding = { 10, 4, 10, 4 },
    })
    state.paste_status = label(state, "局部蓝图粘贴", {
        size = 12, color = theme.PALETTE.text_primary,
    })
    if not state.paste_status then return fail_attach(state, "paste_status_failed") end
    if paste_card and theme.add_child(paste_card.body, state.paste_status) then
        state.paste_status_box = paste_card.outer
        mounted, mount_error = mount(state, hud.SaveOptionsContainer, state.paste_status_box, "mount/paste_status")
    else
        state.paste_status_box = state.paste_status
        mounted, mount_error = mount(state, hud.SaveOptionsContainer, state.paste_status, "mount/paste_status")
    end
    if not mounted then return fail_attach(state, mount_error) end

    visibility(state.paste_status_box, false)
    close_drawer(state)
    visibility(state.details_card, false)

    local refreshed, refresh_error = refresh_library(state)
    if not refreshed then return fail_attach(state, refresh_error) end

    state.active = true
    for address, record in pairs(state.action_records) do
        runtime.actions[address] = record
    end

    local bound, bind_error = ensure_keybind()
    if not bound then return fail_attach(state, bind_error) end

    attaching_state = nil
    runtime.attached = state
    return state
end

function M.attach(hud, designer, store_api, store)
    local ok, state, err = pcall(attach_internal, hud, designer, store_api, store)
    if not ok then
        if attaching_state then
            M.detach(attaching_state)
            attaching_state = nil
        end
        return nil, state
    end
    attaching_state = nil
    return state, err
end

function M.dispatch_hovered()
    dispatch_hovered()
end

return M
