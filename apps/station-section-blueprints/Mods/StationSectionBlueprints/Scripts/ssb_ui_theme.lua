-- Shared Main Sequence native UMG styling & widget factory.
-- Reuses the game's own WBP_Text_C (Saira font) and WBP_Button_Text_C / WBP_CleanButton_Text_C
-- so Designer panels, confirmation bars, and top-right TTL toasts share one consistent visual language.

local native = require("ssb_native")

local M = {}

M.CLASSES = {
    BUTTON_TEXT = "/Game/Blueprints/Widgets/Basic/WBP_Button_Text.WBP_Button_Text_C",
    CLEAN_BUTTON_TEXT = "/Game/Blueprints/Widgets/Basic/WBP_CleanButton_Text.WBP_CleanButton_Text_C",
    TEXT = "/Game/Blueprints/Widgets/Basic/WBP_Text.WBP_Text_C",
    WIDGET_LIBRARY = "/Script/UMG.WidgetBlueprintLibrary",
    BORDER = "/Script/UMG.Border",
    VERTICAL_BOX = "/Script/UMG.VerticalBox",
    HORIZONTAL_BOX = "/Script/UMG.HorizontalBox",
    SCROLL_BOX = "/Script/UMG.ScrollBox",
    SIZE_BOX = "/Script/UMG.SizeBox",
    SPACER = "/Script/UMG.Spacer",
    PROGRESS_BAR = "/Script/UMG.ProgressBar",
    TEXT_BLOCK = "/Script/UMG.TextBlock",
    EDITABLE_TEXT_BOX = "/Script/UMG.EditableTextBox",
    CHECK_BOX = "/Script/UMG.CheckBox",
    CANVAS_PANEL = "/Script/UMG.CanvasPanel",
}

M.VISIBILITY = {
    Visible = 0,
    Collapsed = 1,
    Hidden = 2,
    HitTestInvisible = 3,
    SelfHitTestInvisible = 4,
}

M.PALETTE = {
    surface = { R = 0.035, G = 0.055, B = 0.095, A = 0.93 },
    surface_alt = { R = 0.055, G = 0.085, B = 0.145, A = 0.95 },
    header = { R = 0.065, G = 0.115, B = 0.190, A = 0.96 },
    input_bg = { R = 0.020, G = 0.035, B = 0.065, A = 0.96 },
    border = { R = 0.210, G = 0.510, B = 0.720, A = 0.85 },
    border_subtle = { R = 0.150, G = 0.300, B = 0.440, A = 0.65 },
    divider = { R = 0.190, G = 0.410, B = 0.580, A = 0.45 },
    text_primary = { R = 0.920, G = 0.960, B = 1.000, A = 1.00 },
    text_secondary = { R = 0.700, G = 0.800, B = 0.900, A = 1.00 },
    text_muted = { R = 0.540, G = 0.650, B = 0.760, A = 1.00 },
    tones = {
        info = { R = 0.240, G = 0.760, B = 0.960, A = 1.00 },
        success = { R = 0.220, G = 0.840, B = 0.560, A = 1.00 },
        warn = { R = 0.960, G = 0.730, B = 0.220, A = 1.00 },
        error = { R = 0.950, G = 0.340, B = 0.340, A = 1.00 },
    },
}

function M.tone_color(tone)
    return M.PALETTE.tones[tone or "info"] or M.PALETTE.tones.info
end

function M.slate_color(color)
    local c = type(color) == "table" and color or M.PALETTE.text_primary
    return {
        SpecifiedColor = {
            R = c.R or 1.0,
            G = c.G or 1.0,
            B = c.B or 1.0,
            A = c.A or 1.0,
        },
        ColorUseRule = 0,
    }
end

function M.set_text_color(widget, color)
    if not native.is_valid(widget) or type(color) ~= "table" then return end
    local slate = M.slate_color(color)
    local ok = pcall(function() widget:SetColour(slate) end)
    if not ok then
        pcall(function() widget:SetColorAndOpacity(slate) end)
    end
end

