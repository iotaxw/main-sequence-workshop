use ms_blueprint_codec::canonical::*;
use ms_blueprint_codec::catalog_map::{buildable_class_path, catalog, MachineConfigKind};
use ms_blueprint_codec::config_codec::{
    decode_container_config, decode_elevator_or_teleporter_label, decode_splitter_config,
    encode_dock_config, DockConfig, DockFilterEntry,
};
use ms_blueprint_codec::connectors::{module_to_native_transform, rotate_xy};
use ms_blueprint_codec::gvas_template::default_colour_palettes;
use ms_blueprint_codec::section::*;
use ms_blueprint_codec::{canonical_to_sav_bytes, sav_bytes_to_canonical, NativeExportMode};
use serde_json::{json, Map};
use std::collections::{BTreeMap, HashSet};

fn placed_module(
    block_id: i32,
    module_type: &str,
    gx: i32,
    gy: i32,
    floor: i32,
    rotation: u8,
) -> PlacedModule {
    PlacedModule {
        id: format!("mod_{block_id}"),
        module_type: module_type.to_owned(),
        gx,
        gy,
        floor,
        rotation,
        label: None,
        recipe_id: None,
        dock_ports: None,
        palette_id: None,
        mining_item: None,
        dock_name: None,
        native_meta: Some(ModuleNativeMeta {
            class_path: None,
            block_id: Some(block_id),
            default_machines: Vec::new(),
        }),
    }
}

fn building(
    id: &str,
    building_type: &str,
    x: i32,
    y: i32,
    floor: i32,
    rotation: u8,
) -> PlacedBuilding {
    PlacedBuilding {
        id: id.to_owned(),
        building_type: building_type.to_owned(),
        x,
        y,
        floor,
        rotation,
        recipe_id: None,
        label: None,
        disabled_ports: None,
        underground_mode: None,
        underground_partner_id: None,
        priority_in: None,
        priority_out: None,
        port_filters: None,
        filter_items: None,
        palette_id: None,
        native_meta: None,
    }
}

fn underground_pair(
    id: &str,
    x: i32,
    y: i32,
    floor: i32,
    rotation: u8,
    distance: i32,
) -> Vec<PlacedBuilding> {
    let (dx, dy) = match rotation {
        0 => (1, 0),
        1 => (0, 1),
        2 => (-1, 0),
        _ => (0, -1),
    };
    let mut input = building(id, "DAT_UndergroundBelt", x, y, floor, rotation);
    input.underground_mode = Some("in".to_owned());
    input.underground_partner_id = Some(format!("{id}_out"));
    input.id = format!("{id}_in");
    let mut output = building(
        &format!("{id}_out"),
        "DAT_UndergroundBelt",
        x + dx * distance,
        y + dy * distance,
        floor,
        rotation,
    );
    output.underground_mode = Some("out".to_owned());
    output.underground_partner_id = Some(input.id.clone());
    vec![input, output]
}

fn document(modules: Vec<PlacedModule>, buildings: Vec<PlacedBuilding>) -> BlueprintDocument {
    BlueprintDocument {
        format: CANONICAL_FORMAT.to_owned(),
        format_version: CANONICAL_FORMAT_VERSION,
        id: "section_test".to_owned(),
        name: "Section test".to_owned(),
        description: None,
        game_data: GameDataMeta {
            build_id: GAME_BUILD_ID.to_owned(),
            catalog_version: CATALOG_VERSION,
        },
        modules,
        buildings,
        native_meta: None,
        extra: Map::new(),
    }
}

fn extraction_options(
    selected_block_ids: Vec<i32>,
    include_machines: bool,
) -> ExtractSectionOptions {
    ExtractSectionOptions {
        selected_block_ids,
        include_machines,
        normalize_origin: false,
        anchor_block_id: None,
        name: None,
    }
}

fn assert_exclusion(result: &ExtractSectionResult, id: &str, reason: &str) {
    assert!(
        result
            .report
            .excluded_details
            .iter()
            .any(|detail| detail.id == id && detail.reason == reason),
        "missing {reason} exclusion for {id}: {:?}",
        result.report.excluded_details
    );
}

