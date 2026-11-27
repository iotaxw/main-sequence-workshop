local library = require("ssb_library")
local native = require("ssb_native_designer")
local payload = require("ssb_payload")
local json = require("ssb_json")

local M = {}

local PRODUCTION_ROOT = "StationSectionBlueprints"
local DEVELOPMENT_ROOT = "StationSectionBlueprints-dev"

local function save_games_directory()
    local local_app_data = os.getenv("LOCALAPPDATA")
    if not local_app_data or local_app_data == "" then
        return nil, "missing_local_app_data"
    end
    return (local_app_data:gsub("\\", "/"):gsub("/+$", ""))
        .. "/MainSequence/Saved/SaveGames"
end

local function index_path(store)
    return store.directory .. "/index.ssb"
end

local function read_text(path)
    local file, open_error = io.open(path, "rb")
    if not file then
        return nil, open_error
    end
    local text = file:read(4 * 1024 * 1024 + 1)
    file:close()
    return text
end

local function path_exists(path)
    return os.rename(path, path) == true
end

local function read_index(store)
    local path = index_path(store)
    local primary, primary_error = read_text(path)
    if primary then
        local state, parse_error = library.parse(store.root, primary)
        if not state then return nil, parse_error end
        return state, nil, "primary"
    end

    local backup_path = path .. ".bak"
    local backup, backup_error = read_text(backup_path)
    if backup then
        local state, parse_error = library.parse(store.root, backup)
        if not state then return nil, "backup_" .. tostring(parse_error) end
        return state, nil, "backup"
    end

    if not path_exists(path) and not path_exists(backup_path) then
        return library.new(store.root)
    end
    return nil, "index_open_failed:primary=" .. tostring(primary_error)
        .. ":backup=" .. tostring(backup_error)
end

local function write_index(store, text)
    local path = index_path(store)
    local temporary = path .. ".tmp"
    local backup = path .. ".bak"
    local file, open_error = io.open(temporary, "wb")
    if not file then
        return nil, "index_open_failed:" .. tostring(open_error)
    end
    local ok, write_error = file:write(text)
    local closed, close_error = file:close()
    if not ok or closed == nil then
        os.remove(temporary)
        return nil, "index_write_failed:" .. tostring(write_error or close_error)
    end

    local existing = io.open(path, "rb")
    if existing then
        existing:close()
        os.remove(backup)
        if not os.rename(path, backup) then
            os.remove(temporary)
            return nil, "index_backup_failed"
        end
    end
    if os.rename(temporary, path) then
        os.remove(backup)
        return true
    end
    if existing then
        os.rename(backup, path)
    end
    os.remove(temporary)
    return nil, "index_replace_failed"
end

local function flush(store)
    local text, err = library.serialize(store.library)
    if not text then return nil, err end
    local written, write_error = write_index(store, text)
    if written then store.directory_ready = true end
    return written, write_error
end

local function restore(store, snapshot)
    local restored, err = library.parse(store.root, snapshot)
    if not restored then return nil, err end
    store.library = restored
    return flush(store)
end

local function commit(store, mutation, ...)
    local snapshot, snapshot_error = library.serialize(store.library)
    if not snapshot then return nil, snapshot_error end
    local results = { pcall(mutation, store.library, ...) }
    if not results[1] then return nil, results[2] end
    if results[2] == nil then return table.unpack(results, 2) end
    local written, write_error = flush(store)
    if not written then
        local restored, restore_error = restore(store, snapshot)
        if not restored then
            return nil, tostring(write_error) .. ":rollback_failed:" .. tostring(restore_error)
        end
        return nil, write_error
    end
    return table.unpack(results, 2)
end

function M.open(options)
    options = options or {}
    local root = options.development == true and DEVELOPMENT_ROOT or PRODUCTION_ROOT
    local parent, path_error = save_games_directory()
    if not parent then return nil, path_error end
    local store = {
        root = root,
        directory = parent .. "/" .. root,
        directory_ready = false,
    }
    local state, read_error, source = read_index(store)
    if not state then return nil, read_error end
    store.library = state
    store.directory_ready = source ~= nil
    return store
end

function M.ensure_directory(store, designer)
    if store.directory_ready then return true end
    local ready, err = native.ensure_directory(designer, store.root)
    if not ready then return nil, err end
    store.directory_ready = true
    return true
end

function M.list(store, folder)
    return library.list(store.library, folder)
end

function M.json_path_for(store, entry_or_id)
    local entry = type(entry_or_id) == "table" and entry_or_id or store.library.entries[entry_or_id]
    if not entry then return nil, "missing_blueprint" end
    return store.directory .. "/items/" .. entry.id .. ".json"
end

function M.load_canonical(store, id)
    local path, path_error = M.json_path_for(store, id)
    if not path then return nil, path_error end
    local file = io.open(path, "rb")
    if not file then return nil, "missing_canonical_json" end
    local text = file:read("*a")
    file:close()
    local document, decode_error = json.decode(text)
    if not document then
        return nil, "invalid_canonical_json:" .. tostring(decode_error)
    end
    if type(document.modules) ~= "table" or type(document.buildings) ~= "table" then
        return nil, "invalid_canonical_json:missing_modules_or_buildings"
    end
    return document