function M.to_text(value)
    local ok, text = pcall(FText, tostring(value or ""))
    if not ok then
        return nil, text
    end
    return text
end

function M.from_text(value)
    local ok, text = pcall(function()
        return value:ToString()
    end)
    return ok and text or ""
end

function M.set_text(widget, value)
    if not native.is_valid(widget) then
        return nil, "invalid_text_widget"
    end
    local text, err = M.to_text(value)
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

function M.set_visibility(widget, visible, mode)
    if not native.is_valid(widget) then return end
    local target = visible and (mode or M.VISIBILITY.SelfHitTestInvisible) or M.VISIBILITY.Collapsed
    pcall(function()
        widget:SetVisibility(target)
    end)
end

function M.construct(widget_tree, class_path)
    if not native.is_valid(widget_tree) then
        return nil, "missing_widget_tree"
    end
    local class = native.find_type(class_path)
    if not class then
        return nil, "missing_widget_class:" .. tostring(class_path)
    end
    local flags = (EObjectFlags and (EObjectFlags.RF_Public | EObjectFlags.RF_Standalone)) or 0
    local ok, widget = pcall(StaticConstructObject, class, widget_tree, 0, flags)
    if not ok or not native.is_valid(widget) then
        return nil, "widget_construction_failed:" .. tostring(class_path)
    end
    return widget
end

function M.create_user_widget_by_class(context_object, owner, class)
    if not native.is_valid(class) then
        return nil, "invalid_widget_class"
    end
    local library_class = native.find_type(M.CLASSES.WIDGET_LIBRARY)
    if not library_class then
        return nil, "missing_widget_library"
    end
    local ok, widget = pcall(function()
        return library_class:GetCDO():Create(context_object, class, owner)
    end)
    if not ok or not native.is_valid(widget) then
        return nil, "user_widget_creation_failed:" .. tostring(widget)
    end
    return widget
end

function M.create_user_widget(context_object, owner, class_path)
    local class = native.find_type(class_path)
    if not class then
        return nil, "missing_widget_class:" .. tostring(class_path)
    end
    return M.create_user_widget_by_class(context_object, owner, class)
end

local function copy_button_visuals(widget, reference)
    if not native.is_valid(widget) or not native.is_valid(reference) then return end
    pcall(function()
        local sz = reference.TextSize
        if type(sz) == "number" and sz > 0 then
            if type(widget.SetSize) == "function" then
                widget:SetSize(sz)
            else
                widget.TextSize = sz
            end
        end
    end)
    for _, prop in ipairs({ "TextPadding", "DefaultColour", "HoveredColour", "PressedColour", "DisabledColour", "ColorAndOpacity" }) do
        pcall(function()
            local val = reference[prop]
            if val ~= nil then
                widget[prop] = val
            end
        end)
    end
    pcall(function()
        if type(widget.Refresh) == "function" then
            widget:Refresh()
        end
    end)
end

function M.find_sibling_button(hud, container)
    if not native.is_valid(hud) then return nil end
    local function inspect_candidate(candidate)
        if not native.is_valid(candidate) then return nil end
        local cname = native.class_name(candidate)
        if cname == "SizeBox" or cname == "Border" then
            local ok_ch, inner = pcall(function() return candidate:GetChildAt(0) end)
            if ok_ch and native.is_valid(inner) then
                local ok_txt, has_set = pcall(function() return type(inner.SetText) == "function" end)
                if ok_txt and has_set then
                    return { button = inner, wrapper = candidate, slot_holder = candidate, class_name = native.class_name(inner) }
                end
            end
            return nil
        end
        local ok_txt, has_set = pcall(function() return type(candidate.SetText) == "function" end)
        if not ok_txt or not has_set then return nil end
        local wrapper = nil
        local slot_holder = candidate
        local ok_par, parent = pcall(function() return candidate:GetParent() end)
        if ok_par and native.is_valid(parent) and native.is_valid(container)
            and parent:GetAddress() ~= container:GetAddress() then
            local pclass = native.class_name(parent)
            if pclass == "SizeBox" or pclass == "Border" then
                wrapper = parent
                slot_holder = parent
            end
        end
        return { button = candidate, wrapper = wrapper, slot_holder = slot_holder, class_name = cname }
    end

    -- Prefer direct siblings inside the exact target container first so class, wrapper SizeBox and Slot match 1:1.
    if native.is_valid(container) then
        local ok_cnt, count = pcall(function() return container:GetChildrenCount() end)
        if ok_cnt and type(count) == "number" then
            for i = 0, math.min(count - 1, 15) do
                local ok_ch, child = pcall(function() return container:GetChildAt(i) end)
                if ok_ch and child then
                    local info = inspect_candidate(child)
                    if info then return info end
                end
            end
        end
    end
    for _, field in ipairs({ "OpenButton", "SaveButton", "SavePreset" }) do
        local ok_f, btn = pcall(function() return hud[field] end)
        if ok_f and btn then
            local info = inspect_candidate(btn)
            if info then return info end
        end
    end
    return nil