#[test]
fn block_extraction_normalizes_and_preset_roundtrip_preserves_native_state() {
    let dock_config = DockConfig {
        display_name: "Section dock".to_owned(),
        filters: vec![
            DockFilterEntry {
                item_native: "waterice".to_owned(),
                b_loading: false,
            },
            DockFilterEntry {
                item_native: "reinforcedplate".to_owned(),
                b_loading: true,
            },
        ],
    };
    let raw_config = encode_dock_config(&dock_config);
    let mut dock = placed_module(41, "BPO_Dock", 4, -2, 3, 2);
    dock.palette_id = Some(9);
    dock.dock_name = Some("Section dock".to_owned());
    dock.dock_ports = Some(vec![
        DockPortConfig {
            port_index: 0,
            item_id: "ITEM_WaterIce".to_owned(),
            mode: "unload".to_owned(),
        },
        DockPortConfig {
            port_index: 1,
            item_id: "ITEM_ReinforcedPlates".to_owned(),
            mode: "load".to_owned(),
        },
    ]);
    dock.native_meta = Some(ModuleNativeMeta {
        class_path: Some("/Game/Blueprints/BuildingBlocks/BPO_Dock.BPO_Dock_C".to_owned()),
        block_id: Some(41),
        default_machines: vec![NativeDefaultMachine {
            class_path:
                "/Game/Blueprints/Machines/Docks/BPO_StationBlockDock.BPO_StationBlockDock_C"
                    .to_owned(),
            rel_x: 16,
            rel_y: 0,
            rel_height: 0,
            rel_rotation: 2,
            machine_id: Some(501),
            palette_id: Some(4),
            raw_config: raw_config.clone(),
        }],
    });
    let other = placed_module(42, "BPO_Station_01", 9, 0, 0, 0);
    let mut doc = document(vec![dock.clone(), other], Vec::new());
    let mut palettes = default_colour_palettes();
    palettes[0]["Colour0_0"]["r"] = json!(200);
    doc.native_meta = Some(NativeDocumentMeta {
        frame_type: None,
        version: Some(1),
        colour_palettes: Some(palettes.clone()),
        camera_location: None,
        camera_rotation: None,
        header: None,
    });

    let result = extract_section_from_doc(
        &doc,
        &ExtractSectionOptions {
            selected_block_ids: vec![41],
            include_machines: false,
            normalize_origin: true,
            anchor_block_id: None,
            name: Some("Extracted dock".to_owned()),
        },
    )
    .unwrap();
    assert_eq!(result.document.name, "Extracted dock");
    assert_eq!(result.document.modules.len(), 1);
    assert_eq!(result.document.buildings.len(), 0);
    assert_eq!(result.report.selected_blocks, vec![41]);
    assert_eq!(result.report.anchor_block_id, Some(41));
    assert_eq!(
        (
            result.report.origin_gx,
            result.report.origin_gy,
            result.report.origin_floor
        ),
        (4, -2, 3)
    );
    let extracted = &result.document.modules[0];
    assert_eq!((extracted.gx, extracted.gy, extracted.floor), (0, 0, 0));
    assert_eq!(extracted.palette_id, Some(9));
    assert_eq!(
        serde_json::to_value(&extracted.native_meta.as_ref().unwrap().default_machines).unwrap(),
        serde_json::to_value(&dock.native_meta.as_ref().unwrap().default_machines).unwrap()
    );
    assert_eq!(
        result
            .document
            .native_meta
            .as_ref()
            .unwrap()
            .colour_palettes,
        Some(palettes.clone())
    );

    let (sav, export_report) =
        canonical_to_sav_bytes(&result.document, NativeExportMode::StationPreset).unwrap();
    assert!(export_report.warnings.is_empty());
    let (roundtrip, import_report) = sav_bytes_to_canonical(&sav).unwrap();
    assert!(import_report.warnings.is_empty());
    assert_eq!(
        roundtrip.native_meta.as_ref().unwrap().colour_palettes,
        Some(palettes)
    );
    let roundtrip_dock = &roundtrip.modules[0];
    assert_eq!(roundtrip_dock.palette_id, Some(9));
    assert_eq!(roundtrip_dock.dock_name.as_deref(), Some("Section dock"));
    assert_eq!(roundtrip_dock.dock_ports, dock.dock_ports);
    let default_machine = &roundtrip_dock
        .native_meta
        .as_ref()
        .unwrap()
        .default_machines[0];
    assert_eq!(default_machine.machine_id, Some(501));
    assert_eq!(default_machine.palette_id, Some(4));
    assert_eq!(default_machine.raw_config, raw_config);
    assert_eq!((default_machine.rel_x, default_machine.rel_y), (16, 0));

    let from_sav = extract_section_from_sav(
        &sav,
        &ExtractSectionOptions {
            selected_block_ids: vec![41],
            include_machines: false,
            normalize_origin: true,
            anchor_block_id: None,
            name: None,
        },
    )
    .unwrap();
    assert_eq!(from_sav.document.modules.len(), 1);
    assert_eq!(from_sav.document.modules[0].palette_id, Some(9));
}