end

local function remove_json(store, id)
    local path = M.json_path_for(store, id)
    if not path or not path_exists(path) then return true end
    local removed, remove_error = os.remove(path)
    if not removed then return nil, "canonical_delete_failed:" .. tostring(remove_error) end
    return true
end

function M.create_folder(store, path, designer)
    local ready, ready_error = M.ensure_directory(store, designer)
    if not ready then return nil, ready_error end
    return commit(store, library.create_folder, path)
end

function M.rename_folder(store, old_path, new_path)
    return commit(store, library.rename_folder, old_path, new_path)
end

function M.remove_folder(store, path)
    return commit(store, library.remove_folder, path)
end

function M.move(store, id, folder)
    return commit(store, library.move, id, folder)
end

function M.rename(store, id, name)
    return commit(store, library.rename, id, name)
end

function M.save_selection(store, designer, metadata)
    if type(metadata) ~= "table" then return nil, "invalid_metadata" end
    if metadata.includes_machines ~= nil and type(metadata.includes_machines) ~= "boolean" then
        return nil, "invalid_machine_flag"
    end
    local valid_name, name_error = library.normalize_name(metadata.name)
    if not valid_name then return nil, name_error end
    local folder, folder_error = library.normalize_folder(metadata.folder)
    if not folder then return nil, folder_error end
    if not store.library.folders[folder] then return nil, "missing_folder" end

    local ids, selection_error = native.selected_block_ids(designer)
    if not ids then return nil, selection_error end
    if #ids == 0 then return nil, "empty_selection" end
    metadata.blocks = #ids
    metadata.machines = 0
    metadata.game_build = native.game_build()
    local entry, entry_error = library.add(store.library, metadata)
    if not entry then return nil, entry_error end
    local slot = library.slot_for(store.library, entry)
    local work_slot = store.root .. "/work/" .. entry.id
    local handle, report_or_error = payload.create_section(designer, work_slot, slot, ids, {
        include_machines = metadata.includes_machines == true,
        name = valid_name,
    })
    if not handle then
        library.remove(store.library, entry.id)
        native.delete_slot(slot)
        remove_json(store, entry)
        return nil, report_or_error
    end
    local report = report_or_error
    if type(report) ~= "table" or type(report.kept_machines) ~= "number" then
        library.remove(store.library, entry.id)
        native.delete_slot(slot)
        remove_json(store, entry)
        return nil, "extract_section_report_mismatch"
    end
    for _, warning in ipairs(report.warnings or {}) do
        print("[StationSectionBlueprints] " .. tostring(warning) .. "\n")
    end
    entry.blocks = #handle.blueprint.Blocks
    entry.machines = report.kept_machines
    store.directory_ready = true
    local written, write_error = flush(store)
    if not written then
        local deleted, delete_error = native.delete_slot(slot)
        remove_json(store, entry)
        library.remove(store.library, entry.id)
        if not deleted then
            return nil, tostring(write_error) .. ":payload_cleanup_failed:" .. tostring(delete_error)
        end
        return nil, write_error
    end
    return entry, report
end

function M.load(store, id)
    local entry, entry_error = library.get(store.library, id)
    if not entry then return nil, entry_error end
    local slot = library.slot_for(store.library, entry)
    local handle, load_error = native.load_from_slot(slot)
    if not handle then return nil, load_error end
    if #handle.blueprint.Blocks ~= entry.blocks or #handle.blueprint.Machines ~= entry.machines then
        return nil, "blueprint_stats_mismatch"
    end
    return handle
end

function M.paste(store, designer, id)
    local entry, entry_error = library.get(store.library, id)
    if not entry then return nil, entry_error end
    local handle, load_error = M.load(store, id)
    if not handle then return nil, load_error end
    local section_doc, canonical_error = M.load_canonical(store, id)
    if not section_doc and canonical_error ~= "missing_canonical_json" then
        return nil, canonical_error
    end
    local preview, preview_error = native.start_clipboard_preview(designer, handle.blueprint)
    if not preview then return nil, preview_error end
    local json_path = M.json_path_for(store, entry)
    return preview, entry, section_doc, json_path
end

function M.delete(store, id)
    local entry, entry_error = library.get(store.library, id)
    if not entry then return nil, entry_error end
    local slot = library.slot_for(store.library, entry)
    if not slot then return nil, "missing_blueprint_slot" end
    local snapshot, snapshot_error = library.serialize(store.library)
    if not snapshot then return nil, snapshot_error end
    library.remove(store.library, id)
    local written, write_error = flush(store)
    if not written then
        local restored, restore_error = restore(store, snapshot)
        if not restored then
            return nil, tostring(write_error) .. ":rollback_failed:" .. tostring(restore_error)
        end
        return nil, write_error
    end
    local deleted, delete_error = native.delete_slot(slot)
    if not deleted then
        local restored, restore_error = restore(store, snapshot)
        if not restored then
            return nil, tostring(delete_error) .. ":index_restore_failed:" .. tostring(restore_error)
        end
        return nil, delete_error
    end
    local json_deleted, json_delete_error = remove_json(store, entry)
    if not json_deleted then
        return nil, json_delete_error
    end
    return true
end

return M
