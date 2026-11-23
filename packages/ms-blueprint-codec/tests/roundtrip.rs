use ms_blueprint_codec::canonical::*;
use ms_blueprint_codec::config_codec::*;
use ms_blueprint_codec::{canonical_to_sav_bytes, sav_bytes_to_canonical, NativeExportMode};
use serde_json::Map;
use std::collections::BTreeMap;

#[test]
fn binary_configs_match_observed_build_26639889_bytes() {
    // Observed BP_RefineryObject: hydrogenfuel + ports [1, 0, 1, 1]
    let ref_bytes: Vec<u8> = vec![
        1, 0, 13, 0, 0, 0, 104, 121, 100, 114, 111, 103, 101, 110, 102, 117, 101, 108, 0, 4, 0, 0,
        0, 1, 0, 1, 1,
    ];
    let dec = decode_assembler_config(&ref_bytes).unwrap();
    assert_eq!(dec.recipe_native, "hydrogenfuel");
    assert_eq!(dec.port_states, vec![1, 0, 1, 1]);
    assert_eq!(encode_assembler_config(&dec), ref_bytes);

    // Observed BP_SplitterObject_2: 3 empty filters, prioOut=-1, prioIn=-1, ports [1, 1, 1]
    let spl_bytes: Vec<u8> = vec![
        1, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255,
        255, 3, 0, 0, 0, 1, 1, 1,
    ];
    let sdec = decode_splitter_config(&spl_bytes).unwrap();
    assert_eq!(sdec.filters_native, vec!["", "", ""]);
    assert_eq!(sdec.priority_output_index, -1);
    assert_eq!(sdec.priority_input_index, -1);
    assert_eq!(sdec.port_states, vec![1, 1, 1]);
    assert_eq!(encode_splitter_config(&sdec), spl_bytes);

    // Observed BP_UndergroundBeltObject_2: Length = 7
    let ug_bytes: Vec<u8> = vec![1, 0, 7, 0, 0, 0];
    assert_eq!(decode_underground_length(&ug_bytes).unwrap(), 7);
    assert_eq!(encode_underground_length(7), ug_bytes);

    // Observed BP_ContainerObject_2: non-creative, no filters, 16 enabled ports
    let cnt_bytes: Vec<u8> = vec![
        1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 1, 1, 1, 1, 1,
    ];
    let cdec = decode_container_config(&cnt_bytes, |s| s.to_owned()).unwrap();
    assert!(!cdec.b_creative);
    assert_eq!(cdec.port_states.len(), 16);
    assert_eq!(encode_container_config(&cdec, |s| s.to_owned()), cnt_bytes);
}

