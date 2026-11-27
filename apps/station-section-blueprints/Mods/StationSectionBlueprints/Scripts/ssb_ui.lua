local native = require("ssb_native")
local designer_native = require("ssb_native_designer")
local blueprint_library = require("ssb_library")
local docking = require("ssb_docking")
local machine_paste = require("ssb_machine_paste")

local M = {}

local BUTTON_CLASS = "/Game/Blueprints/Widgets/Basic/WBP_Button_Text.WBP_Button_Text_C"
local runtime = _G.__StationSectionBlueprintsUIRuntime
if not runtime then
    runtime = { actions = {}, keybind_registered = false, machine_reports = {} }
    _G.__StationSectionBlueprintsUIRuntime = runtime
end

local ESlateVisibility = {
    Collapsed = 1,
    Hidden = 2,
    SelfHitTestInvisible = 4,
}

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

local function to_text(value)
    local ok, text = pcall(FText, tostring(value or ""))
    if not ok then
        return nil, text
    end
    return text
end

local function from_text(value)
    local ok, text = pcall(function()
        return value:ToString()
    end)
    return ok and text or ""
end

local function set_text(widget, value)
    local text, err = to_text(value)
    if not text then
        return nil, err
    end
    local ok, set_error = pcall(function()
        widget:SetText(text)
    end)
    if not ok then
        return nil, set_error
    end
    return true
end

local function set_status(state, value)
    if native.is_valid(state.status) then
        set_text(state.status, value)
    end
    log(value)
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
                set_status(action.state, "界面操作失败：" .. tostring(action_error))
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
    local class = native.find_type(path)
    if not class then
        return nil, "missing_widget_class:" .. path
    end
    if not native.is_valid(state.hud.WidgetTree) then
        return nil, "missing_native_widget_tree"
    end
    trace("construct start " .. path)
    local flags = EObjectFlags.RF_Public | EObjectFlags.RF_Standalone
    local ok, widget = pcall(StaticConstructObject, class, state.hud.WidgetTree, 0, flags)
    if not ok or not native.is_valid(widget) then
        return nil, "widget_construction_failed:" .. path
    end
    trace("construct ok " .. path)
    return widget
end

local function add(state, parent, child, step)
    if not native.is_valid(parent) or not native.is_valid(child) then
        return nil, step .. ":invalid_parent_or_child"
    end
    trace("add start " .. step)
    local ok, slot = pcall(function()
        return parent:AddChild(child)
    end)
    if not ok or not native.is_valid(slot) then
        return nil, step .. ":add_child_failed:" .. tostring(slot)
    end
    trace("add ok " .. step)
    return child
end