end

function M.copy_slot_layout(target_slot, source_slot)
    if not native.is_valid(target_slot) or not native.is_valid(source_slot) then return end
    pcall(function()
        local pad = source_slot.Padding
        if pad ~= nil then target_slot:SetPadding(pad) end
    end)
    pcall(function()
        local ha = source_slot.HorizontalAlignment
        if ha ~= nil then target_slot:SetHorizontalAlignment(ha) end
    end)
    pcall(function()
        local va = source_slot.VerticalAlignment
        if va ~= nil then target_slot:SetVerticalAlignment(va) end
    end)
    pcall(function()
        local sz = source_slot.Size
        if sz ~= nil then target_slot:SetSize(sz) end
    end)
end

function M.wrap_like(widget_tree, child, wrapper_ref)
    if not native.is_valid(wrapper_ref) or not native.is_valid(widget_tree) then
        return child
    end
    local wclass = native.class_name(wrapper_ref)
    if wclass == "SizeBox" then
        local box = M.construct(widget_tree, M.CLASSES.SIZE_BOX)
        if box then
            pcall(function()
                if wrapper_ref.bOverride_WidthOverride and type(wrapper_ref.WidthOverride) == "number" then
                    box:SetWidthOverride(wrapper_ref.WidthOverride)
                end
            end)
            pcall(function()
                if wrapper_ref.bOverride_HeightOverride and type(wrapper_ref.HeightOverride) == "number" then
                    box:SetHeightOverride(wrapper_ref.HeightOverride)
                end
            end)
            pcall(function()
                if wrapper_ref.bOverride_MinDesiredWidth and type(wrapper_ref.MinDesiredWidth) == "number" then
                    box:SetMinDesiredWidth(wrapper_ref.MinDesiredWidth)
                end
            end)
            pcall(function()
                if wrapper_ref.bOverride_MinDesiredHeight and type(wrapper_ref.MinDesiredHeight) == "number" then
                    box:SetMinDesiredHeight(wrapper_ref.MinDesiredHeight)
                end
            end)
            if M.add_child(box, child) then
                return box
            end
        end
    end
    return child
end

function M.create_button(context_object, owner, caption, opts)
    opts = opts or {}
    local widget, err
    if opts.reference and native.is_valid(opts.reference) then
        local ok_cls, ref_cls = pcall(function() return opts.reference:GetClass() end)
        if ok_cls and native.is_valid(ref_cls) then
            widget, err = M.create_user_widget_by_class(context_object, owner, ref_cls)
            if widget then
                copy_button_visuals(widget, opts.reference)
            end
        end
    end
    if not widget then
        local preferred = opts.clean and M.CLASSES.CLEAN_BUTTON_TEXT or M.CLASSES.BUTTON_TEXT
        widget, err = M.create_user_widget(context_object, owner, preferred)
        if not widget and opts.clean then
            widget, err = M.create_user_widget(context_object, owner, M.CLASSES.BUTTON_TEXT)
        end
    end
    if not widget then
        return nil, err
    end
    local text_ok, text_err = M.set_text(widget, caption)
    if not text_ok then
        return nil, text_err
    end
    return widget
