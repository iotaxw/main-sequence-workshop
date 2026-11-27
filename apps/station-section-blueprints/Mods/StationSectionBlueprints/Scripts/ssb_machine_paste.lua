local catalog = require("ssb_catalog_data")
local native = require("ssb_native")
local payload = require("ssb_payload")

local M = {}

local DIRECTIONS = {
    [0] = { x = 1, y = 0 },
    [1] = { x = 0, y = 1 },
    [2] = { x = -1, y = 0 },
    [3] = { x = 0, y = -1 },
}

local function short_class(value)
    if type(value) ~= "string" then return nil end
    local normalized = value:gsub("\\", "/")
    local base = normalized:match("([^/]+)$") or normalized
    return base:match("([^.]+)$") or base
end

local function buildable_for(step, catalog_data)
    catalog_data = catalog_data or catalog
    local id = step.building_type or catalog_data.buildable_by_class[short_class(step.object_class)]
    return id and catalog_data.buildables[id] or nil, id
end

local function append_footprint(cells, step, definition, native_dx, native_dy)
    local rotation = (step.native_rotation or 0) % 4
    local width, depth = definition.size[1], definition.size[2]
    if rotation % 2 == 1 then
        width, depth = depth, width
    end
    local native_x = step.native_x + (native_dx or 0)
    local native_y = step.native_y + (native_dy or 0)
    local x = native_x - width + 16
    local y = native_y - depth + 16
    if type(x) ~= "number" or type(y) ~= "number" or type(step.native_height) ~= "number"
        or x % 2 ~= 0 or y % 2 ~= 0 or step.native_height % 16 ~= 0 then
        return nil, "invalid_native_machine_transform:" .. tostring(step.id)
    end
    x = x // 2
    y = y // 2
    local floor = step.native_height // 16
    for dx = 0, width - 1 do
        for dy = 0, depth - 1 do
            cells[#cells + 1] = { x = x + dx, y = y + dy, floor = floor }
        end
    end
    return true
end

function M.step_occupied_cells(step, catalog_data)
    if type(step) ~= "table" then return nil, "invalid_machine_step" end
    local definition, id = buildable_for(step, catalog_data)
    if not definition then
        return nil, "unknown_buildable:" .. tostring(step.building_type or step.object_class)
    end
    step.building_type = step.building_type or id
    local cells = {}
    local added, add_error = append_footprint(cells, step, definition, 0, 0)
    if not added then return nil, add_error end
    if step.underground_length ~= nil then
        local length = step.underground_length
        if type(length) ~= "number" or length < 2 or length % 1 ~= 0 then
            return nil, "invalid_underground_length:" .. tostring(step.id)
        end
        local direction = DIRECTIONS[(step.native_rotation or 0) % 4]
        local offset = (length - 1) * 2
        added, add_error = append_footprint(
            cells, step, definition, direction.x * offset, direction.y * offset
        )
        if not added then return nil, add_error end
    end
    return cells
end

local function cell_key(cell)
    return string.format("%d:%d:%d", cell.x, cell.y, cell.floor)
end

function M.filter_non_overlapping_steps(steps, existing_machines, catalog_data)
    local occupied = {}
    local ignored_non_buildable = {}
    for _, machine in ipairs(existing_machines or {}) do
        local definition = buildable_for(machine, catalog_data)
        if not definition then
            ignored_non_buildable[#ignored_non_buildable + 1] =
                machine.object_class or machine.building_type or tostring(machine.id)
        else
            local cells, cells_error = M.step_occupied_cells(machine, catalog_data)
            if not cells then return nil, cells_error end
            for _, cell in ipairs(cells) do
                occupied[cell_key(cell)] = true
            end
        end
    end
    local result = {
        accepted = {},
        skipped_overlap = {},
        ignored_non_buildable_existing = ignored_non_buildable,
    }
    for _, step in ipairs(steps or {}) do
        local cells, cells_error = M.step_occupied_cells(step, catalog_data)
        if not cells then return nil, cells_error end
        local overlaps = false
        for _, cell in ipairs(cells) do
            if occupied[cell_key(cell)] then
                overlaps = true
                break
            end
        end
        if overlaps then
            result.skipped_overlap[#result.skipped_overlap + 1] = step
        else
            result.accepted[#result.accepted + 1] = step
            for _, cell in ipairs(cells) do
                occupied[cell_key(cell)] = true
            end
        end
    end
    return result
end

local function sorted_numbers(values)
    local result = {}
    for _, value in ipairs(values or {}) do
        if type(value) ~= "number" or value % 1 ~= 0 then
            return nil, "invalid_port_index"
        end
        result[#result + 1] = value
    end
    table.sort(result)
    return result
end

function M.build_config_actions(step, options)
    options = options or {}
    local actions = {}
    if step.recipe_id ~= nil then
        actions[#actions + 1] = { kind = "set_recipe", recipe_id = step.recipe_id }
    end
    local splitter = step.splitter
    if splitter then
        if splitter.priority_out ~= nil then
            actions[#actions + 1] = {
                kind = "set_config2", cfg1 = 0, cfg2 = splitter.priority_out,
            }
        end
        if splitter.priority_in ~= nil then
            actions[#actions + 1] = {
                kind = "set_config2", cfg1 = 1, cfg2 = splitter.priority_in,
            }
        end
        if splitter.port_filters then
            local slots = {}
            for key in pairs(splitter.port_filters) do
                local slot = tonumber(key)
                if not slot or slot < 0 or slot > 2 or slot % 1 ~= 0 then
                    return nil, "invalid_splitter_filter_slot:" .. tostring(key)
                end
                slots[#slots + 1] = slot
            end
            table.sort(slots)
            for _, slot in ipairs(slots) do
                local item_id = splitter.port_filters[tostring(slot)]
                if item_id == nil then item_id = splitter.port_filters[slot] end
                actions[#actions + 1] = { kind = "set_item", slot = slot, item_id = item_id }
            end
        end
        local disabled, disabled_error = sorted_numbers(splitter.disabled_ports)
        if not disabled then return nil, disabled_error end
        for _, port in ipairs(disabled) do
            actions[#actions + 1] = { kind = "toggle_port", port_index = port }
        end
    end
    local container = step.container
    if container then
        local disabled, disabled_error = sorted_numbers(container.disabled_ports)
        if not disabled then return nil, disabled_error end
        for _, port in ipairs(disabled) do
            actions[#actions + 1] = { kind = "toggle_port", port_index = port }
        end
        for index, filter in ipairs(container.logistic_filters or {}) do
            local item_id = filter.itemId or filter.item_id
            actions[#actions + 1] = {
                kind = "set_logistic_filter",
                index = filter.index or index - 1,
                item_id = item_id,
                action = filter.action or 0,
                remove = filter.remove == true or item_id == "",
            }
        end
        if container.b_creative == true and options.creative_mode == true then
            actions[#actions + 1] = {
                kind = "set_creative_container",
                b_creative = true,
                b_consume = container.b_creative_consume == true,
                item_id = container.creative_item,
            }
        end
    end
    if step.teleporter_label ~= nil then
        actions[#actions + 1] = {
            kind = "set_text", text = step.teleporter_label, config = 0,
        }
    end
    if type(step.palette_id) == "number" and step.palette_id > 0 then
        actions[#actions + 1] = { kind = "set_palette", palette_id = step.palette_id }
    end
    return actions
end

local pending_jobs = {}
local ready_jobs = {}
local active_job = false

function M.queue_pending_job(job)
    if type(job) ~= "table" or type(job.json_path) ~= "string" or type(job.transform) ~= "table"
        or type(job.station_id) ~= "number" or job.station_id <= 0 or job.station_id % 1 ~= 0 then
        return nil, "invalid_machine_job"
    end
    pending_jobs[#pending_jobs + 1] = job
    return job
end

function M.commit_pending_jobs()
    local count = #pending_jobs
    for _, job in ipairs(pending_jobs) do
        ready_jobs[#ready_jobs + 1] = job
    end
    pending_jobs = {}
    return count
end

function M.discard_pending_jobs()
    local count = #pending_jobs
    pending_jobs = {}
    return count
end

function M.take_ready_jobs()
    local jobs = ready_jobs
    ready_jobs = {}
    return jobs
end

function M.ready_machine_count()
    local count = 0
    for _, job in ipairs(ready_jobs) do
        count = count + (job.machine_count or job.total or 0)
    end
    return count
end

local DEFAULT_OBJECT_FLAGS

local function is_cdo(object)
    if not native.is_valid(object) then return true end
    if native.full_name(object):find("Default__", 1, true) then return true end
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

local function is_a(object, path)
    local ok, result = pcall(function()
        return object:IsA(path)
    end)
    return ok and result == true
end

local function scan_instances(short_class_name, isa_path, predicate)
    if type(FindAllOf) == "function" then
        local ok, objects = pcall(FindAllOf, short_class_name)
        if not ok then return nil, "find_all_failed:" .. tostring(objects) end
        local matches = {}
        for _, object in ipairs(objects or {}) do
            if is_live(object) and (not isa_path or is_a(object, isa_path)) and predicate(object) then
                matches[#matches + 1] = object
            end
        end
        return matches
    end
    local matches = {}
    local ok, scan_error = pcall(ForEachUObject, function(object)
        if is_live(object) and (not isa_path or is_a(object, isa_path)) and predicate(object) then
            matches[#matches + 1] = object
        end
    end)
    if not ok then return nil, "scan_failed:" .. tostring(scan_error) end
    return matches
end

local function find_station(station_id)
    local matches, scan_error = scan_instances("StationObject", "/Script/MainSequence.StationObject", function(object)
        local id_ok, id = pcall(function() return object.ID end)
        return id_ok and id == station_id
    end)
    if not matches then return nil, "station_" .. tostring(scan_error) end
    if #matches ~= 1 then return nil, "station_not_unique:" .. tostring(station_id) end
    return matches[1]
end

local function find_player_controller()
    local matches, scan_error = scan_instances("DMSPlayerController", "/Script/MainSequence.DMSPlayerController", function()
        return true
    end)
    if not matches then return nil, "player_controller_" .. tostring(scan_error) end
    if #matches > 1 then
        local local_matches = {}
        for _, controller in ipairs(matches) do
            local called, local_controller = pcall(function()
                return controller:IsLocalController()
            end)
            if called and local_controller == true then
                local_matches[#local_matches + 1] = controller
            end
        end
        if #local_matches > 0 then matches = local_matches end
    end
    if #matches ~= 1 then return nil, "player_controller_not_unique" end
    return matches[1]
end

local function object_array(array, limit)
    if array == nil then return {} end
    local result = {}
    if type(array) == "table" then
        for index, parameter in ipairs(array) do
            if index > limit then return nil, "native_array_limit_exceeded" end
            local ok, value = pcall(function() return parameter:Get() end)
            if not ok then return nil, "native_array_element_read_failed" end
            result[#result + 1] = value
        end
        return result
    end
    local count = #array
    if count > limit then return nil, "native_array_limit_exceeded" end
    for index = 1, count do
        result[index] = array[index]
    end
    return result
end

local function machine_record(machine)
    if not is_live(machine) then return nil end
    local ok, record = pcall(function()
        local transform = machine.GridTransform
        return {
            id = machine.ID,
            object_class = native.class_name(machine),
            building_type = catalog.buildable_by_class[short_class(native.class_name(machine))],
            native_x = transform.GridLocation.X,
            native_y = transform.GridLocation.Y,
            native_height = transform.Height,
            native_rotation = transform.GridRotation % 4,
            machine = machine,
        }
    end)
    if not ok or type(record.id) ~= "number" then return nil end
    local len_ok, length = pcall(function()
        return machine.Length
    end)
    if len_ok and type(length) == "number" and length > 0 then
        record.underground_length = math.floor(length)
    end
    return record
end

local function scan_machines(station)
    local values, array_error = object_array(station.Machines, 65536)
    if not values then return nil, array_error end
    local records = {}
    local ids = {}
    for _, machine in ipairs(values) do
        local record = machine_record(machine)
        if record then
            records[#records + 1] = record
            ids[record.id] = true
        end
    end
    return records, ids
end

local function resolve_asset(class_name, id, cache)
    cache[class_name] = cache[class_name] or {}
    if cache[class_name][id] then return cache[class_name][id] end
    local matches, scan_error = scan_instances(class_name, nil, function(object)
        return native.class_name(object) == class_name and native.short_name(object) == id
    end)
    if not matches then return nil, "asset_" .. tostring(scan_error) end
    if #matches ~= 1 then return nil, "asset_not_unique:" .. class_name .. ":" .. tostring(id) end
    cache[class_name][id] = matches[1]
    return matches[1]
end

local function command_cdo(path)
    local object = native.find_type(path)
    if not object or not native.full_name(object):find("Default__", 1, true) then
        return nil, "input_command_cdo_missing:" .. path
    end
    return object
end

local function make_pnum(value)
    return { Value = math.floor(value * 65536 + 0.5) }
end

local function make_pvector(x, y, z)
    return { X = make_pnum(x), Y = make_pnum(y), Z = make_pnum(z) }
end

local function identity_pquat()
    return {
        W = { Value = 65536 }, X = { Value = 0 },
        Y = { Value = 0 }, Z = { Value = 0 },
    }
end

local function copy_vector(value)
    local ok, x, y, z = pcall(function()
        return value.X, value.Y, value.Z
    end)
    if not ok or type(x) ~= "number" or type(y) ~= "number" or type(z) ~= "number" then
        return nil, "invalid_chunk_location"
    end
    return { X = x, Y = y, Z = z }
end

local function build_command(step, station, station_id, cache)
    local definition = catalog.buildables[step.building_type]
    if not definition then return nil, "unknown_buildable:" .. tostring(step.building_type) end
    local buildable, asset_error = resolve_asset("Buildable", step.building_type, cache)
    if not buildable then return nil, asset_error end
    local chunk, chunk_error = copy_vector(station.ChunkLocation)
    if not chunk then return nil, chunk_error end
    local system_id = station.SolarSystemID
    if type(system_id) ~= "number" then return nil, "invalid_solar_system_id" end
    return {
        Buildable = buildable,
        Location = make_pvector(0, 0, 0),
        Quat = identity_pquat(),
        ChunkLocation = chunk,
        SolarSystemID = math.floor(system_id),
        AttachTargetID = station_id,
        GridTransform = {
            GridLocation = { X = step.native_x, Y = step.native_y },
            Height = step.native_height,
            GridRotation = step.native_rotation,
        },
        Config = step.underground_length or 0,
        MachineConfigData = {},
    }
end

local function resolve_recipe_name(recipe_id)
    if type(recipe_id) ~= "string" or recipe_id == "" then return recipe_id end
    local aliases = catalog.recipe_by_alias or {}
    return aliases[recipe_id] or aliases[recipe_id:lower()] or recipe_id
end

local function resolve_item_name(item_id)
    if type(item_id) ~= "string" or item_id == "" then return item_id end
    local aliases = catalog.item_by_alias or {}
    return aliases[item_id] or aliases[item_id:lower()] or item_id
end

local function resolve_item(item_id, cache)
    if item_id == nil or item_id == "" then return true end
    return resolve_asset("Item", resolve_item_name(item_id), cache)
end

local function dispatch_config_action(controller, machine_id, action, cache, player_id)
    local ok, err = pcall(function()
        local command
        if action.kind == "set_recipe" then
            local recipe = assert(resolve_asset("Recipe", resolve_recipe_name(action.recipe_id), cache))
            command = assert(command_cdo("/Script/MainSequence.Default__SetRecipeInput"))
                :CreateInputSetRecipe(recipe)
        elseif action.kind == "set_config2" then
            command = assert(command_cdo("/Script/MainSequence.Default__SetConfigInput"))
                :CreateInputSetConfig2(action.cfg1, action.cfg2, player_id)
        elseif action.kind == "set_item" then
            local item = resolve_item(action.item_id, cache)
            if item ~= true and not item then error("item_not_found:" .. tostring(action.item_id)) end
            command = assert(command_cdo("/Script/MainSequence.Default__SetItemInput"))
                :CreateInputSetItem({ Item = item ~= true and item or nil, Amount = 1 }, action.slot)
        elseif action.kind == "toggle_port" then
            local class = native.find_type("/Script/MainSequence.MachinePortInput")
            if not class then error("MachinePortInput_class_not_found") end
            command = StaticConstructObject(class, controller, 0, 0)
            if not native.is_valid(command) then error("MachinePortInput_construct_failed") end
            command.PortIndex = action.port_index
        elseif action.kind == "set_logistic_filter" then
            local item = resolve_item(action.item_id, cache)
            if item ~= true and not item then error("item_not_found:" .. tostring(action.item_id)) end
            command = assert(command_cdo("/Script/MainSequence.Default__LogisticFilterInput"))
                :CreateInputLogisticFilter(action.index, { Item = item ~= true and item or nil, Amount = 1 },
                    action.action, action.remove)
        elseif action.kind == "set_creative_container" then
            local item = resolve_item(action.item_id, cache)
            if item ~= true and not item then error("item_not_found:" .. tostring(action.item_id)) end
            command = assert(command_cdo("/Script/MainSequence.Default__CreativeContainerInput"))
                :CreateInputCreativeContainer(action.b_creative, action.b_consume,
                    item ~= true and item or nil)
        elseif action.kind == "set_text" then
            local text = FText(action.text)
            command = assert(command_cdo("/Script/MainSequence.Default__SetTextInputCommand"))
                :CreateInputSetText(text, action.config)
        elseif action.kind == "set_palette" then
            command = assert(command_cdo("/Script/MainSequence.Default__SetPaletteInput"))
                :CreateInputSetPalette(machine_id, action.palette_id)
        else
            error("unknown_config_action:" .. tostring(action.kind))
        end
        if not native.is_valid(command) then error("input_command_not_created:" .. action.kind) end
        controller:AddInputCommand(machine_id, command)
    end)
    return ok, err
end

local function machine_matches(step, record)
    if step.native_x ~= record.native_x or step.native_y ~= record.native_y
        or step.native_height ~= record.native_height
        or step.native_rotation % 4 ~= record.native_rotation % 4 then
        return false
    end
    if step.building_type and record.building_type then
        return step.building_type == record.building_type
    end
    return short_class(step.object_class) == short_class(record.object_class)
        or short_class(step.object_class) .. "_C" == short_class(record.object_class)
end

local function report_progress(callback, value)
    if type(callback) == "function" then
        local ok, err = pcall(callback, value)
        if not ok then print("[StationSectionBlueprints machines] progress failed: " .. tostring(err) .. "\n") end
    end
end

function M.execute_job(job, on_progress, on_complete)
    if active_job then return nil, "machine_job_already_active" end
    if type(job) ~= "table" or type(job.json_path) ~= "string" or type(job.transform) ~= "table" then
        return nil, "invalid_machine_job"
    end
    active_job = true
    local plan_path = job.output_plan_path or (job.json_path .. ".machine-plan.tmp")
    local remove_plan = job.output_plan_path == nil
    local steps, summary_or_error = payload.transform_section(job.json_path, job.transform, plan_path)
    if remove_plan then os.remove(plan_path) end
    if not steps then
        active_job = false
        return nil, summary_or_error
    end
    local station, station_error = find_station(job.station_id)
    if not station then
        active_job = false
        return nil, station_error
    end
    local controller, controller_error = find_player_controller()
    if not controller then
        active_job = false
        return nil, controller_error
    end
    local existing, pre_existing_ids_or_error = scan_machines(station)
    if not existing then
        active_job = false
        return nil, pre_existing_ids_or_error
    end
    local pre_existing_ids = pre_existing_ids_or_error
    local filtered, filter_error = M.filter_non_overlapping_steps(steps, existing, catalog)
    if not filtered then
        active_job = false
        return nil, filter_error
    end
    local report = {
        total = #steps,
        accepted = #filtered.accepted,
        built = 0,
        configured = 0,
        skipped_overlap = #filtered.skipped_overlap,
        skipped_survival_or_missing = 0,
        config_errors = 0,
        transform_summary = summary_or_error,
    }
    local cache = {}
    local dispatch_errors = {}
    local next_index = 1

    local function finish()
        local latest, scan_error = scan_machines(station)
        if not latest then
            report.skipped_survival_or_missing = report.accepted - report.built
            report.config_errors = report.config_errors + 1
            report.rescan_error = scan_error
            active_job = false
            report_progress(on_complete, report)
            return
        end
        local used = {}
        for _, step in ipairs(filtered.accepted) do
            local matched
            for index, record in ipairs(latest) do
                if not used[index] and not pre_existing_ids[record.id] and machine_matches(step, record) then
                    matched = index
                    break
                end
            end
            if matched then
                used[matched] = true
                local record = latest[matched]
                report.built = report.built + 1
                local actions, actions_error = M.build_config_actions(step, {
                    creative_mode = false,
                })
                if not actions then
                    report.config_errors = report.config_errors + 1
                    dispatch_errors[#dispatch_errors + 1] = actions_error
                else
                    local action_failed = false
                    for _, action in ipairs(actions) do
                        local dispatched, action_error = dispatch_config_action(
                            controller, record.id, action, cache, job.player_id or 0
                        )
                        if not dispatched then
                            action_failed = true
                            report.config_errors = report.config_errors + 1
                            dispatch_errors[#dispatch_errors + 1] = tostring(action_error)
                        end
                    end
                    if not action_failed then report.configured = report.configured + 1 end
                end
            end
        end
        report.skipped_survival_or_missing = report.accepted - report.built
        report.dispatch_errors = dispatch_errors
        active_job = false
        report_progress(on_complete, report)
    end

    local function dispatch_next_batch()
        ExecuteInGameThread(function()
            if not is_live(station) or not is_live(controller) then
                report.skipped_survival_or_missing = report.accepted - report.built
                report.config_errors = report.config_errors + 1
                active_job = false
                report_progress(on_complete, report)
                return
            end
            local last = math.min(next_index + 7, #filtered.accepted)
            for index = next_index, last do
                local step = filtered.accepted[index]
                local command, command_error = build_command(step, station, job.station_id, cache)
                if command then
                    local ok, err = pcall(function()
                        controller:AddBuildCommand(command)
                    end)
                    if not ok then
                        dispatch_errors[#dispatch_errors + 1] = tostring(err)
                    end
                else
                    dispatch_errors[#dispatch_errors + 1] = tostring(command_error)
                end
            end
            next_index = last + 1
            report_progress(on_progress, {
                phase = "building", dispatched = last, accepted = report.accepted,
            })
            if next_index <= #filtered.accepted then
                ExecuteWithDelay(50, dispatch_next_batch)
            else
                ExecuteWithDelay(200, function()
                    ExecuteInGameThread(finish)
                end)
            end
        end)
    end

    if #filtered.accepted == 0 then
        ExecuteWithDelay(200, function()
            ExecuteInGameThread(finish)
        end)
    else
        ExecuteWithDelay(50, dispatch_next_batch)
    end
    report_progress(on_progress, { phase = "queued", total = report.total, accepted = report.accepted })
    return true
end

return M