local function mount(state, parent, child, step)
    local mounted, err = add(state, parent, child, step)
    if not mounted then
        return nil, err
    end
    state.mounted[#state.mounted + 1] = { parent = parent, child = child }
    return child
end

local function register_action(state, widget, callback)
    local record = { state = state, callback = callback, widget = widget }
    state.action_records[widget:GetAddress()] = record
    return record
end

local function button(state, label, callback)
    local class = native.find_type(BUTTON_CLASS)
    if not class then
        return nil, "missing_native_button"
    end
    local library_class = native.find_type("/Script/UMG.WidgetBlueprintLibrary")
    if not library_class then
        return nil, "missing_widget_library"
    end
    trace("button create start " .. label)
    local ok, widget = pcall(function()
        return library_class:GetCDO():Create(state.hud, class, state.owner)
    end)
    if not ok or not native.is_valid(widget) then
        return nil, "native_button_creation_failed:" .. tostring(widget)
    end
    trace("button create ok " .. label)
    local text_ok, text_error = set_text(widget, label)
    if not text_ok then
        return nil, text_error
    end
    trace("button text ok " .. label)
    register_action(state, widget, callback)
    return widget
end

local function label(state, value)
    local widget, err = construct(state, "/Script/UMG.TextBlock")
    if not widget then
        return nil, err
    end
    local ok, text_error = set_text(widget, value)
    if not ok then
        return nil, text_error
    end
    return widget
end

local function input(state, hint)
    local widget, err = construct(state, "/Script/UMG.EditableTextBox")
    if not widget then
        return nil, err
    end
    local text, text_error = to_text(hint)
    if not text then
        return nil, text_error
    end
    local ok, hint_error = pcall(function()
        widget:SetHintText(text)
    end)
    if not ok then
        return nil, hint_error
    end
    return widget
end

local function visibility(widget, visible)
    if native.is_valid(widget) then
        widget:SetVisibility(visible and ESlateVisibility.SelfHitTestInvisible or ESlateVisibility.Collapsed)
    end
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

function Builder:label(value, step)
    if self.error then return nil end
    local widget, err = label(self.state, value)
    if not widget then return self:fail(step, err) end
    return widget
end

function Builder:input(hint, step)
    if self.error then return nil end
    local widget, err = input(self.state, hint)
    if not widget then return self:fail(step, err) end
    return widget
end

function Builder:button(caption, callback, step)
    if self.error then return nil end
    local widget, err = button(self.state, caption, callback)
    if not widget then return self:fail(step, err) end
    return widget
end

function Builder:add(parent, child, step)
    if self.error then return nil end
    local widget, err = add(self.state, parent, child, self.prefix .. "/" .. step)
    if not widget then return self:fail("add", err) end
    return widget
end

function Builder:finish(widget)
    if self.error then return nil, self.error end
    return widget
end

local function mount_browser_content(state, container)
    if state.content_parent ~= container then
        local retained = {}
        for _, item in ipairs(state.mounted) do
            if item.browser_content then
                if native.is_valid(item.parent) and native.is_valid(item.child) then
                    pcall(function() item.parent:RemoveChild(item.child) end)
                end
            else
                retained[#retained + 1] = item
            end
        end
        state.mounted = retained
        state.content_parent = container
        state.content_mounted = false
    end
    if state.content_mounted then return true end

    local content = {
        { widget = state.save_form, step = "mount/save_form" },
        { widget = state.library_panel, step = "mount/library_panel" },
        { widget = state.status, step = "mount/status" },
    }
    for _, item in ipairs(content) do
        local mounted, err = mount(state, container, item.widget, item.step)
        if not mounted then
            for index = #state.mounted, 1, -1 do
                local added = state.mounted[index]
                if added.browser_content then
                    pcall(function() added.parent:RemoveChild(added.child) end)
                    table.remove(state.mounted, index)
                end
            end
            state.content_parent = nil
            state.content_mounted = false
            return nil, err
        end
        state.mounted[#state.mounted].browser_content = true
    end
    state.content_mounted = true
    return true
end

local function open_browser(state)
    local popup = state.hud.DesignerPopup
    if not native.is_valid(popup) or popup:GetVisibility() == ESlateVisibility.Collapsed
        or popup:GetVisibility() == ESlateVisibility.Hidden then
        local ok, err = pcall(function()
            state.hud.OpenButton.OnPressed:Broadcast()
        end)
        if not ok then return nil, err end
        popup = state.hud.DesignerPopup
    end
    if not native.is_valid(popup) or not native.is_valid(popup.WBP_SavedBlueprints)
        or not native.is_valid(popup.WBP_SavedBlueprints.Container) then
        return nil, "missing_native_blueprint_browser"
    end
    local container = popup.WBP_SavedBlueprints.Container
    local mounted, mount_error = mount_browser_content(state, container)
    if not mounted then return nil, mount_error end
    local panel = state.save_form:GetVisibility() == ESlateVisibility.SelfHitTestInvisible
        and state.save_form or state.library_panel
    container:ScrollWidgetIntoView(panel, false, 0, 0)
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
    set_text(state.selected_label, entry.name)
    set_text(state.rename_input, entry.name)
    set_text(state.move_input, entry.folder)
    set_text(state.delete_button, "删除蓝图")
    visibility(state.details, true)
end

local function refresh_details(state)
    local entry = state.selected_id and state.store.library.entries[state.selected_id] or nil
    if not entry then
        state.selected_id = nil
        visibility(state.details, false)
        return
    end
    set_text(state.selected_label, entry.name)
    visibility(state.details, true)
end

local function pool_button(state, caption, callback)
    state.list_refresh_index = state.list_refresh_index + 1
    local index = state.list_refresh_index
    local existing = state.list_pool[index]
    if existing and native.is_valid(existing.widget) then
        existing.record.callback = callback
        set_text(existing.widget, caption)
        visibility(existing.widget, true)
        return existing.widget
    end
    local widget, err = button(state, caption, callback)
    if not widget then return nil, err end
    local added, add_error = add(state, state.list_container, widget, "library/list_pool")
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
        set_status(state, error_message(err))
        return nil, err
    end
    state.list_refresh_index = 0
    set_text(state.folder_label, "当前文件夹：" .. (state.current_folder == "" and "根目录" or state.current_folder))
    set_text(state.folder_input, state.current_folder)
    visibility(state.up_button, state.current_folder ~= "")
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
    local form = b:make("/Script/UMG.VerticalBox", "container")
    b:add(form, b:label("保存原生选区为局部蓝图", "title"), "title")
    state.name_input = b:input("蓝图名称", "name")
    b:add(form, state.name_input, "name")
    state.save_folder_input = b:input("文件夹，例如：产线/西区；留空为根目录", "folder")
    b:add(form, state.save_folder_input, "folder")

    local machine_row = b:make("/Script/UMG.HorizontalBox", "machine_row")
    state.machine_checkbox = b:make("/Script/UMG.CheckBox", "machine_checkbox")
    if not b.error then
        state.machine_checkbox:SetIsChecked(false)
        state.machine_checkbox:SetIsEnabled(true)
    end
    b:add(machine_row, state.machine_checkbox, "machine_checkbox")
    b:add(machine_row, b:label("包含内部机器（自动剔除跨模块边缘建筑）", "machine_label"), "machine_label")
    b:add(form, machine_row, "machine_row")

    b:add(form, b:button("保存选中积木", function()
        local folder = from_text(state.save_folder_input:GetText())
        if folder ~= "" then
            local normalized, normalize_error = blueprint_library.normalize_folder(folder)
            if not normalized then
                set_status(state, error_message(normalize_error))
                return
            end
            folder = normalized
            if not state.store.library.folders[folder] then
                local created, create_error = state.store_api.create_folder(state.store, folder, state.designer)
                if not created then
                    set_status(state, error_message(create_error))
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
            set_status(state, error_message(report_or_error))
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
        set_status(state, message)
        refresh_library(state)
    end, "submit"), "submit")
    return b:finish(form)
end

local function build_library_panel(state)
    local b = Builder.new(state, "library")
    local panel = b:make("/Script/UMG.VerticalBox", "container")
    b:add(panel, b:label("局部蓝图库", "title"), "title")
    state.folder_label = b:label("当前文件夹：根目录", "folder_label")
    b:add(panel, state.folder_label, "folder_label")

    state.up_button = b:button("返回上级文件夹", function()
        state.current_folder = parent_folder(state.current_folder)
        state.selected_id = nil
        state.confirm_delete_folder = nil
        set_text(state.delete_folder_button, "删除空文件夹")
        refresh_library(state)
    end, "up")
    b:add(panel, state.up_button, "up")

    state.new_folder_input = b:input("新文件夹路径，可包含多层 /", "new_folder")
    b:add(panel, state.new_folder_input, "new_folder")
    b:add(panel, b:button("新建文件夹", function()
        local created, err = state.store_api.create_folder(state.store,
            from_text(state.new_folder_input:GetText()), state.designer)
        if not created then
            set_status(state, error_message(err))
            return
        end
        state.current_folder = created
        set_status(state, "已创建文件夹：" .. created)
        refresh_library(state)
    end, "create_folder"), "create_folder")

    state.folder_tools = b:make("/Script/UMG.VerticalBox", "folder_tools")
    state.folder_input = b:input("当前文件夹的新路径", "folder_path")
    b:add(state.folder_tools, state.folder_input, "folder_path")
    b:add(state.folder_tools, b:button("重命名或移动当前文件夹", function()
        local updated, err = state.store_api.rename_folder(state.store, state.current_folder,
            from_text(state.folder_input:GetText()))
        if not updated then
            set_status(state, error_message(err))
            return
        end
        state.current_folder = updated
        state.selected_id = nil
        set_status(state, "已整理文件夹：" .. updated)
        refresh_library(state)
    end, "rename_folder"), "rename_folder")
    state.delete_folder_button = b:button("删除空文件夹", function()
        if state.confirm_delete_folder ~= state.current_folder then
            state.confirm_delete_folder = state.current_folder
            set_text(state.delete_folder_button, "再次点击确认删除空文件夹")
            return
        end
        local removed, err = state.store_api.remove_folder(state.store, state.current_folder)
        if not removed then
            set_status(state, error_message(err))
            state.confirm_delete_folder = nil
            set_text(state.delete_folder_button, "删除空文件夹")
            return
        end
        state.current_folder = parent_folder(state.current_folder)
        state.confirm_delete_folder = nil
        set_text(state.delete_folder_button, "删除空文件夹")
        set_status(state, "空文件夹已删除")
        refresh_library(state)
    end, "delete_folder")
    b:add(state.folder_tools, state.delete_folder_button, "delete_folder")
    b:add(panel, state.folder_tools, "folder_tools")

    state.list_container = b:make("/Script/UMG.VerticalBox", "list_container")
    b:add(panel, state.list_container, "list_container")
    state.empty_label = b:label("此文件夹为空", "empty_label")
    b:add(state.list_container, state.empty_label, "empty_label")

    state.details = b:make("/Script/UMG.VerticalBox", "details")
    state.selected_label = b:label("未选择蓝图", "selected_label")
    b:add(state.details, state.selected_label, "selected_label")
    state.rename_input = b:input("蓝图新名称", "rename_input")
    b:add(state.details, state.rename_input, "rename_input")
    b:add(state.details, b:button("重命名蓝图", function()
        local entry, err = state.store_api.rename(state.store, state.selected_id,
            from_text(state.rename_input:GetText()))
        if not entry then
            set_status(state, error_message(err))
            return
        end
        set_status(state, "蓝图已重命名")
        refresh_library(state)
    end, "rename"), "rename")
    state.move_input = b:input("目标文件夹完整路径，根目录留空", "move_input")
    b:add(state.details, state.move_input, "move_input")
    b:add(state.details, b:button("移动到目标文件夹", function()
        local entry, err = state.store_api.move(state.store, state.selected_id,
            from_text(state.move_input:GetText()))
        if not entry then
            set_status(state, error_message(err))
            return
        end
        state.current_folder = entry.folder
        set_status(state, "蓝图已移动")
        refresh_library(state)
    end, "move"), "move")
    b:add(state.details, b:button("用原版规划预览粘贴", function()
        start_paste(state)
    end, "paste"), "paste")
    state.delete_button = b:button("删除蓝图", function()
        if state.confirm_delete ~= state.selected_id then
            state.confirm_delete = state.selected_id
            set_text(state.delete_button, "再次点击确认永久删除")
            return
        end
        local deleted, err = state.store_api.delete(state.store, state.selected_id)
        if not deleted then
            set_status(state, error_message(err))
            return
        end
        state.selected_id = nil
        state.confirm_delete = nil
        set_text(state.delete_button, "删除蓝图")
        set_status(state, "蓝图已删除")
        refresh_library(state)
    end, "delete")
    b:add(state.details, state.delete_button, "delete")
    b:add(panel, state.details, "details")
    return b:finish(panel)
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
    local values = {}
    for _, block in ipairs(blocks or {}) do
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
    visibility(state.paste_status, false)
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
        set_status(state, "请先确认或取消当前局部蓝图预览")
        return
    end
    local before, before_error = designer_native.snapshot_frame_blocks(state.designer)
    if not before then
        set_status(state, "无法记录粘贴前积木：" .. tostring(before_error))
        return
    end
    local preview, entry_or_error, section_doc, json_path = state.store_api.paste(
        state.store, state.designer, state.selected_id
    )
    if not preview then
        set_status(state, error_message(entry_or_error))
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
        set_status(state, "无法接管局部预览：" .. tostring(hook_error))
        return
    end
    state.paste.preview_hook = hook
    visibility(state.paste_status, true)
    set_text(state.paste_status, state.paste.controller:status_text())
    set_status(state, string.format("局部预览已启动：%d 个预览；H锁定，Tab方案，R旋转",
        preview.previews))
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
        set_status(state, "局部预览已取消")
        return
    end
    local transform, infer_error = docking.infer_placed_transform(
        paste.before_blocks, after, paste.section_doc or { modules = {} }
    )
    if paste.entry.includes_machines and paste.entry.machines > 0 then
        if not paste.section_doc then
            set_status(state, "壳体已确认，但缺少 Canonical JSON，室内机台未排队")
            return
        elseif not transform then
            set_status(state, "壳体已确认，但放置变换无法唯一闭合：" .. tostring(infer_error))
            return
        elseif type(paste.station_id) ~= "number" or paste.station_id <= 0 then
            set_status(state, "壳体已确认，但空间站 ID 无效，室内机台未排队")
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
            set_status(state, "室内机台任务排队失败：" .. tostring(queue_error))
            return
        end
        set_status(state, string.format("壳体已确认；退出并应用设计后可搭建 %d 台室内机台",
            paste.entry.machines))
    else
        set_status(state, "局部蓝图壳体已确认")
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
    for address, record in pairs(bar.state.action_records) do
        if runtime.actions[address] == record then runtime.actions[address] = nil end
    end
    for _, item in ipairs(bar.state.mounted) do
        if native.is_valid(item.parent) and native.is_valid(item.child) then
            pcall(function() item.parent:RemoveChild(item.child) end)
        end
    end
end

local function mount_pending_machine_bar(state)
    local count = machine_paste.ready_machine_count()
    if count == 0 then
        unmount_pending_machine_bar()
        return
    end
    if runtime.pending_bar then
        set_text(runtime.pending_bar.count_label,
            string.format("待建室内机台：%d 台 [开始搭建] [忽略]", count))
        return
    end
    if not state or not native.is_valid(state.hud)
        or not native.is_valid(state.hud.SaveOptionsContainer) then
        if runtime.pending_log_count ~= count then
            runtime.pending_log_count = count
            log(string.format("待建室内机台：%d 台；可调用 confirm_pending_machines()", count))
        end
        return
    end
    runtime.pending_log_count = nil
    local bar_state = {
        hud = state.hud,
        owner = state.owner,
        detached = false,
        mounted = {},
        action_records = {},
    }
    local parent = state.hud.SaveOptionsContainer
    local count_label = label(bar_state,
        string.format("待建室内机台：%d 台 [开始搭建] [忽略]", count))
    if not count_label then return end
    mount(bar_state, parent, count_label, "machines/pending_count")
    local confirm = button(bar_state, "开始搭建", function() M.confirm_pending_machines() end)
    local dismiss = button(bar_state, "忽略", function() M.dismiss_pending_machines() end)
    if confirm then mount(bar_state, parent, confirm, "machines/confirm") end
    if dismiss then mount(bar_state, parent, dismiss, "machines/dismiss") end
    for address, record in pairs(bar_state.action_records) do
        runtime.actions[address] = record
    end
    runtime.pending_bar = { state = bar_state, count_label = count_label }
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
            log(string.format("machine jobs complete: built=%d configured=%d config_errors=%d",
                built, configured, errors))
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
            set_status(state, string.format("%s积木 %d；当前选中 %d",
                result.action == "added" and "已选择" or "已取消", result.id, result.count))
        else
            set_status(state, "无法切换选区：" .. tostring(toggle_error))
        end
        return
    end
    local paste = state.paste
    if not paste then return end
    local controller = paste.controller
    if action == "lock" then
        controller:toggle_lock()
    elseif action == "next_candidate" or action == "previous_candidate" then
        local _, cycle_error = controller:cycle_candidate(action == "next_candidate" and 1 or -1)
        if cycle_error then set_status(state, "当前没有可轮换的对接候选") end
    elseif action == "rotate" then
        controller:rotate_cw()
    elseif action == "mirror" then
        if not controller:can_mirror() then
            set_status(state, "包含室内机台时禁止镜像，以保护端口方向")
            return
        end
    elseif action == "alt" then
        paste.alt_held = not paste.alt_held
    elseif action == "confirm" then
        if controller.mode ~= "locked" then
            set_status(state, "Enter 仅在 H 锁定后确认；悬浮时可直接左键")
            return
        end
        local confirmed, confirm_error = designer_native.confirm_preview(designer)
        if not confirmed then set_status(state, "原生确认失败：" .. tostring(confirm_error)) end
    elseif action == "left" or action == "right" or action == "forward" or action == "backward"
        or action == "floor_up" or action == "floor_down" then
        local yaw = camera_yaw(session)
        if not yaw then
            set_status(state, "无法读取相机朝向，未执行微调")
            return
        end
        local right = action == "right" and 1 or action == "left" and -1 or 0
        local forward = action == "forward" and 1 or action == "backward" and -1 or 0
        local floor = action == "floor_up" and 1 or action == "floor_down" and -1 or 0
        local _, nudge_error = controller:nudge(right, forward, floor, yaw)
        if nudge_error then set_status(state, "请先按 H 锁定预览再微调") end
    end
    if native.is_valid(state.paste_status) then
        set_text(state.paste_status, controller:status_text())
    end
end

function M.detach(state)
    if not state or state.detached then return true end
    end_paste(state, false)
    state.detached = true
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
    local owner_ok, owner = pcall(function() return hud:GetOwningPlayer() end)
    if not owner_ok or not native.is_valid(owner) then return nil, "missing_owning_player" end
    local baseline, baseline_error = designer_native.snapshot_frame_blocks(designer)
    if not baseline then return nil, "designer_baseline_failed:" .. tostring(baseline_error) end

    local state = {
        hud = hud,
        widget_tree = hud.WidgetTree,
        designer = designer,
        owner = owner,
        store_api = store_api,
        store = store,
        current_folder = "",
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
    state.status = label(state, "原生局部预览与两阶段室内机台搭建（实机核验待完成）")
    if not state.status then return fail_attach(state, "status_label_failed") end

    state.save_button = button(state, "保存局部蓝图", function()
        local selected, select_error = designer_native.activate_select_tool(state.designer, state.hud)
        if not selected then
            set_status(state, "无法进入原生多选模式：" .. tostring(select_error))
            return
        end
        visibility(state.library_panel, false)
        visibility(state.save_form, true)
        set_text(state.save_folder_input, state.current_folder)
        local opened, open_error = open_browser(state)
        if not opened then set_status(state, "无法打开原版蓝图浏览器：" .. tostring(open_error)) end
    end)
    if not state.save_button then return fail_attach(state, "save_entry_button_failed") end
    state.library_button = button(state, "局部蓝图库", function()
        visibility(state.save_form, false)
        visibility(state.library_panel, true)
        local refreshed, refresh_error = refresh_library(state)
        if not refreshed then set_status(state, error_message(refresh_error)) end
        local opened, open_error = open_browser(state)
        if not opened then set_status(state, "无法打开原版蓝图浏览器：" .. tostring(open_error)) end
    end)
    if not state.library_button then return fail_attach(state, "library_entry_button_failed") end

    local mounted, mount_error = mount(state, hud.SaveOptionsContainer, state.save_button, "mount/save_entry")
    if not mounted then return fail_attach(state, mount_error) end
    mounted, mount_error = mount(state, hud.SaveOptionsContainer, state.library_button, "mount/library_entry")
    if not mounted then return fail_attach(state, mount_error) end
    state.paste_status = label(state, "局部蓝图粘贴")
    if not state.paste_status then return fail_attach(state, "paste_status_failed") end
    mounted, mount_error = mount(state, hud.SaveOptionsContainer, state.paste_status, "mount/paste_status")
    if not mounted then return fail_attach(state, mount_error) end
    visibility(state.paste_status, false)
    visibility(save_form, false)
    visibility(library_panel, false)
    visibility(state.details, false)
    local refreshed, refresh_error = refresh_library(state)
    if not refreshed then return fail_attach(state, refresh_error) end
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
