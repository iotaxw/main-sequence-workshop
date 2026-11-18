local M = {}

local FORMAT_VERSION = 1
local ROOT = ""

local function trim(value)
    return value:match("^%s*(.-)%s*$")
end

local function valid_text(value, allow_empty, maximum)
    if type(value) ~= "string" or #value > maximum then
        return false
    end
    if not allow_empty and value == "" then
        return false
    end
    return not value:find("%c")
end

function M.encode(value)
    return (value:gsub(".", function(character)
        local byte = character:byte()
        if (byte >= 48 and byte <= 57) or (byte >= 65 and byte <= 90)
            or (byte >= 97 and byte <= 122) or byte == 45 or byte == 46
            or byte == 95 or byte == 126 then
            return character
        end
        return string.format("%%%02X", byte)
    end))
end

function M.decode(value)
    if type(value) ~= "string" then
        return nil, "invalid_encoding"
    end
    local position = 1
    while true do
        local percent = value:find("%", position, true)
        if not percent then
            break
        end
        if not value:sub(percent + 1, percent + 2):match("^%x%x$") then
            return nil, "invalid_encoding"
        end
        position = percent + 3
    end
    local valid = value:gsub("%%(%x%x)", function(hex)
        return string.char(tonumber(hex, 16))
    end)
    return valid
end

function M.normalize_name(value)
    if type(value) ~= "string" then
        return nil, "invalid_name"
    end
    local name = trim(value)
    if not valid_text(name, false, 160) then
        return nil, "invalid_name"
    end
    return name
end

