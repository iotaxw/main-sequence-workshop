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

    // Observed BPO_StationBlockDock_C from real Build 26639889 DesignSaveGame:
    // UTF-16 "空间站对接口" + 2 empty FDockFilter slots (FString "" + u32 bLoading=0)
    let dock_bytes: Vec<u8> = vec![
        1, 0, 249, 255, 255, 255, 122, 122, 244, 149, 217, 122, 249, 91, 165, 99, 227, 83, 0, 0,
        2, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
    ];
    let ddec = decode_dock_config(&dock_bytes).unwrap();
    assert_eq!(ddec.display_name, "空间站对接口");
    assert_eq!(ddec.filters.len(), 2);
    assert!(ddec.filters.iter().all(|f| f.item_native.is_empty() && !f.b_loading));
    assert_eq!(encode_dock_config(&ddec), dock_bytes);
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
                recipe_id: None,
                dock_ports: None,
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
                recipe_id: None,
                dock_ports: None,
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
                recipe_id: None,
                dock_ports: None,
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
                recipe_id: None,
                dock_ports: None,
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
                recipe_id: None,
                dock_ports: Some(vec![
                    DockPortConfig {
                        port_index: 0,
                        item_id: "ITEM_TitaniumPlates".to_owned(),
                        mode: "unload".to_owned(),
                    },
                    DockPortConfig {
                        port_index: 1,
                        item_id: "ITEM_ReinforcedPlates".to_owned(),
                        mode: "load".to_owned(),
                    },
                ]),
                palette_id: None,
                mining_item: None,
                dock_name: Some("货运停泊口".to_owned()),
                native_meta: None,
            },
            PlacedModule {
                id: "m6".to_owned(),
                module_type: "BPO_Dock_2".to_owned(),
                gx: -4,
                gy: 0,
                floor: 0,
                rotation: 2,
                label: None,
                recipe_id: None,
                dock_ports: Some(vec![
                    DockPortConfig {
                        port_index: 0,
                        item_id: "ITEM_StrangeMatterCrystal".to_owned(),
                        mode: "unload".to_owned(),
                    },
                    DockPortConfig {
                        port_index: 7,
                        item_id: "ITEM_AlphaProtein".to_owned(),
                        mode: "load".to_owned(),
                    },
                ]),
                palette_id: Some(2),
                mining_item: None,
                dock_name: Some("工业港口A".to_owned()),
                native_meta: None,
            },
            PlacedModule {
                id: "m7".to_owned(),
                module_type: "BPO_DeepSpaceObservatory".to_owned(),
                gx: 2,
                gy: 0,
                floor: 0,
                rotation: 0,
                label: None,
                recipe_id: Some("REC_StrangeWarpFuel".to_owned()),
                dock_ports: None,
                palette_id: Some(1),
                mining_item: None,
                dock_name: None,
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
    assert_eq!(rt.modules.len(), 7);
    assert_eq!(rt.buildings.len(), 8);

    // Verify Armour_01B floor round-trip
    let armour = rt.modules.iter().find(|m| m.module_type == "BPO_StationArmour_01B").unwrap();
    assert_eq!((armour.gx, armour.gy, armour.floor), (0, 0, -1));

    // Verify MiningDroneBay & Dock & Dock_2 & DeepSpaceObservatory & Elevator config round-trip
    let mine = rt.modules.iter().find(|m| m.module_type == "BPO_MiningDroneBayBlock_2").unwrap();
    assert_eq!(mine.mining_item.as_deref(), Some("ITEM_WaterIce"));
    assert_eq!(mine.palette_id, Some(1));
    let dock = rt.modules.iter().find(|m| m.module_type == "BPO_Dock").unwrap();
    assert_eq!(dock.dock_name.as_deref(), Some("货运停泊口"));
    assert_eq!(dock.dock_ports.as_ref().map(|v| v.len()), Some(2));
    assert_eq!(dock.dock_ports.as_ref().unwrap()[0].mode, "unload");
    assert_eq!(dock.dock_ports.as_ref().unwrap()[1].mode, "load");
    assert_eq!(dock.dock_ports.as_ref().unwrap()[1].item_id, "ITEM_ReinforcedPlates");
    let dock2 = rt.modules.iter().find(|m| m.module_type == "BPO_Dock_2").unwrap();
    assert_eq!(dock2.dock_name.as_deref(), Some("工业港口A"));
    assert_eq!(dock2.palette_id, Some(2));
    assert_eq!(dock2.dock_ports.as_ref().map(|v| v.len()), Some(2));
    assert_eq!(dock2.dock_ports.as_ref().unwrap()[1].port_index, 7);
    assert_eq!(dock2.dock_ports.as_ref().unwrap()[1].item_id, "ITEM_AlphaProtein");
    let obs = rt.modules.iter().find(|m| m.module_type == "BPO_DeepSpaceObservatory").unwrap();
    assert_eq!(obs.recipe_id.as_deref(), Some("REC_StrangeWarpFuel"));
    assert_eq!(obs.palette_id, Some(1));
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
    assert_eq!(prt.modules.len(), 7);
    assert_eq!(prt.buildings.len(), 8);
}