#[test]
fn normalization_shifts_every_kept_machine_with_the_anchor_module() {
    let module = placed_module(8, "BPO_Station_01", 2, -1, 3, 0);
    let machine = building("machine", "DAT_ConveyorBelt", 34, -14, 3, 0);
    let result = extract_section_from_doc(
        &document(vec![module], vec![machine]),
        &ExtractSectionOptions {
            selected_block_ids: vec![8],
            include_machines: true,
            normalize_origin: true,
            anchor_block_id: None,
            name: None,
        },
    )
    .unwrap();
    assert_eq!(
        (
            result.document.modules[0].gx,
            result.document.modules[0].gy,
            result.document.modules[0].floor
        ),
        (0, 0, 0)
    );
    assert_eq!(
        (
            result.document.buildings[0].x,
            result.document.buildings[0].y,
            result.document.buildings[0].floor
        ),
        (2, 2, 0)
    );
    assert_eq!(result.report.kept_machines, 1);
}

#[test]
fn extraction_rejects_invalid_selection_and_anchor_ids() {
    let doc = document(
        vec![placed_module(1, "BPO_Station_01", 0, 0, 0, 0)],
        Vec::new(),
    );
    let cases = [
        (vec![], None, "must not be empty"),
        (vec![0], None, "must be positive"),
        (vec![1, 1], None, "duplicate selected block ID 1"),
        (vec![2], None, "not found"),
        (vec![1], Some(2), "not in selected_block_ids"),
    ];
    for (selected_block_ids, anchor_block_id, expected) in cases {
        let error = extract_section_from_doc(
            &doc,
            &ExtractSectionOptions {
                selected_block_ids,
                include_machines: false,
                normalize_origin: true,
                anchor_block_id,
                name: None,
            },
        )
        .unwrap_err()
        .to_string();
        assert!(
            error.contains(expected),
            "expected `{expected}` in `{error}`"
        );
    }
}

#[test]
fn machine_filtering_honors_footprints_and_aligned_doorways() {
    let modules = vec![
        placed_module(1, "BPO_Station_01", 0, 0, 0, 0),
        placed_module(2, "BPO_Station_01", 1, 0, 0, 0),
        placed_module(3, "BPO_Station_01", 2, 0, 0, 0),
    ];
    let mut interior = building("interior", "DAT_ConveyorBelt", 3, 3, 0, 0);
    interior.palette_id = Some(6);
    interior.native_meta = Some(BuildingNativeMeta {
        class_path: Some(buildable_class_path("DAT_ConveyorBelt")),
        machine_id: Some(701),
        raw_config: Some(vec![9, 8, 7]),
        ..Default::default()
    });
    let buildings = vec![
        interior.clone(),
        building("door_a", "DAT_ConveyorBelt", 15, 6, 0, 0),
        building("door_b", "DAT_ConveyorBelt", 16, 6, 0, 0),
        building("straddler", "DAT_Refinery", 13, 1, 0, 0),
        building("to_unselected", "DAT_BeltBalancer_01", 30, 5, 0, 1),
        building("outside", "DAT_ConveyorBelt", 50, 50, 0, 0),
        building("exposed", "DAT_ConveyorBelt", 15, 1, 0, 0),
    ];
    let result = extract_section_from_doc(
        &document(modules, buildings),
        &extraction_options(vec![1, 2], true),
    )
    .unwrap();

    let kept: HashSet<&str> = result
        .document
        .buildings
        .iter()
        .map(|building| building.id.as_str())
        .collect();
    assert_eq!(kept, HashSet::from(["interior", "door_a", "door_b"]));
    assert_eq!(result.report.kept_machines, 3);
    assert_eq!(result.report.excluded_cross_boundary, 2);
    assert_eq!(result.report.excluded_outside, 2);
    assert_exclusion(&result, "straddler", "cross_boundary_footprint");
    assert_exclusion(&result, "to_unselected", "cross_boundary_footprint");
    assert_exclusion(&result, "outside", "outside_selection");
    assert_exclusion(&result, "exposed", "outside_selection");
    let kept_interior = result
        .document
        .buildings
        .iter()
        .find(|building| building.id == "interior")
        .unwrap();
    assert_eq!(kept_interior.palette_id, Some(6));
    assert_eq!(
        serde_json::to_value(&kept_interior.native_meta).unwrap(),
        serde_json::to_value(&interior.native_meta).unwrap()
    );
}