#[test]
fn full_station_and_preset_roundtrip_preserves_all_semantics() {
    let mut splitter_filters = BTreeMap::new();
    splitter_filters.insert("1".to_owned(), "ITEM_TitaniumPlates".to_owned());
    splitter_filters.insert("3".to_owned(), "ITEM_BackpackMk1".to_owned());

    let mut balancer_filters = BTreeMap::new();
    balancer_filters.insert("2".to_owned(), "ITEM_WaterIce".to_owned());

    let doc = BlueprintDocument {
        format: CANONICAL_FORMAT.to_owned(),
        format_version: CANONICAL_FORMAT_VERSION,
        id: "bp_test_roundtrip".to_owned(),
        name: "测试空间站往返".to_owned(),
        description: None,
        game_data: GameDataMeta {
            build_id: GAME_BUILD_ID.to_owned(),
            catalog_version: CATALOG_VERSION,
        },
        modules: vec![
            PlacedModule {
                id: "m1".to_owned(),
                module_type: "BPO_Station_02A".to_owned(),
                gx: 0,
                gy: 1,
                floor: 0,
                rotation: 0,
                label: None,
                palette_id: None,
                mining_item: None,
                dock_name: None,
                native_meta: None,
            },
            PlacedModule {
                id: "m2".to_owned(),
                module_type: "BPO_ElevatorBlock_03".to_owned(),
                gx: 0,
                gy: 0,
                floor: 0,
                rotation: 0,
                label: Some("主电梯".to_owned()),
                palette_id: None,
                mining_item: None,
                dock_name: None,
                native_meta: None,
            },
            PlacedModule {
                id: "m3".to_owned(),
                module_type: "BPO_StationArmour_01B".to_owned(),
                gx: 0,
                gy: 0,
                floor: -1,
                rotation: 0,
                label: None,
                palette_id: None,
                mining_item: None,
                dock_name: None,
                native_meta: None,
            },
            PlacedModule {
                id: "m4".to_owned(),
                module_type: "BPO_MiningDroneBayBlock_2".to_owned(),
                gx: -1,
                gy: 1,
                floor: 0,
                rotation: 2,
                label: None,
                palette_id: Some(1),
                mining_item: Some("ITEM_WaterIce".to_owned()),
                dock_name: None,
                native_meta: None,
            },
            PlacedModule {
                id: "m5".to_owned(),
                module_type: "BPO_Dock".to_owned(),
                gx: -1,
                gy: 0,
                floor: 0,
                rotation: 2,
                label: None,
                palette_id: None,
                mining_item: None,
                dock_name: Some("货运停泊口".to_owned()),
                native_meta: None,
            },
        ],
        buildings: vec![
            PlacedBuilding {
                id: "b_ref".to_owned(),
                building_type: "DAT_Refinery".to_owned(),
                x: 4,
                y: 20,
                floor: 0,
                rotation: 0,
                recipe_id: Some("REC_MagneticCoilsAlt1".to_owned()),
                label: None,
                disabled_ports: Some(vec![1, 3]),
                underground_mode: None,
                underground_partner_id: None,
                priority_in: None,
                priority_out: None,
                port_filters: None,
                filter_items: None,
                palette_id: None,
                native_meta: None,
            },
            PlacedBuilding {
                id: "b_spl".to_owned(),
                building_type: "DAT_Splitter_2".to_owned(),
                x: 8,
                y: 21,
                floor: 0,
                rotation: 0,
                recipe_id: None,
                label: None,
                disabled_ports: Some(vec![2]),
                underground_mode: None,
                underground_partner_id: None,
                priority_in: None,
                priority_out: Some(1),
                port_filters: Some(splitter_filters.clone()),
                filter_items: None,
                palette_id: None,
                native_meta: None,
            },
            PlacedBuilding {
                id: "b_bal".to_owned(),
                building_type: "DAT_BeltBalancer_02".to_owned(),
                x: 10,
                y: 21,
                floor: 0,
                rotation: 0,
                recipe_id: None,
                label: None,
                disabled_ports: Some(vec![3]),
                underground_mode: None,
                underground_partner_id: None,
                priority_in: Some(1),
                priority_out: Some(2),
                port_filters: Some(balancer_filters.clone()),
                filter_items: None,
                palette_id: None,
                native_meta: None,
            },
            PlacedBuilding {
                id: "b_cnt".to_owned(),
                building_type: "DAT_Container_2".to_owned(),
                x: 14,
                y: 20,
                floor: 0,
                rotation: 0,
                recipe_id: None,
                label: None,
                disabled_ports: Some(vec![0, 15]),
                underground_mode: None,
                underground_partner_id: None,
                priority_in: None,
                priority_out: None,
                port_filters: None,
                filter_items: Some(vec!["ITEM_TitaniumPlates".to_owned()]),
                palette_id: None,
                native_meta: None,
            },
            // Braided same-line underground belts: Pair A (x=5 -> x=11, len=7) and Pair B (x=7 -> x=13, len=7)!
            PlacedBuilding {
                id: "ug_a_in".to_owned(),
                building_type: "DAT_UndergroundBelt_2".to_owned(),
                x: 5,
                y: 28,
                floor: 0,
                rotation: 0,
                recipe_id: None,
                label: None,
                disabled_ports: None,
                underground_mode: Some("in".to_owned()),
                underground_partner_id: Some("ug_a_out".to_owned()),
                priority_in: None,
                priority_out: None,
                port_filters: None,
                filter_items: None,
                palette_id: None,
                native_meta: None,
            },
            PlacedBuilding {
                id: "ug_b_in".to_owned(),
                building_type: "DAT_UndergroundBelt_2".to_owned(),
                x: 7,
                y: 28,
                floor: 0,
                rotation: 0,
                recipe_id: None,
                label: None,
                disabled_ports: None,
                underground_mode: Some("in".to_owned()),
                underground_partner_id: Some("ug_b_out".to_owned()),
                priority_in: None,
                priority_out: None,
                port_filters: None,
                filter_items: None,
                palette_id: None,
                native_meta: None,
            },
            PlacedBuilding {
                id: "ug_a_out".to_owned(),
                building_type: "DAT_UndergroundBelt_2".to_owned(),
                x: 11,
                y: 28,
                floor: 0,
                rotation: 0,
                recipe_id: None,
                label: None,
                disabled_ports: None,
                underground_mode: Some("out".to_owned()),
                underground_partner_id: Some("ug_a_in".to_owned()),
                priority_in: None,
                priority_out: None,
                port_filters: None,
                filter_items: None,
                palette_id: None,
                native_meta: None,
            },
            PlacedBuilding {
                id: "ug_b_out".to_owned(),
                building_type: "DAT_UndergroundBelt_2".to_owned(),
                x: 13,
                y: 28,
                floor: 0,
                rotation: 0,
                recipe_id: None,
                label: None,
                disabled_ports: None,
                underground_mode: Some("out".to_owned()),
                underground_partner_id: Some("ug_b_in".to_owned()),
                priority_in: None,
                priority_out: None,
                port_filters: None,
                filter_items: None,
                palette_id: None,
                native_meta: None,
            },
        ],
        native_meta: None,
        extra: Map::new(),
    };

    // 1. Round-trip as STATION
    let (sav_bytes, exp_rep) = canonical_to_sav_bytes(&doc, NativeExportMode::Station).unwrap();
    assert!(exp_rep.warnings.is_empty(), "unexpected warnings: {:?}", exp_rep.warnings);
    assert_eq!(exp_rep.native_machine_count, 6); // 4 regular + 2 folded underground pairs
    assert!(exp_rep.connector_count > 0);

    let (rt, imp_rep) = sav_bytes_to_canonical(&sav_bytes).unwrap();
    assert!(imp_rep.warnings.is_empty(), "unexpected import warnings: {:?}", imp_rep.warnings);
    assert_eq!(rt.name, "测试空间站往返");
    assert_eq!(rt.modules.len(), 5);
    assert_eq!(rt.buildings.len(), 8);

    // Verify Armour_01B floor round-trip
    let armour = rt.modules.iter().find(|m| m.module_type == "BPO_StationArmour_01B").unwrap();
    assert_eq!((armour.gx, armour.gy, armour.floor), (0, 0, -1));

    // Verify MiningDroneBay & Dock & Elevator config round-trip
    let mine = rt.modules.iter().find(|m| m.module_type == "BPO_MiningDroneBayBlock_2").unwrap();
    assert_eq!(mine.mining_item.as_deref(), Some("ITEM_WaterIce"));
    assert_eq!(mine.palette_id, Some(1));
    let dock = rt.modules.iter().find(|m| m.module_type == "BPO_Dock").unwrap();
    assert_eq!(dock.dock_name.as_deref(), Some("货运停泊口"));
    let elev = rt.modules.iter().find(|m| m.module_type == "BPO_ElevatorBlock_03").unwrap();
    assert_eq!(elev.label.as_deref(), Some("主电梯"));

    // Verify Refinery recipe special override & disabledPorts
    let rf = rt.buildings.iter().find(|b| b.building_type == "DAT_Refinery").unwrap();
    assert_eq!((rf.x, rf.y, rf.floor), (4, 20, 0));
    assert_eq!(rf.recipe_id.as_deref(), Some("REC_MagneticCoilsAlt1"));
    assert_eq!(rf.disabled_ports, Some(vec![1, 3]));

    // Verify Splitter & BeltBalancer priorities, filters, disabled ports
    let sp = rt.buildings.iter().find(|b| b.building_type == "DAT_Splitter_2").unwrap();
    assert_eq!(sp.priority_out, Some(1));
    assert_eq!(sp.disabled_ports, Some(vec![2]));
    assert_eq!(sp.port_filters, Some(splitter_filters));

    let bl = rt.buildings.iter().find(|b| b.building_type == "DAT_BeltBalancer_02").unwrap();
    assert_eq!(bl.priority_in, Some(1));
    assert_eq!(bl.priority_out, Some(2));
    assert_eq!(bl.disabled_ports, Some(vec![3]));
    assert_eq!(bl.port_filters, Some(balancer_filters));

    // Verify Container filters & disabled ports
    let cn = rt.buildings.iter().find(|b| b.building_type == "DAT_Container_2").unwrap();
    assert_eq!(cn.disabled_ports, Some(vec![0, 15]));
    assert_eq!(cn.filter_items, Some(vec!["ITEM_TitaniumPlates".to_owned()]));

    // Verify braided underground belts kept exact pairing (5 -> 11, 7 -> 13)!
    let ug_ins: Vec<&PlacedBuilding> = rt
        .buildings
        .iter()
        .filter(|b| b.underground_mode.as_deref() == Some("in"))
        .collect();
    assert_eq!(ug_ins.len(), 2);
    for u_in in ug_ins {
        let partner = rt
            .buildings
            .iter()
            .find(|b| Some(b.id.as_str()) == u_in.underground_partner_id.as_deref())
            .expect("partner must exist");
        assert_eq!(partner.underground_mode.as_deref(), Some("out"));
        assert_eq!(partner.x - u_in.x, 6);
        assert_eq!(partner.y, u_in.y);
    }

    // 2. Round-trip as STATION_PRESET (partial preset for Mod)
    let (preset_bytes, p_rep) = canonical_to_sav_bytes(&doc, NativeExportMode::StationPreset).unwrap();
    assert_eq!(p_rep.connector_count, 0);
    let (prt, _) = sav_bytes_to_canonical(&preset_bytes).unwrap();
    assert_eq!(prt.modules.len(), 5);
    assert_eq!(prt.buildings.len(), 8);
}
