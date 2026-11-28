local source = debug.getinfo(1, "S").source
local test_directory = source:match("^@(.*[/\\])") or "tests/"
local scripts = test_directory .. "../Mods/StationSectionBlueprints/Scripts/"
package.path = scripts .. "?.lua;" .. package.path

local passed = 0
local function test(name, fn)
    local ok, err = xpcall(fn, debug.traceback)
    if not ok then
        io.stderr:write("[FAIL] " .. name .. "\n" .. tostring(err) .. "\n")
        os.exit(1)
    end
    passed = passed + 1
    print("[PASS] " .. name)
end

local function equal(actual, expected, context)
    if actual ~= expected then
        error((context or "values differ") .. ": expected=" .. tostring(expected)
            .. " actual=" .. tostring(actual), 2)
    end
end

local function truthy(value, context)
    if not value then error(context or "expected truthy value", 2) end
end

local function close_enough(actual, expected)
    truthy(math.abs(actual - expected) < 1e-7,
        "expected " .. tostring(expected) .. ", got " .. tostring(actual))
end

local function table_count(value)
    local count = 0
    for _ in pairs(value) do count = count + 1 end
    return count
end

local function write_text(path, text)
    local file, open_error = io.open(path, "wb")
    truthy(file, open_error)
    file:write(text)
    truthy(file:close())
end

local function read_text(path)
    local file = io.open(path, "rb")
    if not file then return nil end
    local text = file:read("*a")
    file:close()
    return text
end

local function canonical_module(id, module_type, gx, gy, floor, rotation)
    return {
        id = id, type = module_type, gx = gx, gy = gy,
        floor = floor or 0, rotation = rotation or 0,
    }
end

local function section_one(module_type)
    return {
        format = "station-blueprint-designer", formatVersion = 2,
        id = "test", name = "test", gameData = { buildId = "26639889", catalogVersion = 1 },
        modules = { canonical_module("m1", module_type or "BPO_Station_01", 0, 0, 0, 0) },
        buildings = {},
    }
end

local json = require("ssb_json")
local catalog = require("ssb_catalog_data")
local docking = require("ssb_docking")
local designer_native = require("ssb_native_designer")
local payload = require("ssb_payload")
local machine_paste = require("ssb_machine_paste")
local library = require("ssb_library")
local theme = require("ssb_ui_theme")
local toast = require("ssb_toast")

test("JSON roundtrip preserves UTF-8, numbers, booleans, arrays and objects", function()
    local original = {
        name = "产线 α", signed = -12.5, exponent = 1250.0,
        yes = true, no = false, values = { 1, -2.25, "三" },
        nested = { key = "value" },
    }
    local encoded = json.encode(original)
    truthy(encoded)
    local decoded, decode_error = json.decode(encoded)
    truthy(decoded, decode_error)
    equal(decoded.name, original.name)
    equal(decoded.signed, original.signed)
    equal(decoded.exponent, original.exponent)
    equal(decoded.values[2], -2.25)
    equal(decoded.values[3], "三")
    equal(decoded.nested.key, "value")
end)

test("JSON decodes escapes and surrogate pairs to UTF-8", function()
    local value, err = json.decode('{"text":"A\\n\\t\\u4e2d\\uD83D\\uDE00"}')
    truthy(value, err)
    equal(value.text, "A\n\t中" .. string.char(0xF0, 0x9F, 0x98, 0x80))
    local encoded = json.encode(value)
    local roundtrip = json.decode(encoded)
    equal(roundtrip.text, value.text)
end)

test("JSON preserves array null slots including trailing null", function()
    local value, err = json.decode('[1,null,3,null]')
    truthy(value, err)
    equal(value.__ssb_json_length, 4)
    equal(json.encode(value), '[1,null,3,null]')
end)

test("JSON maps object null to nil and top-level null to nil without error", function()
    local value = json.decode('{"missing":null,"kept":1}')
    equal(value.missing, nil)
    equal(value.kept, 1)
    local null_value, null_error = json.decode('null')
    equal(null_value, nil)
    equal(null_error, nil)
end)

test("JSON rejects malformed input and lone surrogates", function()
    local malformed = { '{', '[1,]', '01', '"\\uD800"', 'true false', '[1 2]' }
    for _, text in ipairs(malformed) do
        local value, err = json.decode(text)
        equal(value, nil, text)
        truthy(err, text)
    end
    local invalid_utf8 = json.decode('"' .. string.char(0xC0, 0x80) .. '"')
    equal(invalid_utf8, nil)
end)

test("JSON rejects cycles and non-finite numbers", function()
    local cyclic = {}
    cyclic.self = cyclic
    local value, err = json.encode(cyclic)
    equal(value, nil)
    truthy(err)
    equal(json.encode(math.huge), nil)
    equal(json.encode(0 / 0), nil)
end)

test("catalog exposes all modules, buildables and class aliases", function()
    equal(catalog.game_build, "26639889")
    equal(table_count(catalog.modules), 27)
    equal(table_count(catalog.buildables), 36)
    equal(catalog.module_by_class.BPO_Station_02, "BPO_Station_02")
    equal(catalog.module_by_class.BPO_Station_02_C, "BPO_Station_02")
    equal(catalog.buildable_by_class.BP_RefineryObject, "DAT_Refinery")
    equal(catalog.buildable_by_class.BP_RefineryObject_C, "DAT_Refinery")
end)