#[test]
fn underground_filtering_keeps_internal_pair_and_excludes_linked_failures() {
    let modules = vec![
        placed_module(1, "BPO_Station_01", 0, 0, 0, 0),
        placed_module(2, "BPO_Station_01", 1, 0, 0, 0),
        placed_module(3, "BPO_Station_01", 2, 0, 0, 0),
    ];
    let mut buildings = underground_pair("internal", 13, 8, 0, 0, 4);
    for endpoint in &mut buildings {
        endpoint.underground_partner_id = None;
    }
    buildings.extend(underground_pair("external", 29, 6, 0, 0, 4));
    buildings.extend(underground_pair("outside", 40, 1, 0, 0, 4));
    let mut lonely = building("lonely", "DAT_UndergroundBelt", 4, 4, 0, 0);
    lonely.underground_mode = Some("in".to_owned());
    buildings.push(lonely);

    let result = extract_section_from_doc(
        &document(modules, buildings),
        &extraction_options(vec![1, 2], true),
    )
    .unwrap();
    let kept: HashSet<&str> = result
        .document
        .buildings
        .iter()
        .map(|building| building.id.as_str())
        .collect();
    assert_eq!(kept, HashSet::from(["internal_in", "internal_out"]));
    assert_eq!(result.report.kept_machines, 1);
    assert_eq!(result.report.excluded_cross_boundary, 1);
    assert_eq!(result.report.excluded_outside, 1);
    assert_eq!(result.report.excluded_unpaired, 1);
    for id in ["external_in", "external_out"] {
        assert_exclusion(&result, id, "cross_boundary_underground");
    }
    for id in ["outside_in", "outside_out"] {
        assert_exclusion(&result, id, "outside_selection");
    }
    assert_exclusion(&result, "lonely", "unpaired_underground");

    let plan = transform_section(
        &result.document,
        &SectionTransform {
            dgx: 0,
            dgy: 0,
            dfloor: 0,
            drot: 0,
        },
    )
    .unwrap();
    assert_eq!(plan.machine_build_plan.len(), 1);
    assert_eq!(plan.machine_build_plan[0].underground_length, Some(5));
    assert_eq!(plan.machine_build_plan[0].raw_config_hex, "010005000000");

    let (sav, export_report) =
        canonical_to_sav_bytes(&result.document, NativeExportMode::StationPreset).unwrap();
    assert!(export_report.warnings.is_empty());
    let (roundtrip, _) = sav_bytes_to_canonical(&sav).unwrap();
    let input = roundtrip
        .buildings
        .iter()
        .find(|building| building.underground_mode.as_deref() == Some("in"))
        .unwrap();
    let output = roundtrip
        .buildings
        .iter()
        .find(|building| building.underground_mode.as_deref() == Some("out"))
        .unwrap();
    assert_eq!((input.x, input.y, output.x, output.y), (13, 8, 17, 8));
}

#[test]
fn rotated_module_bounds_and_corner_bevel_match_designer_geometry() {
    let rotated = extract_section_from_doc(
        &document(
            vec![placed_module(5, "BPO_Station_2x1", 0, 0, 0, 1)],
            vec![
                building("rotated_valid", "DAT_ConveyorBelt", 1, 1, 0, 0),
                building("rotated_void", "DAT_ConveyorBelt", 0, 0, 0, 0),
            ],
        ),
        &extraction_options(vec![5], true),
    )
    .unwrap();
    assert_eq!(rotated.document.buildings.len(), 1);
    assert_eq!(rotated.document.buildings[0].id, "rotated_valid");
    assert_exclusion(&rotated, "rotated_void", "outside_selection");

    let corner = extract_section_from_doc(
        &document(
            vec![placed_module(6, "BPO_StationCorner_01", 0, 0, 0, 0)],
            vec![
                building("corner_valid", "DAT_ConveyorBelt", 8, 8, 0, 0),
                building("bevel_void", "DAT_ConveyorBelt", 14, 1, 0, 0),
            ],
        ),
        &extraction_options(vec![6], true),
    )
    .unwrap();
    assert_eq!(corner.document.buildings.len(), 1);
    assert_eq!(corner.document.buildings[0].id, "corner_valid");
    assert_exclusion(&corner, "bevel_void", "outside_selection");
}