end

function M.create_text(context_object, owner, widget_tree, value, opts)
    opts = opts or {}
    local widget = M.create_user_widget(context_object, owner, M.CLASSES.TEXT)
    if widget then
        M.set_text(widget, value)
        if type(opts.size) == "number" then
            pcall(function() widget:SetSize(opts.size) end)
        end
        if type(opts.color) == "table" then
            M.set_text_color(widget, opts.color)
        end
        if type(opts.wrap) == "number" and opts.wrap > 0 then
            pcall(function() widget:SetWrapLength(opts.wrap) end)
        end
        return widget
    end
    -- Clean fallback to UMG TextBlock when WBP_Text_C is unavailable (e.g. unit-test stubs)
    local block, block_err = M.construct(widget_tree, M.CLASSES.TEXT_BLOCK)
    if not block then
        return nil, block_err
    end
    local text_ok, text_err = M.set_text(block, value)
    if not text_ok then
        return nil, text_err
    end
    if type(opts.color) == "table" then
        M.set_text_color(block, opts.color)
    end
    if type(opts.wrap) == "number" and opts.wrap > 0 then
        pcall(function() block:SetAutoWrapText(true) end)
    end
    return block
end

function M.add_child(parent, child, padding)
    if not native.is_valid(parent) or not native.is_valid(child) then
        return nil, "invalid_parent_or_child"
    end
    local ok, slot = pcall(function()
        return parent:AddChild(child)
    end)
    if not ok or not native.is_valid(slot) then
        return nil, "add_child_failed:" .. tostring(slot)
    end
    if type(padding) == "table" then
        pcall(function()
            slot:SetPadding({
                Left = padding.Left or padding[1] or 0,
                Top = padding.Top or padding[2] or 0,
                Right = padding.Right or padding[3] or 0,
                Bottom = padding.Bottom or padding[4] or 0,
            })
        end)
    end
    return slot
end

function M.create_border(widget_tree, color, padding)
    local border, err = M.construct(widget_tree, M.CLASSES.BORDER)
    if not border then return nil, err end
    if type(color) == "table" then
        pcall(function() border:SetBrushColor(color) end)
    end
    if type(padding) == "table" then
        pcall(function()
            border:SetPadding({
                Left = padding.Left or padding[1] or 0,
                Top = padding.Top or padding[2] or 0,
                Right = padding.Right or padding[3] or 0,
                Bottom = padding.Bottom or padding[4] or 0,
            })
        end)
    end
    return border
end

-- Creates a framed dark sci-fi card: outer accent/hairline border -> inner dark slate surface -> child VerticalBox.
function M.create_framed_panel(widget_tree, opts)
    opts = opts or {}
    local frame_pad = opts.border_width or 1.5
    local outer, outer_err = M.create_border(
        widget_tree,
        opts.border_color or M.PALETTE.border,
        { frame_pad, frame_pad, frame_pad, frame_pad }
    )
    if not outer then return nil, outer_err end
    local inner, inner_err = M.create_border(
        widget_tree,
        opts.surface_color or M.PALETTE.surface,
        opts.padding or { 12, 10, 12, 10 }
    )
    if not inner then return nil, inner_err end
    local body, body_err = M.construct(widget_tree, M.CLASSES.VERTICAL_BOX)
    if not body then return nil, body_err end
    local s1, e1 = M.add_child(outer, inner)
    if not s1 then return nil, e1 end
    local s2, e2 = M.add_child(inner, body)
    if not s2 then return nil, e2 end
    return { outer = outer, inner = inner, body = body }
end

function M.create_divider(widget_tree, color, height)
    local box, err = M.construct(widget_tree, M.CLASSES.SIZE_BOX)
    if not box then return nil, err end
    pcall(function() box:SetHeightOverride(height or 1.0) end)
    local line, line_err = M.create_border(widget_tree, color or M.PALETTE.divider, { 0, 0, 0, 0 })
    if not line then return nil, line_err end
    local slot, slot_err = M.add_child(box, line)
    if not slot then return nil, slot_err end
    return box