test("catalog uses exact pivot offsets and connector data", function()
    local dock = catalog.modules.BPO_Dock_2
    equal(dock.pivot_offset[1], -2)
    equal(dock.pivot_offset[2], 0)
    equal(dock.pivot_offset[3], 0)
    equal(catalog.modules.BPO_StationArmour_01B.pivot_offset[3], 2)
    equal(#catalog.modules.BPO_Station_02.connectors, 16)
    equal(catalog.modules.BPO_Station_02.size_units[3], 2)
    equal(catalog.buildables.DAT_UndergroundBelt.max_length, 8)
    equal(catalog.buildables.DAT_Refinery.size[1], 3)
end)

test("valid_slot accepts UTF-8, spaces and nested safe paths", function()
    truthy(designer_native.is_valid_slot(" 蓝图 设计/东区 α"))
    truthy(designer_native.is_valid_slot("root/items/abc-01_百分号%"))
end)

test("valid_slot rejects traversal, Windows separators, controls and malformed UTF-8", function()
    local invalid = {
        "", "/root", "root/", "root//item", "root\\item", "root/../item",
        "a<b", 'a"b', "a:b", "a|b", "a?b", "a*b", "a\0b", "a\nb",
        string.rep("a", 181), string.char(0xC0, 0x80),
    }
    for _, slot in ipairs(invalid) do
        equal(designer_native.is_valid_slot(slot), false, slot)
    end
end)

test("docking solves only the hovered target block connectors", function()
    local host = {
        { id = 1, type = "BPO_Station_01", gx = 0, gy = 0, floor = 0, rotation = 0 },
        { id = 2, type = "BPO_Station_01", gx = 100, gy = 0, floor = 0, rotation = 0 },
    }
    local candidates = docking.solve_target_block_candidates(host[1], host, section_one(), 0, 0)
    equal(#candidates, 16)
    for _, candidate in ipairs(candidates) do
        truthy(math.abs(candidate.dgx) <= 1 and math.abs(candidate.dgy) <= 1)
        equal(candidate.matched_connectors, 1)
    end
    equal(candidates[1].dgx, 1)
end)

test("docking ranks multi-port mates before single-port poses", function()
    local host = { { id = 9, type = "BPO_Station_02", gx = 0, gy = 0, floor = 0, rotation = 0 } }
    local candidates = docking.solve_target_block_candidates(host[1], host, section_one("BPO_Station_02"), 0, 0)
    truthy(#candidates >= 4)
    equal(candidates[1].matched_connectors, 4)
    for index = 2, #candidates do
        truthy(candidates[index - 1].matched_connectors >= candidates[index].matched_connectors)
    end
end)

test("docking rejects transformed AABB collisions with every host block", function()
    local host = {
        { id = 1, type = "BPO_Station_01", gx = 0, gy = 0, floor = 0, rotation = 0 },
        { id = 2, type = "BPO_Station_01", gx = 1, gy = 1, floor = 0, rotation = 0 },
    }
    local candidates = docking.solve_target_block_candidates(host[1], host, section_one("BPO_Station_02A"), 0, 0)
    truthy(candidates)
    for _, candidate in ipairs(candidates) do
        truthy(not (candidate.dgx == 1 and candidate.dgy == 0
            and candidate.dfloor == 0 and candidate.drot == 0))
    end
end)

test("controller cycles candidates and H freezes the locked hover pose", function()
    local controller = docking.new_controller(section_one(), { includes_machines = false })
    local target = { id = 1, type = "BPO_Station_01", gx = 0, gy = 0, floor = 0, rotation = 0 }
    controller:update_hover(target, { target }, { gx = 20, gy = 20, floor = 0 }, 0, false)
    truthy(#controller.candidates > 1)
    local first = controller.candidate_index
    controller:cycle_candidate(1)
    equal(controller.candidate_index, first % #controller.candidates + 1)
    controller:toggle_lock()
    local locked = { dgx = controller.pose.dgx, dgy = controller.pose.dgy,
        dfloor = controller.pose.dfloor, drot = controller.pose.drot }
    controller:update_hover(nil, {}, { gx = 99, gy = 99, floor = 9 }, 2, false)
    for field, value in pairs(locked) do equal(controller.pose[field], value, field) end
    local before_cycle = controller.candidate_index
    controller:cycle_candidate(-1)
    equal(controller.candidate_index, (before_cycle - 2) % #controller.candidates + 1)
end)

test("controller rotates in place and nudges relative to the camera", function()
    local controller = docking.new_controller(section_one(), {})
    controller:update_hover(nil, {}, { gx = 2, gy = 3, floor = 1 }, nil, true)
    controller:toggle_lock()
    controller:nudge(1, 1, 1, 0)
    equal(controller.pose.dgx, 3)
    equal(controller.pose.dgy, 4)
    equal(controller.pose.dfloor, 2)
    local x, y, floor = controller.pose.dgx, controller.pose.dgy, controller.pose.dfloor
    controller:rotate_cw()
    equal(controller.pose.drot, 1)
    equal(controller.pose.dgx, x)
    equal(controller.pose.dgy, y)
    equal(controller.pose.dfloor, floor)
    controller:nudge(1, 0, -1, 90)
    equal(controller.pose.dgx, x - 1)
    equal(controller.pose.dgy, y)
    equal(controller.pose.dfloor, floor - 1)
end)

test("controller Alt falls back to free 16m grid snapping", function()
    local controller = docking.new_controller(section_one(), {})
    local target = { id = 1, type = "BPO_Station_01", gx = 0, gy = 0, floor = 0, rotation = 0 }
    controller:update_hover(target, { target }, { gx = 1.6, gy = -2.4, floor = 0.6 }, 0, true)
    equal(controller.pose.dgx, 2)
    equal(controller.pose.dgy, -2)
    equal(controller.pose.dfloor, 1)
    equal(#controller.candidates, 0)
    truthy(controller:status_text():find("自由悬浮", 1, true))
end)

test("controller blocks nudge while hovering and mirror with machines", function()
    local controller = docking.new_controller(section_one(), { includes_machines = true })
    local _, nudge_error = controller:nudge(1, 0, 0, 0)
    equal(nudge_error, "not_locked")
    equal(controller:can_mirror(), false)
    local shell = docking.new_controller(section_one(), { includes_machines = false })
    equal(shell:can_mirror(), true)
end)

local function rotate_xy(x, y, rotation)
    if rotation == 0 then return x, y end
    if rotation == 1 then return -y, x end
    if rotation == 2 then return -x, -y end
    return y, -x
end

local function expected_after(module, pose, id)
    local definition = catalog.modules[module.type]
    local width = module.rotation % 2 == 1 and definition.size_units[2] or definition.size_units[1]
    local depth = module.rotation % 2 == 1 and definition.size_units[1] or definition.size_units[2]
    local gx, gy
    if pose.drot == 0 then gx, gy = module.gx, module.gy
    elseif pose.drot == 1 then gx, gy = -module.gy - depth + 1, module.gx
    elseif pose.drot == 2 then gx, gy = -module.gx - width + 1, -module.gy - depth + 1
    else gx, gy = module.gy, -module.gx - width + 1 end
    gx = gx + pose.dgx
    gy = gy + pose.dgy
    local rotation = (module.rotation + pose.drot) % 4
    local rw = rotation % 2 == 1 and definition.size_units[2] or definition.size_units[1]
    local rd = rotation % 2 == 1 and definition.size_units[1] or definition.size_units[2]
    local pivot = definition.pivot_offset
    local rx, ry = rotate_xy(pivot[1], pivot[2], rotation)
    return {
        id = id, class_name = module.type .. "_C",
        gx = 4 * gx + 2 * rw - 2 + rx,
        gy = 4 * gy + 2 * rd - 2 + ry,
        height = (module.floor + pose.dfloor) * 2 + pivot[3],
        rot = rotation,
    }
end

test("infer_placed_transform recovers exact transforms across all four rotations", function()
    local section = {
        modules = {
            canonical_module("a", "BPO_Station_2x1", 0, 0, 0, 0),
            canonical_module("b", "BPO_StationCorner_01", 2, 0, 0, 0),
        },
        buildings = {},
    }
    local before = { { id = 1, class_name = "BPO_Station_01_C", gx = 0, gy = 0, height = 0, rot = 0 } }
    for drot = 0, 3 do
        local pose = { dgx = 5, dgy = -3, dfloor = 2, drot = drot }
        local after = { before[1] }
        for index, module in ipairs(section.modules) do
            after[#after + 1] = expected_after(module, pose, 100 + index)
        end
        local inferred, infer_error = docking.infer_placed_transform(before, after, section)
        truthy(inferred, infer_error)
        for _, field in ipairs({ "dgx", "dgy", "dfloor", "drot" }) do
            equal(inferred[field], pose[field], field .. "/" .. drot)
        end
    end
end)

test("grid/world transforms roundtrip yaw, pitch and roll", function()
    local origin = { X = 1000, Y = -2000, Z = 300 }
    local rotation = { Yaw = 37, Pitch = 22, Roll = -15 }
    local world = docking.grid_to_world(origin, rotation, 3, -2, 4)
    local grid = docking.world_to_grid(origin, rotation, world)
    close_enough(grid.gx, 3)
    close_enough(grid.gy, -2)
    close_enough(grid.height, 4)
end)

local function conveyor(x, y, floor)
    return {
        id = tostring(x) .. ":" .. tostring(y), building_type = "DAT_ConveyorBelt",
        object_class = "BP_ConveyorBeltObject", native_x = 2 * x + 1 - 16,
        native_y = 2 * y + 1 - 16, native_height = (floor or 0) * 16, native_rotation = 0,
    }
end

local function refinery(x, y)
    return {
        id = "refinery", building_type = "DAT_Refinery", object_class = "BP_RefineryObject",
        native_x = 2 * x + 3 - 16, native_y = 2 * y + 3 - 16,
        native_height = 0, native_rotation = 0,
    }
end

test("machine occupancy computes exact 1m cells", function()
    local cells = machine_paste.step_occupied_cells(refinery(0, 0), catalog)
    equal(#cells, 9)
    local seen = {}
    for _, cell in ipairs(cells) do seen[cell.x .. ":" .. cell.y .. ":" .. cell.floor] = true end
    truthy(seen["0:0:0"] and seen["2:2:0"])
end)

test("machine collision guard rejects exact and partial existing overlaps", function()
    local exact = machine_paste.filter_non_overlapping_steps({ refinery(0, 0) }, { refinery(0, 0) }, catalog)
    equal(#exact.accepted, 0)
    equal(#exact.skipped_overlap, 1)
    local partial = machine_paste.filter_non_overlapping_steps({ refinery(1, 0) }, { refinery(0, 0) }, catalog)
    equal(#partial.accepted, 0)
    equal(#partial.skipped_overlap, 1)
end)

test("machine collision guard rejects intra-batch overlaps", function()
    local result = machine_paste.filter_non_overlapping_steps(
        { conveyor(0, 0), conveyor(0, 0), conveyor(2, 0) }, {}, catalog
    )
    equal(#result.accepted, 2)
    equal(#result.skipped_overlap, 1)
end)

test("machine occupancy marks both underground endpoints but not intermediate cells", function()
    local underground = conveyor(0, 0)
    underground.building_type = "DAT_UndergroundBelt"
    underground.object_class = "BP_UndergroundBeltObject"
    underground.underground_length = 4
    local cells = machine_paste.step_occupied_cells(underground, catalog)
    equal(#cells, 2)
    equal(cells[1].x, 0)
    equal(cells[2].x, 3)
    local exit_overlap = machine_paste.filter_non_overlapping_steps(
        { underground }, { conveyor(3, 0) }, catalog
    )
    equal(#exit_overlap.skipped_overlap, 1)
    local intermediate_only = machine_paste.filter_non_overlapping_steps(
        { underground }, { conveyor(1, 0) }, catalog
    )
    equal(#intermediate_only.accepted, 1)
end)

local function configured_step()
    return {
        id = "configured", building_type = "DAT_Container", object_class = "BP_ContainerObject",
        native_x = -14, native_y = -14, native_height = 0, native_rotation = 0,
        recipe_id = "REC_Example", palette_id = 4, teleporter_label = "东区",
        splitter = {
            priority_out = 2, priority_in = 1,
            port_filters = { ["2"] = "ITEM_B", ["0"] = "ITEM_A" },
            disabled_ports = { 3, 1 },
        },
        container = {
            disabled_ports = { 2 },
            logistic_filters = {
                { itemId = "ITEM_A", amount = 10, action = 1 },
                { itemId = "", amount = 0, action = 0 },
            },
            b_creative = true, b_creative_consume = true, creative_item = "ITEM_A",
        },
    }
end

test("typed config actions cover every command and deterministic slot ordering", function()
    local actions = machine_paste.build_config_actions(configured_step(), { creative_mode = true })
    local kinds = {}
    for _, action in ipairs(actions) do kinds[#kinds + 1] = action.kind end
    equal(table.concat(kinds, ","), table.concat({
        "set_recipe", "set_config2", "set_config2", "set_item", "set_item",
        "toggle_port", "toggle_port", "toggle_port", "set_logistic_filter",
        "set_logistic_filter", "set_creative_container", "set_text", "set_palette",
    }, ","))
    equal(actions[4].slot, 0)
    equal(actions[5].slot, 2)
    equal(actions[6].port_index, 1)
    equal(actions[7].port_index, 3)
    equal(actions[9].index, 0)
    equal(actions[9].action, 1)
    equal(actions[10].remove, true)
    equal(actions[11].b_consume, true)
    equal(actions[13].palette_id, 4)
end)

test("creative container replay is blocked unless explicitly enabled", function()
    local actions = machine_paste.build_config_actions(configured_step(), { creative_mode = false })
    for _, action in ipairs(actions) do
        truthy(action.kind ~= "set_creative_container")
    end
    local zero_palette = { palette_id = 0 }
    equal(#machine_paste.build_config_actions(zero_palette, {}), 0)
end)

test("pending and ready machine queues commit, count, take and discard cleanly", function()
    machine_paste.discard_pending_jobs()
    machine_paste.take_ready_jobs()
    local job = {
        json_path = "unused.json", transform = { dgx = 0, dgy = 0, dfloor = 0, drot = 0 },
        station_id = 42, machine_count = 3,
    }
    truthy(machine_paste.queue_pending_job(job))
    equal(machine_paste.commit_pending_jobs(), 1)
    equal(machine_paste.ready_machine_count(), 3)
    equal(#machine_paste.take_ready_jobs(), 1)
    equal(machine_paste.ready_machine_count(), 0)
    truthy(machine_paste.queue_pending_job(job))
    equal(machine_paste.discard_pending_jobs(), 1)
end)

test("real codec transform-section subprocess emits exact native machine steps", function()
    local input_path = test_directory .. ".codec-smoke-input.json"
    local plan_path = test_directory .. ".codec-smoke-plan.json"
    os.remove(input_path)
    os.remove(plan_path)
    local document = section_one()
    document.buildings = {
        { id = "belt", type = "DAT_ConveyorBelt", x = 2, y = 2, floor = 0, rotation = 0 },
    }
    write_text(input_path, json.encode(document))
    local steps, summary = payload.transform_section(input_path, {
        dgx = 1, dgy = -2, dfloor = 1, drot = 1,
    }, plan_path)
    os.remove(input_path)
    os.remove(plan_path)
    truthy(steps, summary)
    equal(#steps, 1)
    equal(summary.module_count, 1)
    equal(summary.machine_build_plan_count, 1)
    equal(steps[1].native_x, 43)
    equal(steps[1].native_y, -75)
    equal(steps[1].native_height, 16)
    equal(steps[1].native_rotation, 1)
    equal(read_text(input_path), nil)
    equal(read_text(plan_path), nil)
end)

test("library roundtrip retains includes_machines and rejects invalid flags", function()
    local state = library.new("StationSectionBlueprints-dev")
    local entry = library.add(state, {
        name = "含机台", folder = "", includes_machines = true,
        blocks = 2, machines = 1, game_build = "26639889",
    })
    truthy(entry)
    local restored = library.parse(state.root, library.serialize(state))
    truthy(restored.entries[entry.id].includes_machines)
    equal(restored.entries[entry.id].machines, 1)
    local invalid = library.add(state, {
        name = "bad", folder = "", includes_machines = "true",
        blocks = 1, machines = 0, game_build = "26639889",
    })
    equal(invalid, nil)
end)

test("store saves machine reports, loads canonical JSON and deletes both artifacts", function()
    local actual_native = package.loaded.ssb_native_designer
    local actual_payload = package.loaded.ssb_payload
    local temp = test_directory .. ".tmp-store"
    os.execute('if not exist "' .. temp .. '/items" mkdir "' .. temp .. '/items"')
    local deleted_slots = {}
    local native_mock = {
        selected_block_ids = function() return { 11, 12 } end,
        game_build = function() return "26639889" end,
        delete_slot = function(slot)
            deleted_slots[#deleted_slots + 1] = slot
            local path = temp .. "/" .. slot:gsub("^StationSectionBlueprints%-dev/", "") .. ".sav"
            os.remove(path)
            return true
        end,
    }
    local payload_mock = {
        create_section = function(_, work_slot, slot, ids, options)
            equal(work_slot:find("/work/", 1, true) ~= nil, true)
            equal(#ids, 2)
            equal(options.include_machines, true)
            equal(options.name, "含机台蓝图")
            local id = slot:match("([^/]+)$")
            local base = temp .. "/items/" .. id
            write_text(base .. ".sav", "native-placeholder")
            write_text(base .. ".json", json.encode(section_one()))
            return { blueprint = { Blocks = { {}, {} } } }, {
                selected_blocks = ids, kept_machines = 1,
                excluded_cross_boundary = 2, excluded_outside = 0,
                excluded_unpaired = 1, warnings = {},
            }
        end,
    }
    package.loaded.ssb_native_designer = native_mock
    package.loaded.ssb_payload = payload_mock
    package.loaded.ssb_store = nil
    local store_api = require("ssb_store")
    local store = {
        root = "StationSectionBlueprints-dev", directory = temp,
        directory_ready = true, library = library.new("StationSectionBlueprints-dev"),
    }
    local entry, report = store_api.save_selection(store, {}, {
        name = "含机台蓝图", folder = "", includes_machines = true,
    })
    truthy(entry, report)
    equal(entry.blocks, 2)
    equal(entry.machines, 1)
    equal(report.excluded_cross_boundary, 2)
    equal(report.excluded_unpaired, 1)
    local sav_path = temp .. "/items/" .. entry.id .. ".sav"
    local json_path = store_api.json_path_for(store, entry)
    truthy(read_text(sav_path))
    local document = store_api.load_canonical(store, entry.id)
    truthy(document)
    equal(document.modules[1].type, "BPO_Station_01")
    truthy(store_api.delete(store, entry.id))
    equal(read_text(sav_path), nil)
    equal(read_text(json_path), nil)
    equal(#deleted_slots, 1)
    local missing, missing_error = store_api.load_canonical(store, entry.id)
    equal(missing, nil)
    equal(missing_error, "missing_blueprint")
    os.remove(temp .. "/index.ssb")
    os.remove(temp .. "/index.ssb.bak")
    os.remove(temp .. "/index.ssb.tmp")
    os.execute('rmdir "' .. temp .. '/items"')
    os.execute('rmdir "' .. temp .. '"')
    package.loaded.ssb_native_designer = actual_native
    package.loaded.ssb_payload = actual_payload
    package.loaded.ssb_store = nil
end)

test("legacy shell-only entries report missing canonical JSON gracefully", function()
    local state = library.new("StationSectionBlueprints-dev")
    local entry = library.add(state, {
        name = "legacy", folder = "", includes_machines = false,
        blocks = 1, machines = 0, game_build = "26639889",
    })
    local store = { root = state.root, directory = test_directory .. ".missing-store", library = state }
    local document, err = require("ssb_store").load_canonical(store, entry.id)
    equal(document, nil)
    equal(err, "missing_canonical_json")
end)

test("machine collision guard ignores module-intrinsic default machines in existing station list", function()
    local filtered, err = machine_paste.filter_non_overlapping_steps({
        { id = "r1", building_type = "DAT_Refinery", native_x = -7, native_y = -7, native_height = 0, native_rotation = 0 },
    }, {
        { id = 41640, object_class = "BPO_StationBlockDock_C", native_x = 0, native_y = 0, native_height = 0, native_rotation = 0 },
    }, catalog)
    truthy(filtered, err)
    equal(#filtered.accepted, 1)
    equal(#filtered.skipped_overlap, 0)
    equal(#filtered.ignored_non_buildable_existing, 1)
    equal(filtered.ignored_non_buildable_existing[1], "BPO_StationBlockDock_C")
end)

test("catalog resolves canonical and native alias recipe/item names", function()
    equal(catalog.recipe_by_alias["hydrogenfuel"], "REC_HydrogenFuel")
    equal(catalog.recipe_by_alias["REC_HydrogenFuel"], "REC_HydrogenFuel")
    equal(catalog.recipe_by_alias["magneticcoils"], "REC_MageticCoils")
    equal(catalog.item_by_alias["hydrogenfuel"], "ITEM_HydrogenFuel")
    equal(catalog.item_by_alias["ITEM_HydrogenFuel"], "ITEM_HydrogenFuel")
    equal(catalog.item_by_alias["reinforcedplate"], "ITEM_ReinforcedPlates")
end)

test("find_session prefers FindAllOf over ForEachUObject to avoid UE4SS 4.0 startup crashes", function()
    local prev_find_all = _G.FindAllOf
    local prev_for_each = _G.ForEachUObject
    local prev_flags = _G.EObjectFlags
    _G.EObjectFlags = { RF_ClassDefaultObject = 1, RF_ArchetypeObject = 2 }
    local function make_obj(cls, addr, extra)
        local obj = extra or {}
        function obj:IsValid() return true end
        function obj:HasAnyFlags() return false end
        function obj:GetAddress() return addr end
        function obj:GetFullName() return cls .. " /Game/Test." .. cls .. "_" .. tostring(addr) end
        function obj:GetClass()
            return { GetFName = function() return { ToString = function() return cls end } end }
        end
        return obj
    end
    local controller = make_obj("BP_PlayerController_C", 1001, {})
    local hud = make_obj("WBP_DesignerHUD_C", 1005, {})
    local designer = make_obj("Designer", 1004, { Controller = controller })
    local component = make_obj("BPC_Designer_C", 1003, { Designer = designer })
    local pawn = make_obj("BP_DesignerPawn_C", 1002, { BPC_Designer = component, DesignerHUD = hud })
    controller.Pawn = pawn

    local queried = {}
    local foreach_called = false
    _G.FindAllOf = function(name)
        queried[#queried + 1] = name
        if name == "BP_PlayerController_C" then
            return { controller }
        end
        return {}
    end
    _G.ForEachUObject = function()
        foreach_called = true
        error("ForEachUObject must not be called when FindAllOf is available")
    end

    local ok, session, err = pcall(designer_native.find_session)
    _G.FindAllOf = prev_find_all
    _G.ForEachUObject = prev_for_each
    _G.EObjectFlags = prev_flags
    truthy(ok, tostring(session))
    truthy(session, tostring(err))
    equal(foreach_called, false)
    equal(#queried, 2)
    equal(session.designer:GetAddress(), 1004)
    equal(session.hud:GetAddress(), 1005)
end)

test("toast manager handles TTL progress decay, tag refresh, eviction and clear", function()
    local manager = toast.new_manager({ max_visible = 2, default_ttl = 4.0 })
    local first, kind1, evicted1 = manager:push("创造模式", "已开启", "success", 2.0, "creative")
    equal(kind1, "created")
    equal(#evicted1, 0)
    equal(first.progress, 1.0)

    local expired0 = manager:tick(0.5)
    equal(#expired0, 0)
    close_enough(first.progress, 0.75)

    -- Same tag refreshes existing card in-place instead of duplicating
    local refreshed, kind2 = manager:push("创造模式", "已关闭", "warn", 2.0, "creative")
    equal(kind2, "updated")
    equal(refreshed.id, first.id)
    equal(refreshed.detail, "已关闭")
    equal(refreshed.tone, "warn")
    equal(refreshed.progress, 1.0)
    equal(#manager.items, 1)

    -- Exceeding max_visible evicts oldest item
    manager:push("二号", "内容", "info", 2.0, "second")
    local third, kind3, evicted3 = manager:push("三号", "内容", "error", 1.0, "third")
    equal(kind3, "created")
    equal(#manager.items, 2)
    equal(#evicted3, 1)
    equal(evicted3[1].id, first.id)
    equal(manager.items[1].id, third.id)

    -- Tick expires 1.0s card while keeping 2.0s card at 0.5 progress
    local expired1 = manager:tick(1.0)
    equal(#expired1, 1)
    equal(expired1[1].id, third.id)
    equal(#manager.items, 1)
    close_enough(manager.items[1].progress, 0.5)

    local cleared = manager:clear()
    equal(#cleared, 1)
    equal(#manager.items, 0)
end)

test("ui theme produces SlateColor structs, resolves HUD canvas and respects exclude_classes", function()
    local info = theme.tone_color("info")
    local fallback = theme.tone_color("unknown_tone")
    equal(info.R, fallback.R)
    local slate = theme.slate_color(info)
    equal(slate.ColorUseRule, 0)
    equal(slate.SpecifiedColor.G, info.G)

    local function mock_widget(cls, addr, extra)
        local w = extra or {}
        function w:IsValid() return true end
        function w:HasAnyFlags() return false end
        function w:GetAddress() return addr end
        function w:GetClass()
            return { GetFName = function() return { ToString = function() return cls end } end }
        end
        function w:IsA(path) return path == "/Script/UMG." .. cls end
        function w:IsInViewport() return true end
        function w:GetVisibility() return theme.VISIBILITY.SelfHitTestInvisible end
        return w
    end

    local canvas1 = mock_widget("CanvasPanel", 201)
    local hud1 = mock_widget("WBP_DesignerHUD_C", 200, {
        Canvas = canvas1,
        WidgetTree = mock_widget("WidgetTree", 202),
        GetOwningPlayer = function() return mock_widget("BP_DesignerController_C", 203) end,
    })
    equal(theme.find_canvas_in_hud(hud1), canvas1)

    local canvas2 = mock_widget("CanvasPanel", 301)
    local wrapper_overlay = mock_widget("Overlay", 305, {
        GetChildrenCount = function() return 1 end,
        GetChildAt = function(_, idx) return idx == 0 and canvas2 or nil end,
    })
    -- Simulate UE4SS 4.0.0 strict UObject:IsA(UClass*) which rejects string arguments!
    canvas2.IsA = function(_, arg)
        if type(arg) == "string" then error("No overload found for IsA(string)") end
        return false
    end
    local hud2 = mock_widget("WBP_CharacterHUD_C", 300, {
        WidgetTree = mock_widget("WidgetTree", 302, { RootWidget = wrapper_overlay }),
        GetOwningPlayer = function() return mock_widget("BP_PlayerController_C", 303) end,
    })
    equal(theme.find_canvas_in_hud(hud2), canvas2)

    local prev_find_all = _G.FindAllOf
    local prev_flags = _G.EObjectFlags
    _G.EObjectFlags = { RF_ClassDefaultObject = 1, RF_ArchetypeObject = 2 }
    local userwidget_queried = false
    _G.FindAllOf = function(cls)
        if cls == "UserWidget" then
            userwidget_queried = true
            error("FindAllOf('UserWidget') must NEVER be called (crashes UE4SS 4.0.0 on UE 5.7.4)")
        end
        if cls == "WBP_DesignerHUD_C" then return { hud1 } end
        if cls == "WBP_CharacterHUD_C" then return { hud2 } end
        return {}
    end
    local ok, host = pcall(theme.find_active_hud_host, {
        exclude_classes = { WBP_DesignerHUD_C = true },
    })
    -- Also test empty world case: must STILL never call FindAllOf("UserWidget")!
    local ok_empty, empty_host = pcall(theme.find_active_hud_host, {
        exclude_classes = { WBP_DesignerHUD_C = true, WBP_CharacterHUD_C = true },
    })
    _G.FindAllOf = prev_find_all
    _G.EObjectFlags = prev_flags
    equal(userwidget_queried, false)
    truthy(ok, tostring(host))
    truthy(host)
    equal(host.hud:GetAddress(), 300)
    equal(host.canvas:GetAddress(), 301)
    truthy(ok_empty)
    equal(empty_host, nil)
end)

test("ssb_ui mounts same-tree drawer without touching OpenButton/DesignerPopup and registers pooled subfolder actions", function()
    local next_addr = 5000
    local function new_addr()
        next_addr = next_addr + 1
        return next_addr
    end
    local function make_slot()
        local s = {}
        function s:IsValid() return true end
        function s:SetPadding() end
        function s:SetAnchors() end
        function s:SetAlignment() end
        function s:SetPosition() end
        function s:SetSize() end
        function s:SetAutoSize() end
        function s:SetZOrder() end
        function s:SetVerticalAlignment() end
        return s
    end
    local function make_widget(cls, extra)
        local addr = new_addr()
        local w = extra or {}
        w._cls = cls
        w._addr = addr
        w._children = {}
        w._vis = theme.VISIBILITY.SelfHitTestInvisible
        w._text = ""
        function w:IsValid() return true end
        function w:HasAnyFlags() return false end
        function w:GetAddress() return self._addr end
        function w:GetClass()
            return { GetFName = function() return { ToString = function() return self._cls end } end }
        end
        function w:IsA(path) return path == "/Script/UMG." .. self._cls end
        function w:AddChild(child)
            self._children[#self._children + 1] = child
            return make_slot()
        end
        function w:RemoveChild(child)
            for i = #self._children, 1, -1 do
                if self._children[i] == child then
                    table.remove(self._children, i)
                    return true
                end
            end
            return false
        end
        function w:SetVisibility(v) self._vis = v end
        function w:GetVisibility() return self._vis end
        function w:SetText(ft) self._text = type(ft) == "table" and ft._raw or tostring(ft) end
        function w:GetText() return { ToString = function() return self._text end } end
        function w:SetHintText() end
        function w:SetBrushColor() end
        function w:SetPadding() end
        function w:SetHeightOverride() end
        function w:SetWidthOverride() end
        function w:SetSize() end
        function w:SetColour() end
        function w:SetColorAndOpacity() end
        function w:SetWrapLength() end
        function w:SetAutoWrapText() end
        function w:SetIsChecked(v) self._checked = v end
        function w:IsChecked() return self._checked == true end
        function w:SetIsEnabled() end
        if cls == "WBP_Button_Text_C" or cls == "WBP_CleanButton_Text_C" then
            w.Button = { IsValid = function() return true end, IsHovered = function() return false end }
        end
        return w
    end

    local saved_globals = {
        FText = _G.FText,
        StaticFindObject = _G.StaticFindObject,
        StaticConstructObject = _G.StaticConstructObject,
        RegisterKeyBind = _G.RegisterKeyBind,
        ExecuteInGameThread = _G.ExecuteInGameThread,
        ExecuteWithDelay = _G.ExecuteWithDelay,
        EObjectFlags = _G.EObjectFlags,
        Key = _G.Key,
        ModifierKey = _G.ModifierKey,
    }
    _G.EObjectFlags = { RF_Public = 1, RF_Standalone = 2, RF_ClassDefaultObject = 4, RF_ArchetypeObject = 8 }
    _G.FText = function(s) return { _raw = tostring(s), ToString = function() return tostring(s) end } end
    _G.Key = {
        LEFT_MOUSE_BUTTON = 1, MIDDLE_MOUSE_BUTTON = 2, H = 3, TAB = 4, R = 5, F = 6,
        UP_ARROW = 7, DOWN_ARROW = 8, LEFT_ARROW = 9, RIGHT_ARROW = 10,
        PAGE_UP = 11, PAGE_DOWN = 12, RETURN = 13, ALT = 14,
    }
    _G.ModifierKey = { SHIFT = 100, ALT = 101 }
    _G.RegisterKeyBind = function() end
    _G.ExecuteInGameThread = function(fn) fn() end
    _G.ExecuteWithDelay = function(_, fn) fn() end

    local widget_lib_cdo = {
        Create = function(_, _, cls_obj, _)
            local cname = cls_obj._path:match("([^.]+)$")
            return make_widget(cname)
        end,
    }
    _G.StaticFindObject = function(path)
        return {
            _path = path,
            IsValid = function() return true end,
            GetCDO = function() return widget_lib_cdo end,
        }
    end
    _G.StaticConstructObject = function(cls_obj, _)
        local cname = cls_obj._path:match("([^.]+)$")
        return make_widget(cname)
    end

    local actual_designer_native = package.loaded.ssb_native_designer
    package.loaded.ssb_native_designer = {
        snapshot_frame_blocks = function() return { { id = 1, class_name = "BPO_Station_01_C", gx = 0, gy = 0, height = 0, rot = 0 } } end,
        activate_select_tool = function() return true end,
        find_session = function() return nil end,
    }
    _G.__StationSectionBlueprintsUIRuntime = nil
    package.loaded.ssb_ui = nil
    local ui = require("ssb_ui")

    local canvas = make_widget("CanvasPanel")
    local save_container = make_widget("VerticalBox")
    local widget_tree = make_widget("WidgetTree", { RootWidget = canvas })
    local owner = make_widget("BP_DesignerController_C")
    local open_broadcast_called = false
    local hud = make_widget("WBP_DesignerHUD_C", {
        Canvas = canvas,
        WidgetTree = widget_tree,
        SaveOptionsContainer = save_container,
        OpenButton = { OnPressed = { Broadcast = function() open_broadcast_called = true; error("must not broadcast") end } },
        GetOwningPlayer = function() return owner end,
    })
    local designer = make_widget("Designer")

    local lib_state = library.new("StationSectionBlueprints-dev")
    library.create_folder(lib_state, "sub")
    library.add(lib_state, { name = "bp1", folder = "sub", includes_machines = false, blocks = 1, machines = 0, game_build = "26885430" })
    library.add(lib_state, { name = "bp2", folder = "sub", includes_machines = true, blocks = 2, machines = 3, game_build = "26885430" })
    local store = { library = lib_state }
    local store_api = {
        list = function(s, folder) return library.list(s.library, folder) end,
    }

    local state, attach_err = ui.attach(hud, designer, store_api, store)
    truthy(state, tostring(attach_err))
    equal(#canvas._children, 1)
    equal(state.drawer_open, false)
    equal(state.drawer._vis, theme.VISIBILITY.Collapsed)

    -- Trigger "局部蓝图库" button action: must open drawer cleanly without calling OpenButton.OnPressed:Broadcast()
    local lib_record = _G.__StationSectionBlueprintsUIRuntime.actions[state.library_button:GetAddress()]
    truthy(lib_record)
    lib_record.callback()
    equal(open_broadcast_called, false)
    equal(state.drawer_open, true)
    equal(state.drawer._vis, theme.VISIBILITY.Visible)
    equal(#state.list_pool, 1) -- root has 1 subfolder "sub"

    -- Enter subfolder "sub" (which has 2 blueprints -> creates a 2nd pooled button dynamically after attach)
    local folder_record = _G.__StationSectionBlueprintsUIRuntime.actions[state.list_pool[1].widget:GetAddress()]
    truthy(folder_record)
    folder_record.callback()
    equal(state.current_folder, "sub")
    equal(#state.list_pool, 2)
    -- Verify the newly pooled 2nd button IS registered in runtime.actions!
    local second_bp_addr = state.list_pool[2].widget:GetAddress()
    truthy(_G.__StationSectionBlueprintsUIRuntime.actions[second_bp_addr], "newly pooled button must be registered in runtime.actions")

    -- Clicking "局部蓝图库" again toggles drawer closed
    lib_record.callback()
    equal(state.drawer_open, false)
    equal(state.drawer._vis, theme.VISIBILITY.Collapsed)

    -- Detach removes drawer and toolbar entries cleanly
    truthy(ui.detach(state))
    equal(#canvas._children, 0)
    equal(#save_container._children, 0)
    equal(table_count(_G.__StationSectionBlueprintsUIRuntime.actions), 0)

    -- Restore globals & module cache
    for k, v in pairs(saved_globals) do _G[k] = v end
    package.loaded.ssb_native_designer = actual_designer_native
    package.loaded.ssb_ui = nil
    _G.__StationSectionBlueprintsUIRuntime = nil
end)

print(string.format("%d tests passed", passed))