#[test]
fn station_02_b_balcony_ring_and_exposed_doorways_are_exact() {
    let module = placed_module(7, "BPO_Station_02", 0, 0, 0, 0);
    let buildings = vec![
        building("ring", "DAT_ConveyorBelt", 2, 2, 1, 0),
        building("hole", "DAT_ConveyorBelt", 4, 4, 1, 0),
        building("cross_hole", "DAT_Refinery", 3, 3, 1, 0),
        building("exposed", "DAT_ConveyorBelt", 31, 6, 0, 0),
    ];
    let result = extract_section_from_doc(
        &document(vec![module], buildings),
        &extraction_options(vec![7], true),
    )
    .unwrap();
    assert_eq!(result.document.buildings.len(), 1);
    assert_eq!(result.document.buildings[0].id, "ring");
    assert_eq!(result.report.excluded_cross_boundary, 1);
    assert_eq!(result.report.excluded_outside, 2);
    assert_exclusion(&result, "hole", "outside_selection");
    assert_exclusion(&result, "cross_hole", "cross_boundary_footprint");
    assert_exclusion(&result, "exposed", "outside_selection");
}

fn native_building_coordinates(building: &PlacedBuilding) -> (i32, i32, i32) {
    let def = catalog()
        .buildables_by_id
        .get(&building.building_type)
        .unwrap();
    let (w, d) = if building.rotation % 2 == 1 {
        (def.size[1], def.size[0])
    } else {
        (def.size[0], def.size[1])
    };
    (
        2 * building.x + w - 16,
        2 * building.y + d - 16,
        building.floor * 16,
    )
}

#[test]
fn transform_rotation_preserves_native_block_and_machine_invariants() {
    let tf_translation = (2, -1, 3);
    for module_type in ["BPO_Station_2x1", "BPO_Station_02A", "BPO_Station_01"] {
        for drot in 0u8..=3 {
            let module = placed_module(11, module_type, -2, 3, -1, 2);
            let old_native_block = module_to_native_transform(&module);
            let mut buildings = vec![
                building("refinery", "DAT_Refinery", -30, 43, -1, 0),
                building("splitter", "DAT_Splitter", -20, 45, -1, 1),
                building("workbench", "DAT_WorkbenchMachine", -18, 37, -1, 0),
                building("balancer", "DAT_BeltBalancer_01", -12, 38, -1, 2),
            ];
            buildings.extend(underground_pair("ug", -8, 39, -1, 0, 4));
            let doc = document(vec![module], buildings);
            let transformed = transform_section(
                &doc,
                &SectionTransform {
                    dgx: tf_translation.0,
                    dgy: tf_translation.1,
                    dfloor: tf_translation.2,
                    drot,
                },
            )
            .unwrap();

            let expected_block_xy = rotate_xy(old_native_block.0, old_native_block.1, drot);
            let new_native_block = module_to_native_transform(&transformed.document.modules[0]);
            assert_eq!(
                (new_native_block.0, new_native_block.1),
                (
                    expected_block_xy.0 + tf_translation.0 * 4,
                    expected_block_xy.1 + tf_translation.1 * 4
                ),
                "module {module_type}, drot {drot}"
            );
            assert_eq!(
                new_native_block.2,
                old_native_block.2 + tf_translation.2 * 2
            );
            assert_eq!(new_native_block.3, (old_native_block.3 + drot) % 4);

            for original in &doc.buildings {
                if original.underground_mode.as_deref() == Some("out") {
                    continue;
                }
                let step = transformed
                    .machine_build_plan
                    .iter()
                    .find(|step| step.id == original.id)
                    .unwrap();
                let old_native = native_building_coordinates(original);
                let expected_xy = rotate_xy(old_native.0, old_native.1, drot);
                assert_eq!(
                    (step.native_x, step.native_y),
                    (
                        expected_xy.0 + tf_translation.0 * 32,
                        expected_xy.1 + tf_translation.1 * 32
                    ),
                    "building {}, module {module_type}, drot {drot}",
                    original.id
                );
                assert_eq!(step.native_height, old_native.2 + tf_translation.2 * 16);
                assert_eq!(step.native_rotation, (original.rotation + drot) % 4);
                assert_eq!(
                    step.object_class,
                    buildable_class_path(&original.building_type)
                );
                if original.building_type == "DAT_UndergroundBelt" {
                    assert_eq!(step.underground_length, Some(5));
                }
            }
            assert_eq!(transformed.machine_build_plan.len(), 5);
        }
    }
}