end

function M.create_input(widget_tree, hint)
    local input, err = M.construct(widget_tree, M.CLASSES.EDITABLE_TEXT_BOX)
    if not input then return nil, err end
    local text, text_err = M.to_text(hint or "")
    if not text then return nil, text_err end
    pcall(function() input:SetHintText(text) end)
    local frame, frame_err = M.create_border(widget_tree, M.PALETTE.border_subtle, { 1, 1, 1, 1 })
    if not frame then return input, input end
    local bg, bg_err = M.create_border(widget_tree, M.PALETTE.input_bg, { 6, 4, 6, 4 })
    if not bg then return input, input end
    if M.add_child(frame, bg) and M.add_child(bg, input) then
        return frame, input
    end
    return input, input
end

function M.place_on_canvas(canvas, child, spec)
    spec = spec or {}
    local slot, err = M.add_child(canvas, child)
    if not slot then return nil, err end
    pcall(function()
        if spec.anchors then
            slot:SetAnchors(spec.anchors)
        end
        if spec.alignment then
            slot:SetAlignment(spec.alignment)
        end
        if spec.position then
            slot:SetPosition(spec.position)
        end
        if spec.size then
            slot:SetSize(spec.size)
        end
        if spec.auto_size ~= nil then
            slot:SetAutoSize(spec.auto_size == true)
        end
        if type(spec.z_order) == "number" then
            slot:SetZOrder(spec.z_order)
        end
    end)
    return slot
end

function M.is_canvas_panel(widget)
    if not native.is_valid(widget) then return false end
    if native.class_name(widget) == "CanvasPanel" then
        return true
    end
    local cls = native.find_type(M.CLASSES.CANVAS_PANEL)
    if cls and type(widget.IsA) == "function" then
        local ok, is_canvas = pcall(function() return widget:IsA(cls) end)
        if ok and is_canvas == true then
            return true
        end
    end
    return false
end