#[test]
fn stateful_edits_and_clears_after_sav_import_never_leak_stale_native_meta() {
    // Start with a populated blueprint, import it (so every module & building carries nativeMeta),
    // then mutate & clear EVERY stateful attribute and verify re-export -> re-import reflects every edit!
    let doc0 = BlueprintDocument {
        format: CANONICAL_FORMAT.to_owned(),
        format_version: CANONICAL_FORMAT_VERSION,
        id: "bp_edit_after_import".to_owned(),
        name: "导入后再编辑属性稳定性测试".to_owned(),
        description: None,
        game_data: GameDataMeta {
            build_id: GAME_BUILD_ID.to_owned(),
            catalog_version: CATALOG_VERSION,
        },
        modules: vec![
            PlacedModule {
                id: "m_dock2".to_owned(),
                module_type: "BPO_Dock_2".to_owned(),
                gx: 0,
                gy: 0,
                floor: 0,
                rotation: 0,
                label: None,
                recipe_id: None,
                dock_ports: Some(vec![
                    DockPortConfig { port_index: 0, item_id: "ITEM_WaterIce".to_owned(), mode: "unload".to_owned() },
                    DockPortConfig { port_index: 7, item_id: "ITEM_HullPlates".to_owned(), mode: "load".to_owned() },
                ]),
                palette_id: Some(1),
                mining_item: None,
                dock_name: Some("旧港口".to_owned()),
                native_meta: None,
            },
            PlacedModule {
                id: "m_obs".to_owned(),
                module_type: "BPO_DeepSpaceObservatory".to_owned(),
                gx: 4,
                gy: 0,
                floor: 0,
                rotation: 1,
                label: None,
                recipe_id: Some("REC_StrangeWarpFuel".to_owned()),
                dock_ports: None,
                palette_id: None,
                mining_item: None,
                dock_name: None,
                native_meta: None,
            },
            PlacedModule {
                id: "m_elev2".to_owned(),
                module_type: "BPO_ElevatorBlock_02A".to_owned(),
                gx: 8,
                gy: 0,
                floor: 0,
                rotation: 2,
                label: Some("旧双格电梯".to_owned()),
                recipe_id: None,
                dock_ports: None,
                palette_id: None,
                mining_item: None,
                dock_name: None,
                native_meta: None,
            },
            PlacedModule {
                id: "m_mine".to_owned(),
                module_type: "BPO_MiningDroneBayBlock".to_owned(),
                gx: 12,
                gy: 0,
                floor: 0,
                rotation: 3,
                label: None,
                recipe_id: None,
                dock_ports: None,
                palette_id: None,
                mining_item: Some("ITEM_WaterIce".to_owned()),
                dock_name: None,
                native_meta: None,
            },
        ],
        buildings: vec![
            PlacedBuilding {
                id: "b_cnt".to_owned(),
                building_type: "DAT_Container".to_owned(),
                x: 10,
                y: 10,
                floor: 0,
                rotation: 0,
                recipe_id: None,
                label: None,
                disabled_ports: Some(vec![0, 2]),
                underground_mode: None,
                underground_partner_id: None,
                priority_in: None,
                priority_out: None,
                port_filters: None,
                filter_items: Some(vec!["ITEM_WaterIce".to_owned(), "ITEM_HullPlates".to_owned()]),
                palette_id: Some(1),
                native_meta: Some(BuildingNativeMeta {
                    b_creative: Some(true),
                    creative_item: Some("ITEM_StrangeMatterCrystal".to_owned()),
                    b_creative_consume: Some(true),
                    logistic_filters: vec![
                        LogisticFilterEntry { item_id: "ITEM_WaterIce".to_owned(), amount: 500, action: 1 },
                        LogisticFilterEntry { item_id: "ITEM_HullPlates".to_owned(), amount: 250, action: 2 },
                    ],
                    ..Default::default()
                }),
            },
        ],
        native_meta: None,
        extra: Map::new(),
    };

    // Hop 1: export & import so nativeMeta is populated
    let (sav1, rep1) = canonical_to_sav_bytes(&doc0, NativeExportMode::Station).unwrap();
    assert!(rep1.warnings.is_empty());
    let (mut doc1, imp1) = sav_bytes_to_canonical(&sav1).unwrap();
    assert!(imp1.warnings.is_empty());

    // Verify BPO_ElevatorBlock_02A did NOT corrupt BPO_ElevatorFiller_C raw_config!
    let elev2 = doc1.modules.iter().find(|m| m.module_type == "BPO_ElevatorBlock_02A").unwrap();
    assert_eq!(elev2.label.as_deref(), Some("旧双格电梯"));
    for dm in &elev2.native_meta.as_ref().unwrap().default_machines {
        if dm.class_path.contains("ElevatorFiller") {
            assert!(dm.raw_config.is_empty(), "ElevatorFiller must keep empty config, got {:?}", dm.raw_config);
        }
    }

    // Verify Container creative & logistic_filters amount/action survived Hop 1!
    let cnt1 = doc1.buildings.iter().find(|b| b.building_type == "DAT_Container").unwrap();
    let cnt1_nm = cnt1.native_meta.as_ref().unwrap();
    assert_eq!(cnt1_nm.b_creative, Some(true));
    assert_eq!(cnt1_nm.creative_item.as_deref(), Some("ITEM_StrangeMatterCrystal"));
    assert_eq!(cnt1_nm.b_creative_consume, Some(true));
    assert_eq!(cnt1_nm.logistic_filters.len(), 2);
    assert_eq!(cnt1_nm.logistic_filters[0].amount, 500);
    assert_eq!(cnt1_nm.logistic_filters[0].action, 1);

    // Now MUTATE & CLEAR attributes directly on doc1 (simulating user editing an imported .sav in designer!)
    for m in &mut doc1.modules {
        match m.module_type.as_str() {
            "BPO_Dock_2" => {
                m.dock_name = Some("新工业主港".to_owned());
                m.dock_ports = Some(vec![
                    DockPortConfig { port_index: 3, item_id: "ITEM_ReinforcedPlates".to_owned(), mode: "load".to_owned() },
                ]);
            }
            "BPO_DeepSpaceObservatory" => {
                m.recipe_id = Some("REC_ObservedStellarSurveyData".to_owned());
            }
            "BPO_ElevatorBlock_02A" => {
                m.label = None; // Clear label!
            }
            "BPO_MiningDroneBayBlock" => {
                m.mining_item = None; // Clear mining item!
            }
            _ => {}
        }
    }
    for b in &mut doc1.buildings {
        if b.building_type == "DAT_Container" {
            // Keep ITEM_WaterIce (should preserve amount=500, action=1), drop HullPlates, add TitaniumPlates!
            b.filter_items = Some(vec!["ITEM_WaterIce".to_owned(), "ITEM_TitaniumPlates".to_owned()]);
        }
    }

    // Hop 2: re-export & re-import
    let (sav2, rep2) = canonical_to_sav_bytes(&doc1, NativeExportMode::Station).unwrap();
    assert!(rep2.warnings.is_empty());
    let (doc2, imp2) = sav_bytes_to_canonical(&sav2).unwrap();
    assert!(imp2.warnings.is_empty());

    let d2 = doc2.modules.iter().find(|m| m.module_type == "BPO_Dock_2").unwrap();
    assert_eq!(d2.dock_name.as_deref(), Some("新工业主港"));
    assert_eq!(
        d2.dock_ports,
        Some(vec![DockPortConfig { port_index: 3, item_id: "ITEM_ReinforcedPlates".to_owned(), mode: "load".to_owned() }])
    );
    let o2 = doc2.modules.iter().find(|m| m.module_type == "BPO_DeepSpaceObservatory").unwrap();
    assert_eq!(o2.recipe_id.as_deref(), Some("REC_ObservedStellarSurveyData"));
    let e2 = doc2.modules.iter().find(|m| m.module_type == "BPO_ElevatorBlock_02A").unwrap();
    assert_eq!(e2.label, None, "clearing elevator label must clear native config");
    let mn2 = doc2.modules.iter().find(|m| m.module_type == "BPO_MiningDroneBayBlock").unwrap();
    assert_eq!(mn2.mining_item, None, "clearing miningItem must clear native config");

    let c2 = doc2.buildings.iter().find(|b| b.building_type == "DAT_Container").unwrap();
    assert_eq!(c2.filter_items, Some(vec!["ITEM_WaterIce".to_owned(), "ITEM_TitaniumPlates".to_owned()]));
    let c2_lf = &c2.native_meta.as_ref().unwrap().logistic_filters;
    assert_eq!(c2_lf.len(), 2);
    assert_eq!((c2_lf[0].item_id.as_str(), c2_lf[0].amount, c2_lf[0].action), ("ITEM_WaterIce", 500, 1));
    assert_eq!((c2_lf[1].item_id.as_str(), c2_lf[1].amount, c2_lf[1].action), ("ITEM_TitaniumPlates", 0, 0));
}

