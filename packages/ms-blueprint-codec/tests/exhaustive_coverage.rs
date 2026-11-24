use ms_blueprint_codec::canonical::*;
use ms_blueprint_codec::catalog_map::*;
use ms_blueprint_codec::{canonical_to_sav_bytes, sav_bytes_to_canonical, NativeExportMode};
use serde_json::Map;
use std::collections::{BTreeMap, HashMap};

/// Deterministic 100% coverage gate:
/// - Every single Station Module in Build 26639889 catalog (27/27) across all 4 rotations (108 placements)
/// - Every single Interior Buildable in Build 26639889 catalog (36/36) across all 4 rotations (144 placements)
/// - Every single Recipe (83/83) & Item (81/81) native-name bijectivity
/// - Lossless 2-hop GVAS .sav <-> Canonical round-trip with ZERO warnings!
#[test]
fn exhaustive_100_percent_module_buildable_recipe_item_coverage() {
    let cat = catalog();
    assert_eq!(cat.modules_by_id.len(), 27, "expected all 27 Build 26639889 station modules");
    assert_eq!(cat.buildables_by_id.len(), 36, "expected all 36 Build 26639889 buildables");

    // 1. 100% Recipe & Item bijectivity + audited typo overrides
    assert_eq!(recipe_canonical_to_native("REC_MageticCoils"), "magneticcoils");
    assert_eq!(recipe_native_to_canonical("magneticcoils"), "REC_MageticCoils");
    assert_eq!(recipe_canonical_to_native("REC_ReinforcedPlates"), "reinforcedplate");
    assert_eq!(recipe_native_to_canonical("reinforcedplate"), "REC_ReinforcedPlates");
    assert_eq!(recipe_canonical_to_native("REC_ReinforcedPlatesAlt"), "reinforcedplatealt");
    assert_eq!(recipe_native_to_canonical("reinforcedplatealt"), "REC_ReinforcedPlatesAlt");
    assert_eq!(item_canonical_to_native("ITEM_ReinforcedPlates"), "reinforcedplate");
    assert_eq!(item_native_to_canonical("reinforcedplate"), "ITEM_ReinforcedPlates");

    for canon_rec in cat.recipe_canonical_to_native.keys() {
        let nat = recipe_canonical_to_native(canon_rec);
        assert!(!nat.is_empty(), "empty native name for recipe {canon_rec}");
        let back = recipe_native_to_canonical(&nat);
        assert_eq!(&back, canon_rec, "recipe bijectivity broken: {canon_rec} -> {nat} -> {back}");
    }
    for canon_item in cat.item_canonical_to_native.keys() {
        let nat = item_canonical_to_native(canon_item);
        assert!(!nat.is_empty(), "empty native name for item {canon_item}");
        let back = item_native_to_canonical(&nat);
        assert_eq!(&back, canon_item, "item bijectivity broken: {canon_item} -> {nat} -> {back}");
    }

    // 2. Build exhaustive BlueprintDocument with ALL 27 modules x 4 rotations + ALL 36 buildables x 4 rotations!
    let mut mod_ids: Vec<String> = cat.modules_by_id.keys().cloned().collect();
    mod_ids.sort();
    let mut modules = Vec::new();
    for (mi, mtype) in mod_ids.iter().enumerate() {
        for rot in 0u8..4u8 {
            let floor = if mtype == "BPO_StationArmour_01B" { -1 } else { 0 };
            let gx = (mi as i32) * 5;
            let gy = (rot as i32) * 5;
            modules.push(PlacedModule {
                id: format!("cov_m_{mi}_{rot}"),
                module_type: mtype.clone(),
                gx,
                gy,
                floor,
                rotation: rot,
                label: if mtype == "BPO_ElevatorBlock_03" || mtype == "BPO_ElevatorBlock_02A" {
                    Some(format!("电梯R{rot}"))
                } else {
                    None
                },
                recipe_id: if mtype == "BPO_DeepSpaceObservatory" {
                    Some(if rot % 2 == 0 {
                        "REC_StrangeWarpFuel".to_owned()
                    } else {
                        "REC_ObservedStellarSurveyData".to_owned()
                    })
                } else {
                    None
                },
                dock_ports: if mtype == "BPO_Dock" {
                    Some(vec![
                        DockPortConfig { port_index: 0, item_id: "ITEM_TitaniumPlates".to_owned(), mode: "unload".to_owned() },
                        DockPortConfig { port_index: 1, item_id: "ITEM_ReinforcedPlates".to_owned(), mode: "load".to_owned() },
                    ])
                } else if mtype == "BPO_Dock_2" {
                    Some(vec![
                        DockPortConfig { port_index: 0, item_id: "ITEM_StrangeMatterCrystal".to_owned(), mode: "unload".to_owned() },
                        DockPortConfig { port_index: 3, item_id: "ITEM_BackpackMk3".to_owned(), mode: "load".to_owned() },
                        DockPortConfig { port_index: 7, item_id: "ITEM_AlphaProtein".to_owned(), mode: "unload".to_owned() },
                    ])
                } else {
                    None
                },
                palette_id: if rot == 1 { Some(1) } else { None },
                mining_item: if mtype.starts_with("BPO_MiningDroneBay") {
                    Some(if rot % 2 == 0 {
                        "ITEM_WaterIce".to_owned()
                    } else {
                        "ITEM_TitaniumOre".to_owned()
                    })
                } else {
                    None
                },
                dock_name: if mtype.starts_with("BPO_Dock") || mtype.starts_with("BPO_ShipyardCore") {
                    Some(format!("泊位{rot}"))
                } else {
                    None
                },
                native_meta: None,
            });
        }
    }

    let mut bld_ids: Vec<String> = cat.buildables_by_id.keys().cloned().collect();
    bld_ids.sort();
    let mut buildings = Vec::new();
    let sample_recipes = [
        "REC_TitaniumPlates",
        "REC_MageticCoils",
        "REC_ReinforcedPlates",
        "REC_MagneticCoilsAlt1",
    ];
    for (bi, btype) in bld_ids.iter().enumerate() {
        let kind = machine_config_kind(btype);
        for rot in 0u8..4u8 {
            let x = (bi as i32) * 14;
            let y = (rot as i32) * 14;
            let floor = if rot % 2 == 0 { 0 } else { 1 };
            if kind == MachineConfigKind::Underground {
                let (dx, dy) = match rot {
                    0 => (1, 0),
                    1 => (0, 1),
                    2 => (-1, 0),
                    _ => (0, -1),
                };
                let dist = match btype.as_str() {
                    "DAT_UndergroundBelt" => 5 + (rot as i32),    // up to maxLength 8
                    "DAT_UndergroundBelt_2" => 7 + (rot as i32),  // up to maxLength 10
                    "DAT_UndergroundBelt_3" => 9 + (rot as i32),  // up to maxLength 12
                    _ => 2 + (rot as i32),
                };
                let id_in = format!("cov_b_{bi}_{rot}_in");
                let id_out = format!("cov_b_{bi}_{rot}_out");
                buildings.push(PlacedBuilding {
                    id: id_in.clone(),
                    building_type: btype.clone(),
                    x,
                    y,
                    floor,
                    rotation: rot,
                    recipe_id: None,
                    label: None,
                    disabled_ports: None,
                    underground_mode: Some("in".to_owned()),
                    underground_partner_id: Some(id_out.clone()),
                    priority_in: None,
                    priority_out: None,
                    port_filters: None,
                    filter_items: None,
                    palette_id: if rot == 2 { Some(1) } else { None },
                    native_meta: None,
                });
                buildings.push(PlacedBuilding {
                    id: id_out,
                    building_type: btype.clone(),
                    x: x + dx * dist,
                    y: y + dy * dist,
                    floor,
                    rotation: rot,
                    recipe_id: None,
                    label: None,
                    disabled_ports: None,
                    underground_mode: Some("out".to_owned()),
                    underground_partner_id: Some(id_in),
                    priority_in: None,
                    priority_out: None,
                    port_filters: None,
                    filter_items: None,
                    palette_id: if rot == 2 { Some(1) } else { None },
                    native_meta: None,
                });
                continue;
            }

            let mut pf = BTreeMap::new();
            let (recipe_id, disabled_ports, priority_in, priority_out, port_filters, filter_items, label) =
                match kind {
                    MachineConfigKind::Assembler => (
                        Some(sample_recipes[rot as usize].to_owned()),
                        Some(vec![1]),
                        None,
                        None,
                        None,
                        None,
                        None,
                    ),
                    MachineConfigKind::Container => (
                        None,
                        Some(vec![0, 3]),
                        None,
                        None,
                        None,
                        Some(vec!["ITEM_ReinforcedPlates".to_owned(), "ITEM_AlphaProtein".to_owned()]),
                        None,
                    ),
                    MachineConfigKind::Splitter => {
                        pf.insert("1".to_owned(), "ITEM_ReinforcedPlates".to_owned());
                        pf.insert("3".to_owned(), "ITEM_BackpackMk2".to_owned());
                        (None, Some(vec![2]), None, Some(1 + (rot as i32 % 3)), Some(pf), None, None)
                    }
                    MachineConfigKind::Balancer => {
                        pf.insert("2".to_owned(), "ITEM_WaterIce".to_owned());
                        pf.insert("3".to_owned(), "ITEM_AlphaProtein".to_owned());
                        (None, None, Some((rot % 2) as i32), Some(2 + (rot % 2) as i32), Some(pf), None, None)
                    }
                    MachineConfigKind::Teleporter => (
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        Some(format!("传送站{rot}")),
                    ),
                    _ => (None, None, None, None, None, None, None),
                };

            buildings.push(PlacedBuilding {
                id: format!("cov_b_{bi}_{rot}"),
                building_type: btype.clone(),
                x,
                y,
                floor,
                rotation: rot,
                recipe_id,
                label,
                disabled_ports,
                underground_mode: None,
                underground_partner_id: None,
                priority_in,
                priority_out,
                port_filters,
                filter_items,
                palette_id: if rot == 2 { Some(1) } else { None },
                native_meta: None,
            });
        }
    }

    let doc = BlueprintDocument {
        format: CANONICAL_FORMAT.to_owned(),
        format_version: CANONICAL_FORMAT_VERSION,
        id: "bp_exhaustive_coverage".to_owned(),
        name: "全量27模块36建筑确定性互转验证矩阵".to_owned(),
        description: None,
        game_data: GameDataMeta {
            build_id: GAME_BUILD_ID.to_owned(),
            catalog_version: CATALOG_VERSION,
        },
        modules,
        buildings,
        native_meta: None,
        extra: Map::new(),
    };

    // 3. Round-trip through STATION .sav -> Canonical -> STATION .sav -> Canonical (2-hop!)
    for mode in [NativeExportMode::Station, NativeExportMode::StationPreset] {
        let (sav1, rep1) = canonical_to_sav_bytes(&doc, mode).expect("hop1 export failed");
        assert!(rep1.warnings.is_empty(), "mode={mode:?} export warnings: {:?}", rep1.warnings);

        let (doc1, imp1) = sav_bytes_to_canonical(&sav1).expect("hop1 import failed");
        assert!(imp1.warnings.is_empty(), "mode={mode:?} import warnings: {:?}", imp1.warnings);
        assert_eq!(doc1.modules.len(), doc.modules.len());
        assert_eq!(doc1.buildings.len(), doc.buildings.len());

        // Verify EVERY module preserved exact type, gx, gy, floor, rotation, paletteId, miningItem, dockName, dockPorts, recipeId, label!
        for (orig, rt) in doc.modules.iter().zip(doc1.modules.iter()) {
            assert_eq!(rt.module_type, orig.module_type);
            assert_eq!((rt.gx, rt.gy, rt.floor, rt.rotation), (orig.gx, orig.gy, orig.floor, orig.rotation), "module transform mismatch for {}", orig.module_type);
            assert_eq!(rt.palette_id, orig.palette_id);
            assert_eq!(rt.mining_item, orig.mining_item);
            assert_eq!(rt.dock_name, orig.dock_name);
            assert_eq!(rt.dock_ports, orig.dock_ports, "dock_ports mismatch for {}", orig.module_type);
            assert_eq!(rt.recipe_id, orig.recipe_id, "recipe_id mismatch for {}", orig.module_type);
            assert_eq!(rt.label, orig.label);
            // DefaultMachines synthesized whenever module has template!
            let expected_dm_len = default_machines_for_module(&orig.module_type).len();
            assert_eq!(
                rt.native_meta.as_ref().map(|n| n.default_machines.len()).unwrap_or(0),
                expected_dm_len,
                "DefaultMachines count mismatch for {}",
                orig.module_type
            );
            // Ensure ElevatorFiller never gets corrupted with Elevator label bytes!
            if let Some(nm) = &rt.native_meta {
                for dm in &nm.default_machines {
                    if dm.class_path.contains("ElevatorFiller") {
                        assert!(dm.raw_config.is_empty(), "ElevatorFiller must stay empty on {}", orig.module_type);
                    }
                }
            }
        }

        // Verify EVERY building preserved exact type, x, y, floor, rotation, paletteId, recipe, ports, filters, priorities, label, underground pairing!
        let rt_by_pos: HashMap<(String, i32, i32, i32, u8), &PlacedBuilding> = doc1
            .buildings
            .iter()
            .map(|b| ((b.building_type.clone(), b.x, b.y, b.floor, b.rotation), b))
            .collect();
        for orig in &doc.buildings {
            let key = (orig.building_type.clone(), orig.x, orig.y, orig.floor, orig.rotation);
            let rt = rt_by_pos.get(&key).unwrap_or_else(|| panic!("missing building after round-trip: {key:?}"));
            assert_eq!(rt.palette_id, orig.palette_id, "palette_id mismatch for {}", orig.building_type);
            assert_eq!(rt.recipe_id, orig.recipe_id, "recipe mismatch for {}", orig.building_type);
            assert_eq!(rt.disabled_ports, orig.disabled_ports, "disabled_ports mismatch for {}", orig.building_type);
            assert_eq!(rt.priority_in, orig.priority_in, "priority_in mismatch for {}", orig.building_type);
            assert_eq!(rt.priority_out, orig.priority_out, "priority_out mismatch for {}", orig.building_type);
            assert_eq!(rt.port_filters, orig.port_filters, "port_filters mismatch for {}", orig.building_type);
            assert_eq!(rt.filter_items, orig.filter_items, "filter_items mismatch for {}", orig.building_type);
            assert_eq!(rt.label, orig.label, "label mismatch for {}", orig.building_type);
            assert_eq!(rt.underground_mode, orig.underground_mode, "ug mode mismatch for {}", orig.building_type);
            if orig.underground_mode.as_deref() == Some("in") {
                assert!(rt.underground_partner_id.is_some(), "missing ug partner on {}", orig.building_type);
            }
        }

        // Hop 2 stability: doc1 -> sav2 -> doc2 must be 100% identical!
        let (sav2, rep2) = canonical_to_sav_bytes(&doc1, mode).expect("hop2 export failed");
        assert!(rep2.warnings.is_empty());
        let (doc2, imp2) = sav_bytes_to_canonical(&sav2).expect("hop2 import failed");
        assert!(imp2.warnings.is_empty());
        assert_eq!(serde_json::to_value(&doc1.modules).unwrap(), serde_json::to_value(&doc2.modules).unwrap());
        assert_eq!(serde_json::to_value(&doc1.buildings).unwrap(), serde_json::to_value(&doc2.buildings).unwrap());
    }
}