function M.normalize_folder(value)
    value = value or ROOT
    if type(value) ~= "string" or #value > 480 then
        return nil, "invalid_folder"
    end
    value = trim(value):gsub("\\", "/")
    if value == ROOT then
        return ROOT
    end
    local parts = {}
    for part in (value .. "/"):gmatch("(.-)/") do
        local normalized = trim(part)
        if normalized == "" or normalized == "." or normalized == ".."
            or not valid_text(normalized, false, 80) then
            return nil, "invalid_folder"
        end
        parts[#parts + 1] = normalized
        if #parts > 16 then
            return nil, "invalid_folder"
        end
    end
    return table.concat(parts, "/")
end

local function valid_root(root_name)
    return type(root_name) == "string" and root_name:match("^[A-Za-z0-9][A-Za-z0-9_-]*$") ~= nil
end

function M.new(root_name)
    if not valid_root(root_name) then
        return nil, "invalid_root"
    end
    return {
        root = root_name,
        entries = {},
        folders = { [ROOT] = true },
        sequence = 0,
    }
end

local function parent_folder(folder)
    if folder == ROOT then
        return nil
    end
    return folder:match("^(.*)/[^/]+$") or ROOT
end

local function add_folder_unchecked(library, folder)
    while folder do
        library.folders[folder] = true
        folder = parent_folder(folder)
    end
end

function M.create_folder(library, value)
    local folder, err = M.normalize_folder(value)
    if not folder then
        return nil, err
    end
    if folder == ROOT then
        return nil, "root_exists"
    end
    if library.folders[folder] then
        return nil, "folder_exists"
    end
    add_folder_unchecked(library, folder)
    return folder
end

local function normalize_count(value)
    local number = tonumber(value)
    if not number or number < 0 or number > 1000000 or number % 1 ~= 0 then
        return nil, "invalid_count"
    end
    return number
end

local function normalized_entry(metadata)
    if type(metadata) ~= "table" then
        return nil, "invalid_metadata"
    end
    local name, name_error = M.normalize_name(metadata.name)
    if not name then
        return nil, name_error
    end
    local folder, folder_error = M.normalize_folder(metadata.folder)
    if not folder then
        return nil, folder_error
    end
    local blocks, block_error = normalize_count(metadata.blocks)
    if not blocks or blocks == 0 then
        return nil, block_error or "invalid_count"
    end
    local machines, machine_error = normalize_count(metadata.machines)
    if not machines then
        return nil, machine_error
    end
    if not valid_text(metadata.game_build, false, 80) then
        return nil, "invalid_game_build"
    end
    return {
        name = name,
        folder = folder,
        includes_machines = metadata.includes_machines == true,
        blocks = blocks,
        machines = machines,
        game_build = metadata.game_build,
        created_at = metadata.created_at or os.date("!%Y-%m-%dT%H:%M:%SZ"),
    }
end

function M.add(library, metadata)
    local entry, err = normalized_entry(metadata)
    if not entry then
        return nil, err
    end
    if not library.folders[entry.folder] then
        return nil, "missing_folder"
    end
    repeat
        library.sequence = (library.sequence + 1) % 0x1000000
        entry.id = string.format("%08x-%06x", os.time(), library.sequence)
    until not library.entries[entry.id]
    library.entries[entry.id] = entry
    return entry
end

function M.get(library, id)
    local entry = library.entries[id]
    if not entry then
        return nil, "missing_blueprint"
    end
    return entry
end

function M.slot_for(library, entry_or_id)
    local entry = type(entry_or_id) == "table" and entry_or_id or library.entries[entry_or_id]
    if not entry then
        return nil, "missing_blueprint"
    end
    return library.root .. "/items/" .. entry.id
end

function M.move(library, id, folder_value)
    local entry, entry_error = M.get(library, id)
    if not entry then
        return nil, entry_error
    end
    local folder, folder_error = M.normalize_folder(folder_value)
    if not folder then
        return nil, folder_error
    end
    if not library.folders[folder] then
        return nil, "missing_folder"
    end
    entry.folder = folder
    return entry
end

function M.rename(library, id, name_value)
    local entry, entry_error = M.get(library, id)
    if not entry then
        return nil, entry_error
    end
    local name, name_error = M.normalize_name(name_value)
    if not name then
        return nil, name_error
    end
    entry.name = name
    return entry
end

function M.remove(library, id)
    if not library.entries[id] then
        return nil, "missing_blueprint"
    end
    library.entries[id] = nil
    return true
end

local function descendants(library, folder)
    local prefix = folder == ROOT and "" or folder .. "/"
    local folders = {}
    for candidate in pairs(library.folders) do
        if candidate ~= folder and (folder == ROOT or candidate:sub(1, #prefix) == prefix) then
            folders[#folders + 1] = candidate
        end
    end
    return folders, prefix
end

function M.rename_folder(library, old_value, new_value)
    local old_folder, old_error = M.normalize_folder(old_value)
    local new_folder, new_error = M.normalize_folder(new_value)
    if not old_folder then
        return nil, old_error
    end
    if not new_folder then
        return nil, new_error
    end
    if old_folder == ROOT or not library.folders[old_folder] then
        return nil, "missing_folder"
    end
    if library.folders[new_folder] then
        return nil, "folder_exists"
    end
    local prefix = old_folder .. "/"
    if new_folder:sub(1, #prefix) == prefix then
        return nil, "folder_cycle"
    end
    local old_folders, _ = descendants(library, old_folder)
    old_folders[#old_folders + 1] = old_folder
    local changed = {}
    for _, folder in ipairs(old_folders) do
        local suffix = folder:sub(#old_folder + 1)
        changed[folder] = new_folder .. suffix
        if library.folders[new_folder .. suffix] then
            return nil, "folder_exists"
        end
    end
    for folder, replacement in pairs(changed) do
        library.folders[folder] = nil
        library.folders[replacement] = true
    end
    add_folder_unchecked(library, parent_folder(new_folder))
    for _, entry in pairs(library.entries) do
        if entry.folder == old_folder or entry.folder:sub(1, #prefix) == prefix then
            entry.folder = new_folder .. entry.folder:sub(#old_folder + 1)
        end
    end
    return new_folder
end

function M.remove_folder(library, value)
    local folder, err = M.normalize_folder(value)
    if not folder then
        return nil, err
    end
    if folder == ROOT or not library.folders[folder] then
        return nil, "missing_folder"
    end
    local children, prefix = descendants(library, folder)
    if #children > 0 then
        return nil, "folder_not_empty"
    end
    for _, entry in pairs(library.entries) do
        if entry.folder == folder or entry.folder:sub(1, #prefix) == prefix then
            return nil, "folder_not_empty"
        end
    end
    library.folders[folder] = nil
    return true
end

function M.list(library, folder_value)
    local folder, err = M.normalize_folder(folder_value)
    if not folder then
        return nil, err
    end
    if not library.folders[folder] then
        return nil, "missing_folder"
    end
    local result = { folder = folder, folders = {}, blueprints = {} }
    local prefix = folder == ROOT and "" or folder .. "/"
    local start = #prefix + 1
    for candidate in pairs(library.folders) do
        if candidate ~= folder and candidate:sub(1, #prefix) == prefix then
            local remainder = candidate:sub(start)
            if remainder ~= "" and not remainder:find("/", 1, true) then
                result.folders[#result.folders + 1] = { name = remainder, path = candidate }
            end
        end
    end
    for _, entry in pairs(library.entries) do
        if entry.folder == folder then
            result.blueprints[#result.blueprints + 1] = entry
        end
    end
    table.sort(result.folders, function(a, b) return a.name:lower() < b.name:lower() end)
    table.sort(result.blueprints, function(a, b)
        if a.name:lower() == b.name:lower() then
            return a.id < b.id
        end
        return a.name:lower() < b.name:lower()
    end)
    return result
end

local function sorted_folders(library)
    local folders = {}
    for folder in pairs(library.folders) do
        if folder ~= ROOT then
            folders[#folders + 1] = folder
        end
    end
    table.sort(folders)
    return folders
end

local function sorted_entries(library)
    local entries = {}
    for _, entry in pairs(library.entries) do
        entries[#entries + 1] = entry
    end
    table.sort(entries, function(a, b) return a.id < b.id end)
    return entries
end

function M.serialize(library)
    local lines = { "SSB_LIBRARY\t" .. FORMAT_VERSION }
    for _, folder in ipairs(sorted_folders(library)) do
        lines[#lines + 1] = "F\t" .. M.encode(folder)
    end
    for _, entry in ipairs(sorted_entries(library)) do
        if not library.folders[entry.folder] then
            return nil, "missing_folder"
        end
        lines[#lines + 1] = table.concat({
            "B",
            entry.id,
            M.encode(entry.name),
            M.encode(entry.folder),
            entry.includes_machines and "1" or "0",
            tostring(entry.blocks),
            tostring(entry.machines),
            M.encode(entry.game_build),
            M.encode(entry.created_at),
        }, "\t")
    end
    return table.concat(lines, "\n") .. "\n"
end

function M.parse(root_name, text)
    local library, root_error = M.new(root_name)
    if not library then
        return nil, root_error
    end
    if type(text) ~= "string" or #text > 4 * 1024 * 1024 then
        return nil, "invalid_index"
    end
    local lines = {}
    for line in (text .. "\n"):gmatch("(.-)\r?\n") do
        lines[#lines + 1] = line
    end
    if lines[1] ~= "SSB_LIBRARY\t1" then
        return nil, "unsupported_index"
    end
    for index = 2, #lines do
        local line = lines[index]
        if line ~= "" then
            local fields = {}
            for field in (line .. "\t"):gmatch("(.-)\t") do
                fields[#fields + 1] = field
            end
            if fields[1] == "F" and #fields == 2 then
                local folder, decode_error = M.decode(fields[2])
                if not folder then
                    return nil, decode_error
                end
                local normalized, folder_error = M.normalize_folder(folder)
                if not normalized or normalized ~= folder or normalized == ROOT then
                    return nil, folder_error or "invalid_folder"
                end
                if library.folders[folder] then
                    return nil, "duplicate_folder"
                end
                add_folder_unchecked(library, folder)
            elseif fields[1] == "B" and #fields == 9 then
                local decoded = {}
                for _, field_index in ipairs({ 3, 4, 8, 9 }) do
                    local value, decode_error = M.decode(fields[field_index])
                    if not value then
                        return nil, decode_error
                    end
                    decoded[field_index] = value
                end
                local entry, entry_error = normalized_entry({
                    name = decoded[3],
                    folder = decoded[4],
                    includes_machines = fields[5] == "1",
                    blocks = fields[6],
                    machines = fields[7],
                    game_build = decoded[8],
                    created_at = decoded[9],
                })
                if not entry or (fields[5] ~= "0" and fields[5] ~= "1") then
                    return nil, entry_error or "invalid_machine_flag"
                end
                if not fields[2]:match("^%x+%-%x+$") or library.entries[fields[2]] then
                    return nil, "invalid_or_duplicate_id"
                end
                entry.id = fields[2]
                library.entries[entry.id] = entry
            else
                return nil, "invalid_index_record:" .. tostring(index)
            end
        end
    end
    for _, entry in pairs(library.entries) do
        if not library.folders[entry.folder] then
            return nil, "missing_folder"
        end
    end
    return library
end

return M
