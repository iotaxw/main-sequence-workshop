local catalog = require("ssb_catalog_data")

local M = {}

local DIRECTIONS = {
    [0] = { x = 1, y = 0 },
    [1] = { x = 0, y = 1 },
    [2] = { x = -1, y = 0 },
    [3] = { x = 0, y = -1 },
}

local function rotate_xy(x, y, rotation)
    rotation = rotation % 4
    if rotation == 0 then return x, y end
    if rotation == 1 then return -y, x end
    if rotation == 2 then return -x, -y end
    return y, -x
end

local function rotated_size(definition, rotation)
    if rotation % 2 == 1 then
        return definition.size_units[2], definition.size_units[1]
    end
    return definition.size_units[1], definition.size_units[2]
end

local function rotate_footprint(x, y, width, depth, span, rotation)
    if rotation == 0 then return x, y end
    if rotation == 1 then return span - y - depth, x end
    if rotation == 2 then return span - x - width, span - y - depth end
    return y, span - x - width
end

local function short_class(value)
    if type(value) ~= "string" then return nil end
    local normalized = value:gsub("\\", "/")
    local base = normalized:match("([^/]+)$") or normalized
    return base:match("([^.]+)$") or base
end

local function definition_for(block)
    local module_type = block.type or block.module_type
    if not module_type and block.native_meta then
        module_type = block.native_meta.module_type
    end
    module_type = module_type or catalog.module_by_class[short_class(block.class_name or block.object_class)]
    if not module_type and block.native_meta then
        module_type = catalog.module_by_class[short_class(block.native_meta.class_path)]
    end
    return module_type, module_type and catalog.modules[module_type] or nil
end

local function is_native_block(block)
    return block.rot ~= nil or block.height ~= nil
        or (block.class_name ~= nil and block.type == nil and block.module_type == nil)
end

local function module_native_transform(module)
    local _, definition = definition_for(module)
    local rotation = module.rotation % 4
    local width, depth = rotated_size(definition, rotation)
    local pivot = definition.pivot_offset
    local rx, ry = rotate_xy(pivot[1], pivot[2], rotation)
    return {
        gx = 4 * module.gx + 2 * width - 2 + rx,
        gy = 4 * module.gy + 2 * depth - 2 + ry,
        height = module.floor * 2 + pivot[3],
        rot = rotation,
    }
end

local function to_module(block)
    if type(block) ~= "table" then return nil, "invalid_block" end
    local module_type, definition = definition_for(block)
    if not definition then
        return nil, "unknown_module:" .. tostring(block.class_name or block.type or block.module_type)
    end
    if not is_native_block(block) then
        if type(block.gx) ~= "number" or type(block.gy) ~= "number" or type(block.floor) ~= "number" then
            return nil, "invalid_module_coordinates"
        end
        return {
            id = block.id,
            type = module_type,
            gx = block.gx,
            gy = block.gy,
            floor = block.floor,
            rotation = (block.rotation or 0) % 4,
            palette_id = block.palette_id or block.paletteId,
        }
    end
    local rotation = (block.rot or block.rotation or 0) % 4
    local width, depth = rotated_size(definition, rotation)
    local pivot = definition.pivot_offset
    local rx, ry = rotate_xy(pivot[1], pivot[2], rotation)
    local x = block.gx - rx - 2 * width + 2
    local y = block.gy - ry - 2 * depth + 2
    local floor = block.height - pivot[3]
    if x % 4 ~= 0 or y % 4 ~= 0 or floor % 2 ~= 0 then
        return nil, "unaligned_native_module:" .. tostring(block.id)
    end
    return {
        id = block.id,
        type = module_type,
        gx = x / 4,
        gy = y / 4,
        floor = floor / 2,
        rotation = rotation,
        palette_id = block.palette_id or block.paletteId,
    }
end

local function convert_modules(blocks)
    if type(blocks) ~= "table" then return nil, "invalid_blocks" end
    local result = {}
    for index, block in ipairs(blocks) do
        local module, err = to_module(block)
        if not module then return nil, err end
        module.source_index = index
        result[index] = module
    end
    return result
end

