local native = require("ssb_native")

local M = {}

local STATION_FRAME_TYPE = 0
local DEFAULT_OBJECT_FLAGS

local function is_cdo(object)
    if not native.is_valid(object) then
        return true
    end
    local full_name = native.full_name(object)
    if full_name:find("Default__", 1, true) then
        return true
    end
    DEFAULT_OBJECT_FLAGS = DEFAULT_OBJECT_FLAGS
        or (EObjectFlags.RF_ClassDefaultObject | EObjectFlags.RF_ArchetypeObject)
    local ok, flagged = pcall(function()
        return object:HasAnyFlags(DEFAULT_OBJECT_FLAGS)
    end)
    return not ok or flagged == true
end

local function is_live(object)
    return native.is_valid(object) and not is_cdo(object)
end

local function ensure_station(designer)
    local ok, frame_type = pcall(function()
        return designer:GetBlueprintType()
    end)
    if not ok then
        return nil, "blueprint_type_unavailable"
    end
    if frame_type ~= STATION_FRAME_TYPE then
        return nil, "station_only"
    end
    return true
end

local function valid_utf8(text)
    local index = 1
    while index <= #text do
        local first = text:byte(index)
        if first < 0x80 then
            index = index + 1
        else
            local count, minimum, codepoint
            if first >= 0xC2 and first <= 0xDF then
                count, minimum, codepoint = 2, 0x80, first - 0xC0
            elseif first >= 0xE0 and first <= 0xEF then
                count, minimum, codepoint = 3, 0x800, first - 0xE0
            elseif first >= 0xF0 and first <= 0xF4 then
                count, minimum, codepoint = 4, 0x10000, first - 0xF0
            else
                return false
            end
            if index + count - 1 > #text then return false end
            for offset = 1, count - 1 do
                local byte = text:byte(index + offset)
                if not byte or byte < 0x80 or byte > 0xBF then return false end
                codepoint = codepoint * 0x40 + byte - 0x80
            end
            if codepoint < minimum or codepoint > 0x10FFFF
                or (codepoint >= 0xD800 and codepoint <= 0xDFFF) then
                return false
            end
            index = index + count
        end
    end
    return true
end

local function valid_slot(slot)
    if type(slot) ~= "string" or #slot == 0 or #slot > 180 then
        return false
    end
    if slot:find("\\", 1, true) or slot:find("..", 1, true)
        or slot:find("//", 1, true) or slot:sub(1, 1) == "/"
        or slot:sub(-1) == "/" or slot:find('[<>:"|?*]') then
        return false
    end
    for index = 1, #slot do
        local byte = slot:byte(index)
        if byte < 32 or byte == 127 then return false end
    end
    return valid_utf8(slot)
end

local function gameplay_statics()
    local class = native.find_type("/Script/Engine.GameplayStatics")
    if not class then
        return nil
    end
    return class:GetCDO()
end

local CONTROLLER_CLASSES = {
    "BP_PlayerController_C",
    "BP_DesignerController_C",
}

local function inspect_controller_candidates(visitor)
    if type(FindAllOf) == "function" then
        local seen = {}
        for _, class_name in ipairs(CONTROLLER_CLASSES) do
            local ok, objects = pcall(FindAllOf, class_name)
            if ok and type(objects) == "table" then
                for _, controller in ipairs(objects) do
                    if native.is_valid(controller) then
                        local addr_ok, address = pcall(function()
                            return controller:GetAddress()
                        end)
                        local key = addr_ok and address or controller
                        if not seen[key] then
                            seen[key] = true
                            visitor(controller)
                        end
                    end
                end
            end
        end
        return true
    end
    if type(ForEachUObject) == "function" then
        ForEachUObject(visitor)
        return true
    end
    return false
end

