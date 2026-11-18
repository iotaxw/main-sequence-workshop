local native = require("ssb_native")
local blueprint_library = require("ssb_library")

local M = {}

local BUTTON_CLASS = "/Game/Blueprints/Widgets/Basic/WBP_Button_Text.WBP_Button_Text_C"
local runtime = _G.__StationSectionBlueprintsUIRuntime
if not runtime then
    runtime = { actions = {}, keybind_registered = false }
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

local function ensure_keybind()
    if runtime.keybind_registered then return true end
    local ok, err = pcall(RegisterKeyBind, Key.LEFT_MOUSE_BUTTON, function()
        ExecuteInGameThread(dispatch_hovered)
    end)
    if not ok then return nil, err end
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
        state.machine_checkbox:SetIsEnabled(false)
    end
    b:add(machine_row, state.machine_checkbox, "machine_checkbox")
    b:add(machine_row, b:label("包含内部机器（尚未通过原生验证）", "machine_label"), "machine_label")
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
        if state.machine_checkbox:IsChecked() then
            set_status(state, "机器保存尚未通过原生验证，请保持机器选项关闭")
            return
        end
        local entry, err = state.store_api.save_selection(state.store, state.designer, {
            name = from_text(state.name_input:GetText()),
            folder = folder,
            includes_machines = false,
        })
        if not entry then
            set_status(state, error_message(err))
            return
        end
        state.current_folder = entry.folder
        set_status(state, string.format("已保存 %s：%d 积木，%d 机器", entry.name, entry.blocks, entry.machines))
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
        local preview, err = state.store_api.paste(state.store, state.designer, state.selected_id)
        if not preview then
            set_status(state, error_message(err))
            return
        end
        set_status(state, string.format("已交给原版规划系统：%d 个预览；请使用原版确认或取消", preview.previews))
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

function M.detach(state)
    if not state or state.detached then return true end
    state.detached = true
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
    }
    attaching_state = state
    local save_form, save_form_error = build_save_form(state)
    if not save_form then return fail_attach(state, save_form_error) end
    state.save_form = save_form
    local library_panel, library_error = build_library_panel(state)
    if not library_panel then return fail_attach(state, library_error) end
    state.library_panel = library_panel
    state.status = label(state, "粘贴交给原版预览与确认；机器、材料与联机边界仍在验证")
    if not state.status then return fail_attach(state, "status_label_failed") end

    state.save_button = button(state, "保存局部蓝图", function()
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