local function module_connectors(module, module_index)
    local _, definition = definition_for(module)
    local transform = module_native_transform(module)
    local result = {}
    for connector_index, connector in ipairs(definition.connectors) do
        local rx, ry = rotate_xy(connector.gx, connector.gy, module.rotation)
        local vertical = connector.type == "Vertical1x1" or connector.type == "Vertical2x2"
        result[#result + 1] = {
            module_index = module_index,
            connector_index = connector_index,
            type = connector.type,
            x = transform.gx + rx,
            y = transform.gy + ry,
            height = transform.height + connector.floor_offset * 2,
            rotation = (connector.rotation + module.rotation) % 4,
            vertical = vertical,
            top = vertical and connector.floor_offset > 0 or nil,
        }
    end
    return result
end

local function connectors_mate(left, right)
    if left.type ~= right.type or left.x ~= right.x or left.y ~= right.y
        or left.height ~= right.height then
        return false
    end
    if left.vertical or right.vertical then
        return left.vertical and right.vertical and left.top ~= right.top
    end
    return (left.rotation + 2) % 4 == right.rotation
end

local function all_connectors(modules)
    local result = {}
    for module_index, module in ipairs(modules) do
        local connectors = module_connectors(module, module_index)
        for _, connector in ipairs(connectors) do
            result[#result + 1] = connector
        end
    end
    return result
end

local function open_connectors(modules)
    local connectors = all_connectors(modules)
    local result = {}
    for _, connector in ipairs(connectors) do
        local mated = false
        for _, other in ipairs(connectors) do
            if connector.module_index ~= other.module_index and connectors_mate(connector, other) then
                mated = true
                break
            end
        end
        if not mated then
            result[#result + 1] = connector
        end
    end
    return result
end

local function transform_module(module, pose)
    local _, definition = definition_for(module)
    local width, depth = rotated_size(definition, module.rotation)
    local gx, gy = rotate_footprint(module.gx, module.gy, width, depth, 1, pose.drot)
    return {
        id = module.id,
        type = module.type,
        gx = gx + pose.dgx,
        gy = gy + pose.dgy,
        floor = module.floor + pose.dfloor,
        rotation = (module.rotation + pose.drot) % 4,
        palette_id = module.palette_id,
    }
end

local function bounds(module)
    local _, definition = definition_for(module)
    local width, depth = rotated_size(definition, module.rotation)
    return {
        min_x = module.gx,
        max_x = module.gx + width,
        min_y = module.gy,
        max_y = module.gy + depth,
        min_floor = module.floor,
        max_floor = module.floor + definition.size_units[3],
    }
end

local function overlaps(left, right)
    return left.min_x < right.max_x and left.max_x > right.min_x
        and left.min_y < right.max_y and left.max_y > right.min_y
        and left.min_floor < right.max_floor and left.max_floor > right.min_floor
end

local function hit_vector(hit_dir)
    if type(hit_dir) == "number" and hit_dir >= 0 and hit_dir <= 3 and hit_dir % 1 == 0 then
        return DIRECTIONS[hit_dir]
    end
    if type(hit_dir) ~= "table" then return nil end
    local x = hit_dir.x or hit_dir.gx or hit_dir.X
    local y = hit_dir.y or hit_dir.gy or hit_dir.Y
    if type(x) ~= "number" or type(y) ~= "number" then return nil end
    if math.abs(x) >= math.abs(y) then
        return { x = x >= 0 and 1 or -1, y = 0 }
    end
    return { x = 0, y = y >= 0 and 1 or -1 }
end

local function direction_alignment(direction, hit_dir)
    local hit = hit_vector(hit_dir)
    if not hit then return 0 end
    local vector = DIRECTIONS[direction % 4]
    return vector.x * hit.x + vector.y * hit.y
end

local function transformed_connector(connector, pose)
    local x, y = rotate_xy(connector.x, connector.y, pose.drot)
    return {
        module_index = connector.module_index,
        connector_index = connector.connector_index,
        type = connector.type,
        x = x + pose.dgx * 4,
        y = y + pose.dgy * 4,
        height = connector.height + pose.dfloor * 2,
        rotation = (connector.rotation + pose.drot) % 4,
        vertical = connector.vertical,
        top = connector.top,
    }
end

local function matched_connector_count(section_open, host_open, pose)
    local matched = {}
    for _, section_connector in ipairs(section_open) do
        local transformed = transformed_connector(section_connector, pose)
        for _, host_connector in ipairs(host_open) do
            if connectors_mate(transformed, host_connector) then
                local key = table.concat({
                    transformed.module_index, transformed.connector_index,
                    host_connector.module_index, host_connector.connector_index,
                }, ":")
                matched[key] = true
            end
        end
    end
    local count = 0
    for _ in pairs(matched) do count = count + 1 end
    return count
end

function M.solve_target_block_candidates(target_block, host_blocks, section_doc, preferred_rot, hit_dir)
    if type(section_doc) ~= "table" or type(section_doc.modules) ~= "table" then
        return nil, "invalid_section_document"
    end
    local host, host_error = convert_modules(host_blocks or {})
    if not host then return nil, host_error end
    local target, target_error = to_module(target_block)
    if not target then return nil, target_error end
    local target_index
    for index, module in ipairs(host) do
        if module.id ~= nil and target.id ~= nil and module.id == target.id then
            target_index = index
            target = module
            break
        end
    end
    if not target_index then
        host[#host + 1] = target
        target_index = #host
    end
    local section, section_error = convert_modules(section_doc.modules)
    if not section then return nil, section_error end
    if #section == 0 then return {} end

    local host_open = open_connectors(host)
    local target_open = {}
    for _, connector in ipairs(host_open) do
        if connector.module_index == target_index then
            target_open[#target_open + 1] = connector
        end
    end
    local section_open = open_connectors(section)
    local host_bounds = {}
    for index, module in ipairs(host) do
        host_bounds[index] = bounds(module)
    end

    local by_pose = {}
    for drot = 0, 3 do
        for _, target_connector in ipairs(target_open) do
            for _, section_connector in ipairs(section_open) do
                local facing_matches
                if target_connector.vertical or section_connector.vertical then
                    facing_matches = target_connector.vertical and section_connector.vertical
                        and target_connector.top ~= section_connector.top
                else
                    facing_matches = (section_connector.rotation + drot) % 4
                        == (target_connector.rotation + 2) % 4
                end
                if facing_matches then
                    local rx, ry = rotate_xy(section_connector.x, section_connector.y, drot)
                    local dx_native = target_connector.x - rx
                    local dy_native = target_connector.y - ry
                    local dfloor_native = target_connector.height - section_connector.height
                    if dx_native % 4 == 0 and dy_native % 4 == 0 and dfloor_native % 2 == 0 then
                        local pose = {
                            dgx = dx_native / 4,
                            dgy = dy_native / 4,
                            dfloor = dfloor_native / 2,
                            drot = drot,
                        }
                        local key = table.concat({ pose.dfloor, pose.dgx, pose.dgy, pose.drot }, ":")
                        if not by_pose[key] then
                            local transformed = {}
                            local collision = false
                            for index, module in ipairs(section) do
                                transformed[index] = transform_module(module, pose)
                                local candidate_bounds = bounds(transformed[index])
                                for _, other_bounds in ipairs(host_bounds) do
                                    if overlaps(candidate_bounds, other_bounds) then
                                        collision = true
                                        break
                                    end
                                end
                                if collision then break end
                            end
                            if not collision then
                                pose.matched_connectors = matched_connector_count(section_open, host_open, pose)
                                pose.hit_alignment = direction_alignment(target_connector.rotation, hit_dir)
                                by_pose[key] = pose
                            end
                        else
                            local alignment = direction_alignment(target_connector.rotation, hit_dir)
                            by_pose[key].hit_alignment = math.max(by_pose[key].hit_alignment, alignment)
                        end
                    end
                end
            end
        end
    end
    local candidates = {}
    for _, pose in pairs(by_pose) do
        candidates[#candidates + 1] = pose
    end
    table.sort(candidates, function(left, right)
        if left.matched_connectors ~= right.matched_connectors then
            return left.matched_connectors > right.matched_connectors
        end
        local left_preferred = preferred_rot ~= nil and left.drot == preferred_rot % 4
        local right_preferred = preferred_rot ~= nil and right.drot == preferred_rot % 4
        if left_preferred ~= right_preferred then return left_preferred end
        if left.hit_alignment ~= right.hit_alignment then
            return left.hit_alignment > right.hit_alignment
        end
        for _, field in ipairs({ "dfloor", "dgx", "dgy", "drot" }) do
            if left[field] ~= right[field] then return left[field] < right[field] end
        end
        return false
    end)
    return candidates
end

local Controller = {}
Controller.__index = Controller

local function copy_pose(pose)
    return {
        dgx = pose.dgx,
        dgy = pose.dgy,
        dfloor = pose.dfloor,
        drot = pose.drot % 4,
        matched_connectors = pose.matched_connectors,
    }
end

local function rounded_grid(value)
    return math.floor(value + 0.5)
end

local function free_pose(cursor_grid, rotation)
    cursor_grid = cursor_grid or {}
    local x = cursor_grid.gx or cursor_grid.x or cursor_grid.dgx or 0
    local y = cursor_grid.gy or cursor_grid.y or cursor_grid.dgy or 0
    local floor = cursor_grid.floor or cursor_grid.dfloor or cursor_grid.z or 0
    return {
        dgx = rounded_grid(x),
        dgy = rounded_grid(y),
        dfloor = rounded_grid(floor),
        drot = rotation % 4,
    }
end

local function compute_fixed_anchor(section_doc)
    local modules = type(section_doc) == "table" and convert_modules(section_doc.modules or {}) or nil
    if not modules or #modules == 0 then
        return { gx = 0, gy = 0, floor = 0 }
    end
    local has_zero_floor = false
    local min_floor = modules[1].floor
    for _, module in ipairs(modules) do
        if module.floor == 0 then has_zero_floor = true end
        if module.floor < min_floor then min_floor = module.floor end
    end
    local anchor_floor = has_zero_floor and 0 or min_floor
    local min_x, max_x, min_y, max_y
    for _, module in ipairs(modules) do
        if module.floor == anchor_floor then
            local b = bounds(module)
            min_x = min_x and math.min(min_x, b.min_x) or b.min_x
            max_x = max_x and math.max(max_x, b.max_x - 1) or (b.max_x - 1)
            min_y = min_y and math.min(min_y, b.min_y) or b.min_y
            max_y = max_y and math.max(max_y, b.max_y - 1) or (b.max_y - 1)
        end
    end
    return {
        gx = math.floor(((min_x or 0) + (max_x or 0)) / 2),
        gy = math.floor(((min_y or 0) + (max_y or 0)) / 2),
        floor = anchor_floor,
    }
end

local function recompute_pose(controller)
    local rx, ry = rotate_xy(controller.anchor.gx, controller.anchor.gy, controller.drot)
    controller.pose = {
        dgx = controller.base_gx + controller.offset_gx - rx,
        dgy = controller.base_gy + controller.offset_gy - ry,
        dfloor = controller.offset_floor - controller.anchor.floor,
        drot = controller.drot,
    }
    return controller.pose
end

function M.new_controller(section_doc, options)
    options = options or {}
    local includes_machines = options.includes_machines
    if includes_machines == nil then
        includes_machines = type(section_doc.buildings) == "table" and #section_doc.buildings > 0
    end
    local controller = setmetatable({
        section_doc = section_doc,
        anchor = compute_fixed_anchor(section_doc),
        mode = "hover",
        includes_machines = includes_machines == true,
        drot = (options.drot or 0) % 4,
        base_gx = 0,
        base_gy = 0,
        offset_gx = 0,
        offset_gy = 0,
        offset_floor = 0,
        pose = { dgx = 0, dgy = 0, dfloor = 0, drot = (options.drot or 0) % 4 },
        candidates = {},
        candidate_index = 1,
    }, Controller)
    recompute_pose(controller)
    return controller
end

-- Unified fixed height=0 anchor placement:
-- Mouse drives base_gx/base_gy on the 16m grid while hovering; Arrow keys & [/] floor keys apply
-- persistent offsets BOTH before and after pressing H to lock.
function Controller:update_hover(_, _, cursor_grid, _, _)
    if self.mode == "locked" then
        return self.pose
    end
    if type(cursor_grid) == "table" then
        local x = cursor_grid.gx or cursor_grid.x or cursor_grid.dgx
        local y = cursor_grid.gy or cursor_grid.y or cursor_grid.dgy
        if type(x) == "number" then self.base_gx = rounded_grid(x) end
        if type(y) == "number" then self.base_gy = rounded_grid(y) end
    end
    return recompute_pose(self)
end

function Controller:toggle_lock()
    self.mode = self.mode == "locked" and "hover" or "locked"
    return self.mode
end

function Controller:cycle_candidate(delta)
    local count = #self.candidates
    if count == 0 then return nil, "no_candidates" end
    delta = delta or 1
    if type(delta) ~= "number" or delta % 1 ~= 0 then return nil, "invalid_candidate_delta" end
    self.candidate_index = (self.candidate_index - 1 + delta) % count + 1
    self.pose = copy_pose(self.candidates[self.candidate_index])
    self.drot = self.pose.drot
    return self.pose
end

function Controller:rotate_cw()
    self.drot = (self.drot + 1) % 4
    return recompute_pose(self).drot
end

function Controller:can_mirror()
    return not self.includes_machines
end

-- Camera-relative horizontal nudge (Arrows) and vertical floor nudge ([ / ]) work in BOTH hover and locked modes.
function Controller:nudge(right_steps, forward_steps, floor_steps, camera_yaw_deg)
    right_steps = right_steps or 0
    forward_steps = forward_steps or 0
    floor_steps = floor_steps or 0
    camera_yaw_deg = camera_yaw_deg or 0
    for _, value in ipairs({ right_steps, forward_steps, floor_steps, camera_yaw_deg }) do
        if type(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then
            return nil, "invalid_nudge"
        end
    end
    local forward = math.floor((camera_yaw_deg % 360 + 45) / 90) % 4
    local right = (forward + 1) % 4
    local forward_vector = DIRECTIONS[forward]
    local right_vector = DIRECTIONS[right]
    self.offset_gx = self.offset_gx + right_steps * right_vector.x + forward_steps * forward_vector.x
    self.offset_gy = self.offset_gy + right_steps * right_vector.y + forward_steps * forward_vector.y
    self.offset_floor = self.offset_floor + floor_steps
    return recompute_pose(self)
end

function Controller:status_text()
    local mode = self.mode == "locked" and "已锁定" or "悬浮微调"
    local floor_m = self.offset_floor * 8
    local floor_label = self.offset_floor == 0 and "0层(0m)"
        or string.format("%+d层(%+dm)", self.offset_floor, floor_m)
    local hints = self.mode == "locked"
        and "方向键微调 [/]调层 R旋转 Enter确认 H解锁"
        or "方向键微调 [/]调层 R旋转 H锁定 左键确认"
    return string.format("%s | %s | 旋转 %d° | %s",
        mode, floor_label, self.drot * 90, hints)
end

local function rotation_components(rot_deg)
    if type(rot_deg) == "number" then
        return rot_deg, 0, 0
    end
    rot_deg = rot_deg or {}
    return rot_deg.Yaw or rot_deg.yaw or 0,
        rot_deg.Pitch or rot_deg.pitch or 0,
        rot_deg.Roll or rot_deg.roll or 0
end

local function trig(degrees)
    local radians = math.rad(degrees)
    return math.sin(radians), math.cos(radians)
end

local function rotate_world(x, y, z, rot_deg)
    local yaw, pitch, roll = rotation_components(rot_deg)
    local sp, cp = trig(pitch)
    local sy, cy = trig(yaw)
    local sr, cr = trig(roll)
    return cp * cy * x + (cy * sp * sr - sy * cr) * y - (cy * sp * cr + sy * sr) * z,
        cp * sy * x + (sy * sp * sr + cy * cr) * y - (sy * sp * cr - cy * sr) * z,
        sp * x - cp * sr * y + cp * cr * z
end

local function inverse_rotate_world(x, y, z, rot_deg)
    local yaw, pitch, roll = rotation_components(rot_deg)
    local sp, cp = trig(pitch)
    local sy, cy = trig(yaw)
    local sr, cr = trig(roll)
    return cp * cy * x + cp * sy * y + sp * z,
        (cy * sp * sr - sy * cr) * x + (sy * sp * sr + cy * cr) * y - cp * sr * z,
        -(cy * sp * cr + sy * sr) * x - (sy * sp * cr - cy * sr) * y + cp * cr * z
end

local function origin_components(origin)
    origin = origin or {}
    return origin.X or origin.x or 0, origin.Y or origin.y or 0, origin.Z or origin.z or 0
end

function M.grid_to_world(origin, rot_deg, gx_native, gy_native, height_native)
    local x, y, z = rotate_world(gx_native * 400, gy_native * 400, height_native * 400, rot_deg)
    local ox, oy, oz = origin_components(origin)
    return { X = ox + x, Y = oy + y, Z = oz + z }
end

function M.world_to_grid(origin, rot_deg, world)
    local ox, oy, oz = origin_components(origin)
    local x, y, z = inverse_rotate_world(world.X - ox, world.Y - oy, world.Z - oz, rot_deg)
    return { gx = x / 400, gy = y / 400, height = z / 400 }
end

local function native_view(block)
    local module_type, definition = definition_for(block)
    if not definition then return nil, "unknown_module" end
    if is_native_block(block) then
        return {
            id = block.id,
            type = module_type,
            gx = block.gx,
            gy = block.gy,
            height = block.height,
            rot = (block.rot or block.rotation or 0) % 4,
            palette_id = block.palette_id or block.paletteId,
        }
    end
    local module, module_error = to_module(block)
    if not module then return nil, module_error end
    local transform = module_native_transform(module)
    transform.id = block.id
    transform.type = module_type
    transform.palette_id = module.palette_id
    return transform
end

local function same_native(left, right)
    return left.type == right.type and left.gx == right.gx and left.gy == right.gy
        and left.height == right.height and left.rot == right.rot
end

function M.infer_placed_transform(before_blocks, after_blocks, section_doc)
    if type(section_doc) ~= "table" or type(section_doc.modules) ~= "table" then
        return nil, "invalid_section_document"
    end
    local before_ids, after_ids = {}, {}
    for _, block in ipairs(before_blocks or {}) do
        local key = tostring(block.id)
        if before_ids[key] then return nil, "duplicate_before_block_id" end
        before_ids[key] = true
    end
    local added = {}
    for _, block in ipairs(after_blocks or {}) do
        local key = tostring(block.id)
        if after_ids[key] then return nil, "duplicate_after_block_id" end
        after_ids[key] = true
        if not before_ids[key] then
            local view, view_error = native_view(block)
            if not view then return nil, view_error end
            added[#added + 1] = view
        end
    end
    if #added == 0 then return nil, "no_new_blocks" end
    if #added ~= #section_doc.modules then return nil, "module_count_mismatch" end

    local poses = {}
    for drot = 0, 3 do
        local base = {}
        for index, module in ipairs(section_doc.modules) do
            base[index] = module_native_transform(transform_module(module, {
                dgx = 0, dgy = 0, dfloor = 0, drot = drot,
            }))
            base[index].type = module.type or module.module_type
        end
        for _, first_added in ipairs(added) do
            for index, module in ipairs(section_doc.modules) do
                local module_type = module.type or module.module_type
                if first_added.type == module_type then
                    local dx = first_added.gx - base[index].gx
                    local dy = first_added.gy - base[index].gy
                    local dh = first_added.height - base[index].height
                    if dx % 4 == 0 and dy % 4 == 0 and dh % 2 == 0 then
                        local pose = { dgx = dx / 4, dgy = dy / 4, dfloor = dh / 2, drot = drot }
                        local expected = {}
                        for section_index, section_module in ipairs(section_doc.modules) do
                            expected[section_index] = module_native_transform(transform_module(section_module, pose))
                            expected[section_index].type = section_module.type or section_module.module_type
                        end
                        local used = {}
                        local valid = true
                        for _, wanted in ipairs(expected) do
                            local found
                            for added_index, candidate in ipairs(added) do
                                if not used[added_index] and same_native(wanted, candidate) then
                                    found = added_index
                                    break
                                end
                            end
                            if not found then
                                valid = false
                                break
                            end
                            used[found] = true
                        end
                        if valid then
                            poses[table.concat({ pose.dgx, pose.dgy, pose.dfloor, pose.drot }, ":")] = pose
                        end
                    end
                end
            end
        end
    end
    local result
    local count = 0
    for _, pose in pairs(poses) do
        result = pose
        count = count + 1
    end
    if count == 1 then return result end
    if count > 1 then return nil, "ambiguous_transform" end
    return nil, "unmatched_transform"
end

return M