#[test]
fn class_level_block_bounds_pivot_aligns_asymmetric_and_ceiling_modules() {
    use ms_blueprint_codec::connectors::{module_to_native_transform, synthesize_connectors};

    let dock = PlacedModule {
        id: "dock".to_owned(),
        module_type: "BPO_Dock_2".to_owned(),
        gx: -6,
        gy: -4,
        floor: 0,
        rotation: 2,
        label: None,
        recipe_id: None,
        dock_ports: None,
        palette_id: None,
        mining_item: None,
        dock_name: None,
        native_meta: None,
    };
    let adapter = PlacedModule {
        id: "adapter".to_owned(),
        module_type: "BPO_StationAdapter_01".to_owned(),
        gx: -3,
        gy: -4,
        floor: 0,
        rotation: 2,
        label: None,
        recipe_id: None,
        dock_ports: None,
        palette_id: None,
        mining_item: None,
        dock_name: None,
        native_meta: None,
    };
    // BPO_Dock_2 has blockBoundsM.minX=-16, sizeUnits=[3,2,1] -> ox=+8m -> dux=-2 (rot=2 -> +2 -> bx=-18, by=-14)
    assert_eq!(module_to_native_transform(&dock), (-18, -14, 0, 2));
    assert_eq!(module_to_native_transform(&adapter), (-12, -14, 0, 2));
    // Shared seam between Dock_2 East face (-14,-16/-12) and Adapter West face (-14,-16/-12) must pair flush (0 caps on x=-14)!
    let caps = synthesize_connectors(&[dock.clone(), adapter.clone()]);
    let seam_caps = caps
        .iter()
        .filter(|v| v["Transform_0"]["GridLocation_0"]["x"].as_i64() == Some(-14))
        .count();
    assert_eq!(seam_caps, 0, "BPO_Dock_2 and BPO_StationAdapter_01 must share flush Large connectors at x=-14");

    // BPO_ShipyardCore_02 has the exact same class-level asymmetry (blockBoundsM.minX=-8, sizeUnits=[2,2,1] -> ox=+8m -> dux=-2)
    let ship2 = PlacedModule {
        id: "ship2".to_owned(),
        module_type: "BPO_ShipyardCore_02".to_owned(),
        gx: 0,
        gy: 0,
        floor: 0,
        rotation: 0,
        label: None,
        recipe_id: None,
        dock_ports: None,
        palette_id: None,
        mining_item: None,
        dock_name: None,
        native_meta: None,
    };
    assert_eq!(module_to_native_transform(&ship2), (0, 2, 0, 0));

    // Ceiling-hung BPO_StationArmour_01B (maxZ=0, minZ=-4) derives z_shift=+2 directly from blockBoundsM
    let armour = PlacedModule {
        id: "arm".to_owned(),
        module_type: "BPO_StationArmour_01B".to_owned(),
        gx: 0,
        gy: 0,
        floor: -1,
        rotation: 0,
        label: None,
        recipe_id: None,
        dock_ports: None,
        palette_id: None,
        mining_item: None,
        dock_name: None,
        native_meta: None,
    };
    assert_eq!(module_to_native_transform(&armour), (0, 0, 0, 0));

    // Verify lossless round-trip for all 3 classes!
    let doc = BlueprintDocument {
        format: CANONICAL_FORMAT.to_owned(),
        format_version: CANONICAL_FORMAT_VERSION,
        id: "bp_class_pivots".to_owned(),
        name: "类级锚点往返测试".to_owned(),
        description: None,
        game_data: GameDataMeta {
            build_id: GAME_BUILD_ID.to_owned(),
            catalog_version: CATALOG_VERSION,
        },
        modules: vec![dock, adapter, ship2, armour],
        buildings: vec![],
        native_meta: None,
        extra: Map::new(),
    };
    let (sav, rep) = canonical_to_sav_bytes(&doc, NativeExportMode::Station).unwrap();
    assert!(rep.warnings.is_empty());
    let (rt, imp) = sav_bytes_to_canonical(&sav).unwrap();
    assert!(imp.warnings.is_empty());
    for (orig, back) in doc.modules.iter().zip(rt.modules.iter()) {
        assert_eq!((orig.module_type.as_str(), orig.gx, orig.gy, orig.floor, orig.rotation),
                   (back.module_type.as_str(), back.gx, back.gy, back.floor, back.rotation));
    }
}