function M.find_session()
    local sessions = {}
    local session_error
    inspect_controller_candidates(function(controller)
        local controller_class = native.class_name(controller)
        if controller_class ~= "BP_PlayerController_C" and controller_class ~= "BP_DesignerController_C" then
            return
        end
        if is_cdo(controller) then
            return
        end
        local pawn_ok, pawn = pcall(function()
            return controller.Pawn
        end)
        if not pawn_ok or not is_live(pawn) or native.class_name(pawn) ~= "BP_DesignerPawn_C" then
            return
        end
        local component_ok, component = pcall(function()
            return pawn.BPC_Designer
        end)
        if not component_ok or not is_live(component) then
            session_error = "invalid_designer_component"
            return
        end
        local designer_ok, designer = pcall(function()
            return component.Designer
        end)
        if not designer_ok or not is_live(designer) then
            session_error = "invalid_session_designer"
            return
        end
        local owner_ok, owner = pcall(function()
            return designer.Controller
        end)
        if not owner_ok or not is_live(owner) or owner:GetAddress() ~= controller:GetAddress() then
            session_error = "designer_controller_mismatch"
            return
        end
        local hud_ok, hud = pcall(function()
            return pawn.DesignerHUD
        end)
        sessions[#sessions + 1] = {
            controller = controller,
            pawn = pawn,
            component = component,
            designer = designer,
            hud = hud_ok and is_live(hud) and hud or nil,
        }
    end)
    if #sessions > 1 then
        return nil, "multiple_designer_sessions"
    end
    if #sessions == 0 then
        return nil, session_error or "no_designer_session"
    end
    return sessions[1]
end

function M.find_designer()
    local session, session_error = M.find_session()
    if not session then
        return nil, session_error
    end
    return session.designer
end

local function is_instance_of(object, class_path)
    if not native.is_valid(object) then
        return false
    end
    local short_expected = tostring(class_path):match("([^.]+)$")
    if short_expected and native.class_name(object) == short_expected then
        return true
    end
    if type(object.IsA) ~= "function" then
        return true
    end
    local cls = native.find_type(class_path)
    if cls then
        local ok, result = pcall(function()
            return object:IsA(cls)
        end)
        if ok and type(result) == "boolean" then
            return result
        end
    end
    local ok_str, result_str = pcall(function()
        return object:IsA(class_path)
    end)
    if ok_str and type(result_str) == "boolean" then
        return result_str
    end
    return false
end

local function read_block_object(block)
    if not is_live(block) then return nil end
    local ok, id, cls, transform, palette_id = pcall(function()
        return block.ID, block:GetClass(), block.GridTransform, block.PaletteID
    end)
    if not ok or type(id) ~= "number" or not native.is_valid(cls) or transform == nil then
        return nil
    end
    local ok_t, gx, gy, height, rot = pcall(function()
        return transform.GridLocation.X, transform.GridLocation.Y, transform.Height, transform.GridRotation
    end)
    if not ok_t or type(gx) ~= "number" or type(gy) ~= "number" or type(height) ~= "number" or type(rot) ~= "number" then
        return nil
    end
    return {
        id = id,
        class_name = native.short_name(cls),
        gx = gx,
        gy = gy,
        height = height,
        rot = rot % 4,
        palette_id = type(palette_id) == "number" and palette_id or 0,
    }
end

local function read_blueprint_entry(entry)
    if type(entry) ~= "table" and type(entry) ~= "userdata" then return nil end
    local ok, id, cls, transform, palette_id = pcall(function()
        return entry.BlockID, entry.Class, entry.Transform, entry.PaletteID
    end)
    if not ok or type(id) ~= "number" or not native.is_valid(cls) or transform == nil then
        return nil
    end
    local ok_t, gx, gy, height, rot = pcall(function()
        return transform.GridLocation.X, transform.GridLocation.Y, transform.Height, transform.GridRotation
    end)
    if not ok_t or type(gx) ~= "number" or type(gy) ~= "number" or type(height) ~= "number" or type(rot) ~= "number" then
        return nil
    end
    return {
        id = id,
        class_name = native.short_name(cls),
        gx = gx,
        gy = gy,
        height = height,
        rot = rot % 4,
        palette_id = type(palette_id) == "number" and palette_id or 0,
    }
end

