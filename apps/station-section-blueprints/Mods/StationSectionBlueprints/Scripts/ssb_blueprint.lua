local M = {}

local function key(id)
    return tostring(id)
end

local function copy(value)
    if type(value) ~= "table" then
        return value
    end
    local result = {}
    for field, nested in pairs(value) do
        result[field] = copy(nested)
    end
    return result
end

local function location(block)
    local value = block.grid_location
    if type(value) ~= "table" then
        return nil
    end
    local x, y, z = tonumber(value.x), tonumber(value.y), tonumber(value.z)
    if not x or not y or not z then
        return nil
    end
    return { x = x, y = y, z = z }
end

local function index_blocks(blocks)
    local indexed = {}
    for _, block in ipairs(blocks) do
        if block.id == nil then
            return nil, "block_missing_id"
        end
        local id = key(block.id)
        if indexed[id] then
            return nil, "duplicate_block_id:" .. id
        end
        indexed[id] = block
    end
    return indexed
end

local function selection_set(selection, blocks)
    local selected, order = {}, {}
    for _, id in ipairs(selection or {}) do
        local normalized = key(id)
        if not blocks[normalized] then
            return nil, "unknown_block:" .. normalized
        end
        if not selected[normalized] then
            selected[normalized] = true
            order[#order + 1] = normalized
        end
    end
    if #order == 0 then
        return nil, "empty_selection"
    end
    return selected, order
end

local function provided_ids(selected, blocks)
    local provided = {}
    for id in pairs(selected) do
        provided[id] = true
        for _, machine in ipairs(blocks[id].default_machines or {}) do
            local machine_id = machine.id or machine.machine_id
            if machine_id ~= nil then
                provided[key(machine_id)] = true
            end
        end
    end
    return provided
end

local function dependency_reason(dependency, eligible)
    if eligible[key(dependency)] then
        return "missing_dependency"
    end
    return "cross_boundary"
end

local function filter_machines(snapshot, selected, provided, include_machines)
    local candidates, eligible, included, excluded = {}, {}, {}, {}
    for _, machine in ipairs(snapshot.machines or {}) do
        if machine.id == nil then
            return nil, "machine_missing_id"
        end
        local id = key(machine.id)
        if candidates[id] then
            return nil, "duplicate_machine_id:" .. id
        end
        candidates[id] = machine
        if selected[key(machine.owner_id)] then
            if include_machines then
                eligible[id] = true
                included[id] = true
            else
                excluded[id] = { reason = "machines_disabled" }
            end
        end
    end

    if include_machines then
        local changed = true
        while changed do
            changed = false
            for id, machine in pairs(candidates) do
                if included[id] then
                    for _, dependency in ipairs(machine.dependencies or {}) do
                        local dependency_id = key(dependency)
                        if not provided[dependency_id] and not included[dependency_id] then
                            included[id] = false
                            excluded[id] = {
                                reason = dependency_reason(dependency_id, eligible),
                            }
                            changed = true
                            break
                        end
                    end
                end
            end
        end
    end

    return included, excluded, nil
end

local function filtered_links(machine, included, provided)
    local result = copy(machine)
    local links = {}
    for _, linked_id in ipairs(machine.links or {}) do
        local id = key(linked_id)
        if included[id] or provided[id] then
            links[#links + 1] = linked_id
        end
    end
    if machine.links ~= nil then
        result.links = links
    end
    return result
end

function M.filter(snapshot, selection, include_machines)
    if type(snapshot) ~= "table" or type(snapshot.blocks) ~= "table" then
        return nil, "invalid_snapshot"
    end

    local blocks, block_error = index_blocks(snapshot.blocks)
    if not blocks then
        return nil, block_error
    end
    local selected, order_or_error = selection_set(selection, blocks)
    if not selected then
        return nil, order_or_error
    end

    local anchor = blocks[order_or_error[1]]
    local anchor_location = location(anchor)
    if not anchor_location then
        return nil, "invalid_anchor_location"
    end

    local provided = provided_ids(selected, blocks)
    local included, excluded = filter_machines(snapshot, selected, provided, include_machines == true)
    if not included then
        return nil, excluded
    end

    local result_blocks = {}
    for _, block in ipairs(snapshot.blocks) do
        local id = key(block.id)
        if selected[id] then
            local block_location = location(block)
            if not block_location then
                return nil, "invalid_block_location:" .. id
            end
            local result = copy(block)
            result.grid_location = {
                x = block_location.x - anchor_location.x,
                y = block_location.y - anchor_location.y,
                z = block_location.z - anchor_location.z,
            }
            result_blocks[#result_blocks + 1] = result
        end
    end

    local result_machines, removals = {}, {}
    for index, machine in ipairs(snapshot.machines or {}) do
        local id = key(machine.id)
        if included[id] then
            result_machines[#result_machines + 1] = filtered_links(machine, included, provided)
        elseif excluded[id] then
            removals[#removals + 1] = {
                id = machine.id,
                reason = excluded[id].reason,
                index = index,
            }
        end
    end

    return {
        blueprint = {
            blocks = result_blocks,
            machines = result_machines,
            anchor_block_id = anchor.id,
            includes_machines = include_machines == true,
        },
        removals = removals,
        stats = {
            blocks = #result_blocks,
            machines = #result_machines,
            removed_machines = #removals,
        },
    }
end

return M