function M.find_canvas_in_hud(hud)
    if not native.is_valid(hud) then return nil end
    for _, field in ipairs({ "Canvas", "CanvasPanel", "CanvasPanel_0" }) do
        local ok_c, direct = pcall(function() return hud[field] end)
        if ok_c and M.is_canvas_panel(direct) then
            return direct
        end
    end
    local ok_root, root = pcall(function() return hud.WidgetTree and hud.WidgetTree.RootWidget end)
    if not ok_root or not native.is_valid(root) then
        return nil
    end
    if M.is_canvas_panel(root) then
        return root
    end
    -- Bounded local BFS (max depth 3, max 16 nodes) in case RootWidget is an Overlay/ScaleBox wrapping CanvasPanel.
    local queue = { { node = root, depth = 0 } }
    local head, visited = 1, 0
    while head <= #queue and visited < 16 do
        local item = queue[head]
        head = head + 1
        visited = visited + 1
        if item.depth < 3 then
            local ok_cnt, count = pcall(function() return item.node:GetChildrenCount() end)
            if ok_cnt and type(count) == "number" and count > 0 then
                for i = 0, math.min(count - 1, 7) do
                    local ok_ch, child = pcall(function() return item.node:GetChildAt(i) end)
                    if ok_ch and native.is_valid(child) then
                        if M.is_canvas_panel(child) then
                            return child
                        end
                        queue[#queue + 1] = { node = child, depth = item.depth + 1 }
                    end
                end
            else
                local ok_ch, first = pcall(function() return item.node:GetChildAt(0) end)
                if ok_ch and native.is_valid(first) then
                    if M.is_canvas_panel(first) then
                        return first
                    end
                    queue[#queue + 1] = { node = first, depth = item.depth + 1 }
                end
            end
        end
    end
    return nil
end

local function is_live_object(object)
    if not native.is_valid(object) then return false end
    local flags = (EObjectFlags and (EObjectFlags.RF_ClassDefaultObject | EObjectFlags.RF_ArchetypeObject)) or 0
    if flags ~= 0 then
        local ok, flagged = pcall(function() return object:HasAnyFlags(flags) end)
        if not ok or flagged == true then return false end
    end
    return true
end

function M.is_widget_visible(widget)
    if not is_live_object(widget) then return false end
    local ok_vp, in_vp = pcall(function() return widget:IsInViewport() end)
    if not ok_vp or in_vp ~= true then return false end
    local ok_vis, vis = pcall(function() return widget:GetVisibility() end)
    if not ok_vis or vis == M.VISIBILITY.Collapsed or vis == M.VISIBILITY.Hidden then
        return false
    end
    return true
end

-- Exact concrete Blueprint HUD classes only.
-- NEVER query broad base classes like "UserWidget" via FindAllOf (crashes UE4SS 4.0.0 on UE 5.7.4).
M.PREFERRED_HUD_CLASSES = {
    "WBP_DesignerHUD_C",
    "WBP_CharacterHUD_C",
    "WBP_HUDMarkerManager_C",
    "WBP_PlayStateStatus_C",
    "WBP_DisassemblyHUD_C",
    "WBP_MainMenu_C",
}

local CONTROLLER_HUD_FIELDS = {
    "CharacterHUDWidget",
    "HUDMarkerManager",
    "PlayStateWidget",
    "DisassemblyHUD",
}

-- Locates a live, visible in-viewport HUD with a CanvasPanel using exact leaf classes only (UE4SS 4.0.0 / UE 5.7 safe).
-- opts.exclude_classes: optional map { [class_name] = true } to skip specific HUDs (e.g. DesignerHUD in world mode).
function M.find_active_hud_host(opts)
    if type(FindAllOf) ~= "function" then return nil end
    opts = opts or {}
    local excluded = opts.exclude_classes or {}
    local function try_hud(widget, fallback_owner)
        if not M.is_widget_visible(widget) then return nil end
        local cname = native.class_name(widget)
        if excluded[cname] then return nil end
        local canvas = M.find_canvas_in_hud(widget)
        if not canvas or not native.is_valid(widget.WidgetTree) then return nil end
        local owner = nil
        local ok_owner, owned = pcall(function() return widget:GetOwningPlayer() end)
        if ok_owner and is_live_object(owned) then
            owner = owned
        elseif is_live_object(fallback_owner) then
            owner = fallback_owner
        end
        if not owner then return nil end
        return { hud = widget, canvas = canvas, widget_tree = widget.WidgetTree, owner = owner, class_name = cname }
    end

    -- 1. Direct controller HUD references (O(1), touches only 1-2 controller instances).
    for _, ctrl_cls in ipairs({ "BP_PlayerController_C", "BP_DesignerController_C" }) do
        local ok_pc, list = pcall(FindAllOf, ctrl_cls)
        if ok_pc and type(list) == "table" then
            for _, pc in ipairs(list) do
                if is_live_object(pc) then
                    local ok_pawn, pawn = pcall(function() return pc.Pawn end)
                    if ok_pawn and is_live_object(pawn) then
                        local ok_dh, dh = pcall(function() return pawn.DesignerHUD end)
                        if ok_dh and dh then
                            local found = try_hud(dh, pc)
                            if found then return found end
                        end
                    end
                    for _, field in ipairs(CONTROLLER_HUD_FIELDS) do
                        local ok_w, w = pcall(function() return pc[field] end)
                        if ok_w and w then
                            local found = try_hud(w, pc)
                            if found then return found end
                        end
                    end
                end
            end
        end
    end

    -- 2. Exact concrete HUD Blueprint classes only (never base class "UserWidget").
    for _, cls in ipairs(opts.preferred_classes or M.PREFERRED_HUD_CLASSES) do
        if type(cls) == "string" and cls ~= "UserWidget" and not excluded[cls] then
            local ok, list = pcall(FindAllOf, cls)
            if ok and type(list) == "table" then
                for _, hud in ipairs(list) do
                    local found = try_hud(hud)
                    if found then return found end
                end
            end
        end
    end

    return nil
end

return M