local function read_array_items(array_obj, max_count)
    local items = {}
    if array_obj == nil then return nil end
    local ok_fe = pcall(function()
        if type(array_obj.ForEach) == "function" then
            array_obj:ForEach(function(_, elem)
                if #items >= max_count then return true end
                local ok_get, val = pcall(function()
                    return type(elem) == "userdata" and type(elem.Get) == "function" and elem:Get() or elem
                end)
                if ok_get and val ~= nil then
                    items[#items + 1] = val
                end
            end)
        else
            error("no_foreach")
        end
    end)
    if ok_fe then return items end
    local ok_len, count = pcall(function() return #array_obj end)
    if not ok_len or type(count) ~= "number" then return nil end
    local limit = math.min(count, max_count)
    for index = 1, limit do
        local ok_at, raw = pcall(function() return array_obj[index] end)
        if ok_at and raw ~= nil then
            local ok_get, val = pcall(function()
                return type(raw) == "userdata" and type(raw.Get) == "function" and raw:Get() or raw
            end)
            if ok_get and val ~= nil then
                items[#items + 1] = val
            end
        end
    end
    return items
end

-- Reads live station blocks directly from BuildingFrame.BuildingBlocks (or Designer.UnattachedBlueprint.Blocks)
-- without calling Designer:GetBlueprintForSaving(), avoiding UE4SS 4.0.0 / UE 5.7.4 crashes when marshalling
-- FBuildBlueprint.Screenshot.GreyscaleValues (TArray<uint8>) into a Lua table.
function M.snapshot_frame_blocks(designer)
    if not is_live(designer) then
        return nil, "invalid_designer"
    end
    local station, station_error = ensure_station(designer)
    if not station then
        return nil, station_error
    end

    -- 1. Live attached station frame: BuildingFrame.BuildingBlocks (TArray<UBuildingBlockObject*>)
    local ok_frame, frame = pcall(function() return designer.Frame end)
    if ok_frame and is_live(frame) then
        local ok_arr, blocks_arr = pcall(function() return frame.BuildingBlocks end)
        if ok_arr and blocks_arr ~= nil then
            local raw_items = read_array_items(blocks_arr, 65536)
            if raw_items and #raw_items > 0 then
                local result = {}
                for _, block in ipairs(raw_items) do
                    local parsed = read_block_object(block)
                    if parsed then
                        result[#result + 1] = parsed
                    end
                end
                if #result > 0 then
                    return result
                end
            end
        end
    end

    -- 2. Standalone Designer (or empty frame): Designer.UnattachedBlueprint.Blocks (lazy StructProperty userdata, never touches Screenshot)
    local ok_unattached, unattached_blocks = pcall(function()
        return designer.UnattachedBlueprint and designer.UnattachedBlueprint.Blocks
    end)
    if ok_unattached and unattached_blocks ~= nil then
        local raw_entries = read_array_items(unattached_blocks, 65536)
        if raw_entries then
            local result = {}
            for _, entry in ipairs(raw_entries) do
                local parsed = read_blueprint_entry(entry)
                if parsed then
                    result[#result + 1] = parsed
                end
            end
            return result
        end
    end

    -- If frame is valid and simply has 0 blocks (empty canvas), return empty list cleanly instead of failing attach.
    if ok_frame and is_live(frame) then
        return {}
    end
    return nil, "frame_blocks_unavailable"
end

function M.block_id_for_actor(designer, actor)
    if not native.is_valid(designer) or not native.is_valid(actor) then
        return nil, "invalid_designer_or_actor"
    end
    if designer:HasAnyFlags(EObjectFlags.RF_ClassDefaultObject | EObjectFlags.RF_ArchetypeObject)
        or actor:HasAnyFlags(EObjectFlags.RF_ClassDefaultObject | EObjectFlags.RF_ArchetypeObject) then
        return nil, "default_object_rejected"
    end
    if not is_instance_of(actor, "/Script/MainSequence.BuildingBlock") then
        return nil, "not_building_block_actor"
    end
    local station, station_error = ensure_station(designer)
    if not station then
        return nil, station_error
    end
    local frame = designer.Frame
    if not native.is_valid(frame) or frame:HasAnyFlags(EObjectFlags.RF_ClassDefaultObject | EObjectFlags.RF_ArchetypeObject) then
        return nil, "invalid_frame"
    end
    local ok, simulation = pcall(function()
        return actor:GetSimulationObject()
    end)
    if not ok or not native.is_valid(simulation) then
        return nil, "simulation_object_unavailable"
    end
    if simulation:HasAnyFlags(EObjectFlags.RF_ClassDefaultObject | EObjectFlags.RF_ArchetypeObject) then
        return nil, "default_simulation_rejected"
    end
    if not is_instance_of(simulation, "/Script/MainSequence.BuildingBlockObject") then
        return nil, "not_building_block_simulation"
    end
    local simulation_frame = simulation:GetFrame()
    if not native.is_valid(simulation_frame) or simulation_frame:GetAddress() ~= frame:GetAddress() then
        return nil, "simulation_frame_mismatch"
    end
    if not native.is_valid(simulation.Actor) or simulation.Actor:GetAddress() ~= actor:GetAddress() then
        return nil, "simulation_actor_mismatch"
    end
    if simulation:GetClass():GetAddress() ~= actor.BlockClass:GetAddress() then
        return nil, "simulation_class_mismatch"
    end
    local id = simulation.ID
    if type(id) ~= "number" or id <= 0 or id % 1 ~= 0 then
        return nil, "invalid_simulation_id"
    end

    local blocks, blocks_err = M.snapshot_frame_blocks(designer)
    if not blocks then
        return nil, blocks_err or "blueprint_unavailable"
    end
    local matched
    for _, entry in ipairs(blocks) do
        if entry.id == id then
            if matched then
                return nil, "duplicate_blueprint_id:" .. tostring(id)
            end
            matched = entry
        end
    end
    if not matched then
        return nil, "simulation_id_not_in_blueprint:" .. tostring(id)
    end
    if matched.class_name ~= native.short_name(simulation:GetClass()) then
        return nil, "blueprint_class_mismatch"
    end
    local actual = simulation.GridTransform
    if actual.GridLocation.X ~= matched.gx
        or actual.GridLocation.Y ~= matched.gy
        or actual.Height ~= matched.height
        or (actual.GridRotation % 4) ~= matched.rot
        or simulation.PaletteID ~= matched.palette_id then
        return nil, "blueprint_transform_mismatch"
    end
    return id
end

function M.selected_block_ids(designer)
    if not native.is_valid(designer) then
        return nil, "invalid_designer"
    end
    local selected = designer.SelectedActors
    local count = #selected
    if count > 64 then
        return nil, "selection_limit_exceeded"
    end
    local ids, seen = {}, {}
    for index = 1, count do
        local id, id_error = M.block_id_for_actor(designer, selected[index])
        if not id then
            return nil, id_error
        end
        if seen[id] then
            return nil, "duplicate_selected_block:" .. tostring(id)
        end
        seen[id] = true
        ids[#ids + 1] = id
    end
    return ids
end

function M.add_block_to_selection(designer, actor)
    local id, id_error = M.block_id_for_actor(designer, actor)
    if not id then
        return nil, id_error
    end
    local before = #designer.SelectedActors
    designer:AddBlockToSelection(actor)
    if #designer.SelectedActors ~= before + 1 then
        return nil, "selection_not_added:" .. tostring(id)
    end
    if designer.SelectedActors[before + 1]:GetAddress() ~= actor:GetAddress() then
        return nil, "selection_actor_mismatch:" .. tostring(id)
    end
    return id
end

function M.toggle_block_in_selection(designer, actor)
    local id, id_error = M.block_id_for_actor(designer, actor)
    if not id then
        return nil, id_error
    end
    local selected = designer.SelectedActors
    local count = #selected
    if count > 65536 then
        return nil, "selection_limit_exceeded"
    end
    local actor_address = actor:GetAddress()
    local selected_index
    local seen = {}
    for index = 1, count do
        local current = selected[index]
        if not is_live(current) then
            return nil, "invalid_selected_actor"
        end
        local address = current:GetAddress()
        if seen[address] then
            return nil, "duplicate_selected_actor"
        end
        seen[address] = true
        if address == actor_address then
            selected_index = index
        end
    end
    if not selected_index then
        local added, add_error = M.add_block_to_selection(designer, actor)
        if not added then
            return nil, add_error
        end
        return { action = "added", id = id, count = #designer.SelectedActors }
    end

    local remaining = {}
    for index = 1, count do
        if index ~= selected_index then
            local current = selected[index]
            local valid_id, valid_error = M.block_id_for_actor(designer, current)
            if not valid_id then
                return nil, valid_error
            end
            remaining[#remaining + 1] = current
        end
    end
    designer:ResetSelection()
    for _, current in ipairs(remaining) do
        local added, add_error = M.add_block_to_selection(designer, current)
        if not added then
            return nil, add_error
        end
    end
    return { action = "removed", id = id, count = #designer.SelectedActors }
end

function M.activate_select_tool(designer, hud)
    if not native.is_valid(designer) or not native.is_valid(hud) then
        return nil, "invalid_designer_or_hud"
    end
    if designer:HasAnyFlags(EObjectFlags.RF_ClassDefaultObject | EObjectFlags.RF_ArchetypeObject)
        or hud:HasAnyFlags(EObjectFlags.RF_ClassDefaultObject | EObjectFlags.RF_ArchetypeObject) then
        return nil, "default_object_rejected"
    end
    if designer:GetDesignerTool() == 1 then
        return true
    end
    local event_name = "BndEvt__WBP_DesignerHUD_SelectToolButton_K2Node_ComponentBoundEvent_14_OnButtonPressedEvent__DelegateSignature"
    local event
    hud:GetClass():ForEachFunction(function(fn)
        if fn:GetFName():ToString() == event_name then
            event = fn
        end
    end)
    if not event then
        return nil, "select_tool_event_unavailable"
    end
    local parameters = 0
    event:ForEachProperty(function()
        parameters = parameters + 1
        if parameters > 8 then return true end
    end)
    if parameters ~= 0 then
        return nil, "select_tool_event_signature_mismatch"
    end
    hud[event_name](hud)
    if designer:GetDesignerTool() ~= 1 then
        return nil, "select_tool_activation_failed"
    end
    return true
end

local function capture_blueprint(designer, include_machines, consume)
    if not is_live(designer) then
        return nil, "invalid_designer"
    end
    local expected = include_machines == true
    local station, station_error = ensure_station(designer)
    if not station then
        return nil, station_error
    end
    if #designer.PlacementPreviews > 0 then
        return nil, "placement_already_active"
    end

    local hook_path = "/Script/MainSequence.Designer:GetBlueprintForSaving"
    local getter = native.find_type(hook_path)
    if not getter or native.full_name(getter) ~= "Function " .. hook_path then
        return nil, "blueprint_getter_unavailable"
    end

    local triggered = false
    local capture_error
    local captured_counts
    local captured_value
    local function capture(self, return_param, include_machines)
        if triggered then
            capture_error = "duplicate_blueprint_capture"
            return
        end
        triggered = true
        local ok, err = xpcall(function()
            if include_machines:Get() ~= expected then
                error("unexpected_machine_flag", 0)
            end
            local target = self:Get()
            if not native.is_valid(target) or target:GetAddress() ~= designer:GetAddress() then
                error("capture_target_mismatch", 0)
            end
            if target:HasAnyFlags(EObjectFlags.RF_ClassDefaultObject | EObjectFlags.RF_ArchetypeObject) then
                error("default_capture_target_rejected", 0)
            end
            local blueprint = return_param:Get()
            if type(blueprint) ~= "userdata" then
                error("native_blueprint_not_struct", 0)
            end
            local counts = { #blueprint.Blocks, #blueprint.Connectors, #blueprint.Machines }
            if counts[1] == 0 or counts[1] > 65536 or counts[2] > 65536 or counts[3] > 65536 then
                error("native_blueprint_count_out_of_bounds", 0)
            end
            captured_value = consume(target, blueprint)
            captured_counts = counts
            -- Prevent UE4SS 4.0.0 / UE 5.7.4 crash when ProcessEvent marshals ReturnValue.Screenshot.GreyscaleValues
            -- (large TArray<uint8>) into a Lua table after our post-hook returns.
            pcall(function()
                if blueprint.Screenshot and blueprint.Screenshot.GreyscaleValues then
                    blueprint.Screenshot.GreyscaleValues:Empty()
                end
            end)
        end, function(value)
            return type(value) == "string" and value or "native_blueprint_capture_failed"
        end)
        if not ok then
            capture_error = err
        end
    end

    local registered, pre_id, post_id = pcall(RegisterHook, hook_path, function() end, capture)
    if not registered or type(pre_id) ~= "number" or type(post_id) ~= "number" then
        return nil, "blueprint_hook_registration_failed"
    end
    local called, call_error = pcall(function()
        designer:GetBlueprintForSaving(expected)
    end)
    local unhooked, unhook_error = pcall(UnregisterHook, hook_path, pre_id, post_id)
    if not unhooked then
        return nil, "blueprint_hook_cleanup_failed:" .. tostring(unhook_error)
    end
    if not called then
        return nil, "blueprint_getter_failed:" .. tostring(call_error)
    end
    if capture_error then
        return nil, capture_error
    end
    if not triggered or not captured_counts then
        return nil, "blueprint_not_captured"
    end
    return captured_value, captured_counts
end

function M.copy_blueprint_to_clipboard(designer)
    local clipboard, counts_or_error = capture_blueprint(designer, false, function(target, blueprint)
        target:SetClipboard(blueprint)
        return target.Clipboard
    end)
    if not clipboard then
        return nil, counts_or_error
    end
    if #clipboard.Blocks ~= counts_or_error[1]
        or #clipboard.Connectors ~= counts_or_error[2]
        or #clipboard.Machines ~= counts_or_error[3] then
        return nil, "clipboard_reload_failed"
    end
    return clipboard
end

function M.copy_blueprint_to_save_game(designer, include_machines)
    local save_game, counts_or_error = capture_blueprint(designer, include_machines == true, function(target, blueprint)
        local created, create_error = M.create_save_game(target, blueprint, false)
        if not created then
            error(create_error, 0)
        end
        return created
    end)
    if not save_game then
        return nil, counts_or_error
    end
    if not native.is_valid(save_game) then
        return nil, "save_game_capture_failed"
    end
    local blueprint = save_game.Blueprint
    if #blueprint.Blocks ~= counts_or_error[1]
        or #blueprint.Connectors ~= counts_or_error[2]
        or #blueprint.Machines ~= counts_or_error[3] then
        return nil, "save_game_blueprint_mismatch"
    end
    return save_game
end

function M.is_valid_slot(slot)
    return valid_slot(slot)
end

function M.copy_selection(designer)
    if not native.is_valid(designer) then
        return nil, "invalid_designer"
    end
    local station, station_error = ensure_station(designer)
    if not station then
        return nil, station_error
    end
    if #designer.SelectedActors == 0 then
        return nil, "empty_selection"
    end
    designer:CopySelectionToClipboard()
    local blueprint = designer.Clipboard
    if #blueprint.Blocks == 0 then
        return nil, "empty_native_clipboard"
    end
    return blueprint
end

function M.create_save_game(designer, blueprint, persistent)
    if not native.is_valid(designer) then
        return nil, "invalid_designer"
    end
    local class = native.find_type("/Script/MainSequence.DesignSaveGame")
    if not class then
        return nil, "missing_design_save_game"
    end
    local flags = EObjectFlags.RF_Public | EObjectFlags.RF_Standalone
    if persistent == true then
        flags = flags | EObjectFlags.RF_MarkAsRootSet
    end
    local save_game = StaticConstructObject(class, designer, 0, flags)
    if not native.is_valid(save_game) then
        return nil, "save_game_construction_failed"
    end
    save_game.Blueprint = blueprint
    return save_game
end

function M.save_to_slot(save_game, slot)
    if not native.is_valid(save_game) then
        return nil, "invalid_save_game"
    end
    if not valid_slot(slot) then
        return nil, "invalid_slot"
    end
    local statics = gameplay_statics()
    if not statics then
        return nil, "missing_gameplay_statics"
    end
    local ok, saved = pcall(function()
        return statics:SaveGameToSlot(save_game, slot, 0)
    end)
    if not ok or not saved then
        return nil, "native_save_failed"
    end
    return true
end

function M.load_from_slot(slot)
    if not valid_slot(slot) then
        return nil, "invalid_slot"
    end
    local statics = gameplay_statics()
    if not statics then
        return nil, "missing_gameplay_statics"
    end
    local ok, save_game = pcall(function()
        return statics:LoadGameFromSlot(slot, 0)
    end)
    if not ok or not native.is_valid(save_game) then
        return nil, "native_load_failed"
    end
    if native.class_name(save_game) ~= "DesignSaveGame" then
        return nil, "unexpected_save_game_type"
    end
    return { blueprint = save_game.Blueprint, owner = save_game }
end

function M.delete_slot(slot)
    if not valid_slot(slot) then
        return nil, "invalid_slot"
    end
    local statics = gameplay_statics()
    if not statics then
        return nil, "missing_gameplay_statics"
    end
    local ok, deleted = pcall(function()
        if not statics:DoesSaveGameExist(slot, 0) then
            return true
        end
        return statics:DeleteGameInSlot(slot, 0)
    end)
    if not ok or not deleted then
        return nil, "native_delete_failed"
    end
    return true
end

function M.ensure_directory(designer, root)
    if not native.is_valid(designer) then
        return nil, "invalid_designer"
    end
    local save_game, construction_error = M.create_save_game(designer, designer.Clipboard, false)
    if not save_game then
        return nil, construction_error
    end
    local slot = root .. "/items/.bootstrap"
    local saved, save_error = M.save_to_slot(save_game, slot)
    if not saved then
        return nil, save_error
    end
    local deleted, delete_error = M.delete_slot(slot)
    if not deleted then
        return nil, "bootstrap_cleanup_failed:" .. tostring(delete_error)
    end
    return true
end

function M.game_build()
    local statics = gameplay_statics()
    if not statics then
        return "unverified"
    end
    local ok, version = pcall(function()
        return statics:GetGameVersion()
    end)
    if ok and type(version) == "string" and version ~= "" then
        return version
    end
    return "unverified"
end

function M.start_clipboard_preview(designer, blueprint)
    if not is_live(designer) then
        return nil, "invalid_designer"
    end
    local station, station_error = ensure_station(designer)
    if not station then
        return nil, station_error
    end
    if #blueprint.Blocks == 0 then
        return nil, "empty_blueprint"
    end
    if #designer.PlacementPreviews > 0 then
        return nil, "placement_already_active"
    end
    designer:SetClipboard(blueprint)
    if #designer.Clipboard.Blocks ~= #blueprint.Blocks then
        return nil, "clipboard_reload_failed"
    end
    designer:StartPreviewingClipboard()
    return {
        previews = #designer.PlacementPreviews,
        valid = designer.bValidPlacement,
        connected = designer.bPlacementConnected,
    }
end

local function vector_components(value)
    local ok, components = pcall(function()
        return { X = value.X, Y = value.Y, Z = value.Z }
    end)
    if not ok then return nil end
    for _, component in pairs(components) do
        if type(component) ~= "number" or component ~= component
            or component == math.huge or component == -math.huge then
            return nil
        end
    end
    return components
end

function M.frame_actor_transform(designer)
    if not is_live(designer) then
        return nil, "invalid_designer"
    end
    local ok, frame, actor = pcall(function()
        return designer.Frame, designer.Frame.Actor
    end)
    if not ok or not is_live(frame) or not is_live(actor) then
        return nil, "invalid_frame_actor"
    end
    local read_ok, location, rotation = pcall(function()
        return actor:K2_GetActorLocation(), actor:K2_GetActorRotation()
    end)
    if not read_ok then
        return nil, "frame_actor_transform_unavailable"
    end
    local origin = vector_components(location)
    local yaw, pitch, roll = rotation.Yaw, rotation.Pitch, rotation.Roll
    if not origin or type(yaw) ~= "number" or type(pitch) ~= "number" or type(roll) ~= "number" then
        return nil, "frame_actor_transform_invalid"
    end
    return {
        origin = origin,
        rotation = { Yaw = yaw, Pitch = pitch, Roll = roll },
    }
end

local function restore_preview_snapping(handle)
    if handle.snapping_changed and is_live(handle.designer) then
        local ok, err = pcall(function()
            handle.designer:SetSnapping(handle.original_snapping)
        end)
        if not ok then
            handle.last_error = "restore_snapping_failed:" .. tostring(err)
        end
    end
    handle.snapping_changed = false
end

function M.remove_preview_hook(handle)
    if type(handle) ~= "table" or handle.removed then
        return true
    end
    handle.active = false
    handle.removed = true
    restore_preview_snapping(handle)
    local ok, err = pcall(UnregisterHook, handle.path, handle.pre_id, handle.post_id)
    if not ok then
        return nil, "preview_hook_cleanup_failed:" .. tostring(err)
    end
    return not handle.last_error, handle.last_error
end

function M.install_preview_hook(designer, resolver)
    if not is_live(designer) then
        return nil, "invalid_designer"
    end
    if type(resolver) ~= "function" then
        return nil, "invalid_preview_resolver"
    end
    local path = "/Script/MainSequence.Designer:UpdatePreview"
    local getter = native.find_type(path)
    if not getter or native.full_name(getter) ~= "Function " .. path then
        return nil, "preview_function_unavailable"
    end
    local snapping_ok, original_snapping = pcall(function()
        return designer.bSnapping
    end)
    if not snapping_ok or type(original_snapping) ~= "boolean" then
        return nil, "preview_snapping_unavailable"
    end
    local handle = {
        designer = designer,
        path = path,
        active = true,
        removed = false,
        original_snapping = original_snapping,
        snapping_changed = false,
    }
    local function pre_hook(self, intersect_val, hit_val)
        if not handle.active then return end
        local target_ok, matches = pcall(function()
            return self:Get():GetAddress() == designer:GetAddress()
        end)
        if not target_ok or not matches then return end
        if not is_live(designer) then
            handle.active = false
            return
        end
        local ok, result = xpcall(function()
            return resolver(designer, intersect_val, hit_val)
        end, debug.traceback)
        if not ok or type(result) ~= "table" then
            handle.last_error = "preview_resolver_failed:" .. tostring(result)
            restore_preview_snapping(handle)
            return
        end
        if result.suppress_snapping == true and original_snapping then
            local snapped, snap_error = pcall(function()
                designer:SetSnapping(false)
            end)
            if not snapped then
                handle.last_error = "disable_snapping_failed:" .. tostring(snap_error)
                return
            end
            handle.snapping_changed = true
        else
            restore_preview_snapping(handle)
        end
        local written, write_error = pcall(function()
            local intersect = intersect_val:Get()
            intersect.X = result.x
            intersect.Y = result.y
            intersect.Z = result.z
        end)
        if not written then
            handle.last_error = "preview_intersect_write_failed:" .. tostring(write_error)
            restore_preview_snapping(handle)
        end
    end
    local registered, pre_id, post_id = pcall(RegisterHook, path, pre_hook, function() end)
    if not registered or type(pre_id) ~= "number" or type(post_id) ~= "number" then
        return nil, "preview_hook_registration_failed"
    end
    handle.pre_id = pre_id
    handle.post_id = post_id
    return handle
end

local function preview_action(designer, method)
    if not is_live(designer) then
        return nil, "invalid_designer"
    end
    local ok, err = pcall(function()
        designer[method](designer)
    end)
    if not ok then
        return nil, method .. "_failed:" .. tostring(err)
    end
    return true
end

function M.confirm_preview(designer)
    return preview_action(designer, "Confirm")
end

function M.cancel_preview(designer)
    return preview_action(designer, "Cancel")
end

return M
