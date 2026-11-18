local native = require("ssb_native")

local M = {}

local STATION_FRAME_TYPE = 0

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

local function valid_slot(slot)
    if type(slot) ~= "string" or #slot == 0 or #slot > 180 then
        return false
    end
    local previous = 0
    for index = 1, #slot do
        local byte = slot:byte(index)
        local allowed = (byte >= 48 and byte <= 57)
            or (byte >= 65 and byte <= 90)
            or (byte >= 97 and byte <= 122)
            or byte == 45 or byte == 46 or byte == 47 or byte == 37 or byte == 95
        if not allowed then
            return false
        end
        if byte == 46 and previous == 46 then
            return false
        end
        if byte == 47 and (index == 1 or index == #slot or previous == 47) then
            return false
        end
        previous = byte
    end
    return true
end

local function gameplay_statics()
    local class = native.find_type("/Script/Engine.GameplayStatics")
    if not class then
        return nil
    end
    return class:GetCDO()
end

function M.find_designer()
    local found = {}
    ForEachUObject(function(object)
        if native.class_name(object) ~= "Designer" then
            return
        end
        local full_name = native.full_name(object)
        if not full_name:find("Default__", 1, true) then
            found[object:GetAddress()] = object
        end
    end)
    local designer
    for _, object in pairs(found) do
        if designer then
            return nil, "multiple_designers"
        end
        designer = object
    end
    return designer, designer and nil or "no_active_designer"
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
    if not native.is_valid(designer) then
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

return M
