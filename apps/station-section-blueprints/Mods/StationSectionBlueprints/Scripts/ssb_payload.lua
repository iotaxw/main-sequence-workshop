local json = require("ssb_json")
local native = require("ssb_native_designer")

local M = {}

local function save_games_directory()
    local local_app_data = os.getenv("LOCALAPPDATA")
    if not local_app_data or local_app_data == "" then
        return nil, "missing_local_app_data"
    end
    return (local_app_data:gsub("\\", "/"):gsub("/+$", ""))
        .. "/MainSequence/Saved/SaveGames"
end

local function quote_argument(value)
    value = tostring(value)
    local chunks = { '"' }
    local backslashes = 0
    for index = 1, #value do
        local character = value:sub(index, index)
        if character == "\\" then
            backslashes = backslashes + 1
        elseif character == '"' then
            chunks[#chunks + 1] = string.rep("\\", backslashes * 2 + 1) .. '"'
            backslashes = 0
        else
            chunks[#chunks + 1] = string.rep("\\", backslashes) .. character
            backslashes = 0
        end
    end
    chunks[#chunks + 1] = string.rep("\\", backslashes * 2) .. '"'
    return table.concat(chunks)
end

M.quote_argument = quote_argument

local function valid_path(path)
    return type(path) == "string" and path ~= "" and not path:find("%c")
end

local function normalize_ids(ids)
    if type(ids) ~= "table" or #ids == 0 or #ids > 64 then
        return nil, "invalid_selection"
    end
    local seen = {}
    local values = {}
    for index, id in ipairs(ids) do
        if type(id) ~= "number" or id <= 0 or id % 1 ~= 0 then
            return nil, "invalid_block_id:" .. tostring(id)
        end
        if seen[id] then
            return nil, "duplicate_block_id:" .. tostring(id)
        end
        seen[id] = true
        values[index] = string.format("%.0f", id)
    end
    return values, seen
end

local function current_directory()
    local process = io.popen("cd", "r")
    if not process then return nil end
    local directory = process:read("*l")
    process:close()
    return directory and directory:gsub("\\", "/"):gsub("/+$", "") or nil
end

function M.codec_path()
    local source = debug.getinfo(1, "S").source
    local directory = source:match("^@(.*[/\\])") or ""
    directory = directory:gsub("\\", "/")
    if not directory:match("^%a:/") and not directory:match("^//") then
        local cwd = current_directory()
        if cwd then directory = cwd .. "/" .. directory end
    end
    return directory .. "../Binaries/ms-blueprint-codec.exe"
end

local function decode_document(text, context)
    local value, decode_error = json.decode(text)
    if value == nil then
        return nil, context .. "_json_invalid:" .. tostring(decode_error or "null_document")
    end
    return value
end

local function run_codec(arguments, context)
    local executable = M.codec_path()
    local helper, helper_error = io.open(executable, "rb")
    if not helper then
        return nil, "codec_missing:" .. executable .. ":" .. tostring(helper_error)
    end
    helper:close()
    local quoted = { quote_argument(executable) }
    for _, argument in ipairs(arguments) do
        quoted[#quoted + 1] = quote_argument(argument)
    end
    local command = '"' .. table.concat(quoted, " ") .. ' 2>&1"'
    local process, process_error = io.popen(command, "r")
    if not process then
        return nil, context .. "_start_failed:" .. tostring(process_error)
    end
    local output = process:read("*a") or ""
    local ok, _, code = process:close()
    if not ok or (code ~= nil and code ~= 0) then
        return nil, context .. "_failed:" .. tostring(code or "unknown") .. ":"
            .. output:gsub("%s+$", "")
    end
    return decode_document(output, context)
end

local function read_json_file(path, context)
    local file, open_error = io.open(path, "rb")
    if not file then
        return nil, context .. "_open_failed:" .. tostring(open_error)
    end
    local text = file:read("*a")
    file:close()
    return decode_document(text, context)
end

function M.extract_section(source_sav_path, dest_sav_path, dest_json_path, ids, options)
    options = options or {}
    if not valid_path(source_sav_path) or not valid_path(dest_sav_path) or not valid_path(dest_json_path) then
        return nil, "invalid_path"
    end
    if source_sav_path == dest_sav_path or source_sav_path == dest_json_path then
        return nil, "input_output_must_differ"
    end
    local values, id_error = normalize_ids(ids)
    if not values then
        return nil, id_error
    end
    local arguments = {
        "extract-section", "--input", source_sav_path,
        "--blocks", table.concat(values, ","),
    }
    if options.include_machines == true then
        arguments[#arguments + 1] = "--include-machines"
    end
    if options.anchor_block ~= nil then
        if type(options.anchor_block) ~= "number" or options.anchor_block <= 0
            or options.anchor_block % 1 ~= 0 then
            return nil, "invalid_anchor_block"
        end
        arguments[#arguments + 1] = "--anchor-block"
        arguments[#arguments + 1] = string.format("%.0f", options.anchor_block)
    end
    if options.normalize_origin == false then
        arguments[#arguments + 1] = "--no-normalize-origin"
    end
    if options.name ~= nil then
        if type(options.name) ~= "string" or options.name:find("%c") then
            return nil, "invalid_name"
        end
        arguments[#arguments + 1] = "--name"
        arguments[#arguments + 1] = options.name
    end
    arguments[#arguments + 1] = "--output-sav"
    arguments[#arguments + 1] = dest_sav_path
    arguments[#arguments + 1] = "--output-json"
    arguments[#arguments + 1] = dest_json_path
    local report, report_error = run_codec(arguments, "extract_section")
    if not report then
        return nil, report_error
    end
    if type(report.selected_blocks) ~= "table" or type(report.kept_machines) ~= "number"
        or type(report.excluded_cross_boundary) ~= "number"
        or type(report.excluded_outside) ~= "number"
        or type(report.excluded_unpaired) ~= "number" then
        return nil, "extract_section_report_mismatch"
    end
    return report
end

function M.transform_section(input_json_path, transform, output_plan_path)
    if not valid_path(input_json_path) or not valid_path(output_plan_path) then
        return nil, "invalid_path"
    end
    if input_json_path == output_plan_path then
        return nil, "input_output_must_differ"
    end
    if type(transform) ~= "table" then
        return nil, "invalid_transform"
    end
    local values = {}
    for _, field in ipairs({ "dgx", "dgy", "dfloor", "drot" }) do
        local value = transform[field]
        if type(value) ~= "number" or value % 1 ~= 0 or value < -2147483648 or value > 2147483647 then
            return nil, "invalid_transform_" .. field
        end
        values[field] = value
    end
    if values.drot < 0 or values.drot > 3 then
        return nil, "invalid_transform_drot"
    end
    local summary, summary_error = run_codec({
        "transform-section", "--input", input_json_path,
        "--dx", string.format("%.0f", values.dgx),
        "--dy", string.format("%.0f", values.dgy),
        "--dfloor", string.format("%.0f", values.dfloor),
        "--drot", string.format("%.0f", values.drot),
        "--output-plan", output_plan_path,
    }, "transform_section")
    if not summary then
        return nil, summary_error
    end
    local plan, plan_error = read_json_file(output_plan_path, "machine_build_plan")
    if not plan then
        return nil, plan_error
    end
    if getmetatable(plan) ~= json.ARRAY_MT then
        return nil, "machine_build_plan_not_array"
    end
    return plan, summary
end

local function verify_handle(handle, selected, expected_count, expected_machines)
    if type(handle) ~= "table" or type(handle.blueprint) ~= "userdata" then
        return nil, "local_load_failed"
    end
    local blueprint = handle.blueprint
    if blueprint.Version ~= 0 or blueprint.Type ~= 2 then
        return nil, "local_metadata_mismatch"
    end
    if #blueprint.Blocks ~= expected_count or #blueprint.Machines ~= expected_machines then
        return nil, "local_counts_mismatch"
    end
    for index = 1, #blueprint.Blocks do
        if not selected[blueprint.Blocks[index].BlockID] then
            return nil, "local_block_mismatch"
        end
    end
    return true
end

local function cleanup_source(slot)
    return native.delete_slot(slot)
end

local function cleanup_destination(slot, json_path)
    native.delete_slot(slot)
    os.remove(json_path)
end

function M.create_section(designer, source_slot, dest_slot, ids, options)
    options = options or {}
    if not native.is_valid_slot(source_slot) or not native.is_valid_slot(dest_slot) then
        return nil, "invalid_slot"
    end
    if source_slot == dest_slot then
        return nil, "input_output_must_differ"
    end
    local values, selected = normalize_ids(ids)
    if not values then
        return nil, selected
    end
    local directory, directory_error = save_games_directory()
    if not directory then
        return nil, directory_error
    end
    local save_game, capture_error = native.copy_blueprint_to_save_game(designer, options.include_machines == true)
    if not save_game then
        return nil, capture_error
    end
    local saved, save_error = native.save_to_slot(save_game, source_slot)
    if not saved then
        return nil, save_error
    end
    local source_sav = directory .. "/" .. source_slot .. ".sav"
    local destination_sav = directory .. "/" .. dest_slot .. ".sav"
    local destination_json = directory .. "/" .. dest_slot .. ".json"
    local report, extract_error = M.extract_section(source_sav, destination_sav, destination_json, ids, options)
    if not report then
        cleanup_destination(dest_slot, destination_json)
        local cleaned, cleanup_error = cleanup_source(source_slot)
        if not cleaned then
            return nil, tostring(extract_error) .. ":source_cleanup_failed:" .. tostring(cleanup_error)
        end
        return nil, extract_error
    end
    local handle, load_error = native.load_from_slot(dest_slot)
    if not handle then
        cleanup_destination(dest_slot, destination_json)
        cleanup_source(source_slot)
        return nil, load_error
    end
    local verified, verify_error = verify_handle(handle, selected, #values, report.kept_machines)
    if not verified then
        cleanup_destination(dest_slot, destination_json)
        cleanup_source(source_slot)
        return nil, verify_error
    end
    local cleaned, cleanup_error = cleanup_source(source_slot)
    if not cleaned then
        report.warnings = report.warnings or {}
        report.warnings[#report.warnings + 1] = "source_cleanup_failed:" .. tostring(cleanup_error)
    end
    return handle, report
end

return M