fn decode_hex(hex: &str) -> Vec<u8> {
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digits = std::str::from_utf8(pair).unwrap();
            u8::from_str_radix(digits, 16).unwrap()
        })
        .collect()
}

#[test]
fn build_plan_emits_structured_live_configuration() {
    let mut splitter = building("splitter", "DAT_Splitter", 2, 2, 0, 0);
    splitter.priority_in = Some(0);
    splitter.priority_out = Some(2);
    splitter.disabled_ports = Some(vec![1]);
    splitter.port_filters = Some(BTreeMap::from([(
        "2".to_owned(),
        "ITEM_WaterIce".to_owned(),
    )]));
    let mut container = building("container", "DAT_Container", 5, 5, 0, 0);
    container.filter_items = Some(vec!["ITEM_WaterIce".to_owned()]);
    container.native_meta = Some(BuildingNativeMeta {
        b_creative: Some(true),
        creative_item: Some("ITEM_WaterIce".to_owned()),
        b_creative_consume: Some(true),
        logistic_filters: vec![LogisticFilterEntry {
            item_id: "ITEM_WaterIce".to_owned(),
            amount: 25,
            action: 1,
        }],
        ..Default::default()
    });
    let mut teleporter = building("teleporter", "DAT_Teleporter", 9, 9, 0, 0);
    teleporter.label = Some("North gate".to_owned());
    let doc = document(
        vec![placed_module(1, "BPO_Station_02A", 0, 0, 0, 0)],
        vec![splitter, container, teleporter],
    );
    let plan = transform_section(
        &doc,
        &SectionTransform {
            dgx: 0,
            dgy: 0,
            dfloor: 0,
            drot: 1,
        },
    )
    .unwrap();

    let splitter_step = plan
        .machine_build_plan
        .iter()
        .find(|step| step.id == "splitter")
        .unwrap();
    assert_eq!(splitter_step.config_kind, MachineConfigKind::Splitter);
    let splitter_config = splitter_step.splitter.as_ref().unwrap();
    assert_eq!(splitter_config.priority_in, Some(0));
    assert_eq!(splitter_config.priority_out, Some(2));
    assert_eq!(splitter_config.disabled_ports, Some(vec![1]));
    let splitter_raw = decode_splitter_config(&decode_hex(&splitter_step.raw_config_hex)).unwrap();
    assert_eq!(splitter_raw.filters_native[1], "waterice");
    assert_eq!(splitter_raw.priority_output_index, 1);
    assert_eq!(splitter_raw.priority_input_index, 0);
    assert_eq!(splitter_raw.port_states, vec![0, 1, 1]);

    let container_step = plan
        .machine_build_plan
        .iter()
        .find(|step| step.id == "container")
        .unwrap();
    let structured = container_step.container.as_ref().unwrap();
    assert!(structured.b_creative);
    assert!(structured.b_creative_consume);
    assert_eq!(structured.logistic_filters[0].amount, 25);
    let container_raw = decode_container_config(
        &decode_hex(&container_step.raw_config_hex),
        ms_blueprint_codec::catalog_map::item_native_to_canonical,
    )
    .unwrap();
    assert!(container_raw.b_creative);
    assert_eq!(container_raw.creative_item_native, "waterice");
    assert_eq!(container_raw.logistic_filters[0].amount, 25);

    let teleporter_step = plan
        .machine_build_plan
        .iter()
        .find(|step| step.id == "teleporter")
        .unwrap();
    assert_eq!(
        teleporter_step.teleporter_label.as_deref(),
        Some("North gate")
    );
    assert_eq!(
        decode_elevator_or_teleporter_label(&decode_hex(&teleporter_step.raw_config_hex)).unwrap(),
        Some("North gate".to_owned())
    );
}
