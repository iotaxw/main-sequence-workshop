use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Cursor;
use uesave::{Save, SaveReader};

use crate::canonical::*;
use crate::catalog_map::*;
use crate::config_codec::*;
use crate::connectors::*;
use crate::gvas_template::*;

fn rot_delta(rot: u8) -> (i32, i32) {
    match rot % 4 {
        0 => (1, 0),
        1 => (0, 1),
        2 => (-1, 0),
        _ => (0, -1),
    }
}

fn buildable_rotated_size(building_type: &str, rot: u8) -> (i32, i32) {
    let (w, d) = catalog()
        .buildables_by_id
        .get(building_type)
        .map(|b| (b.size[0], b.size[1]))
        .unwrap_or((1, 1));
    if rot % 2 == 1 {
        (d, w)
    } else {
        (w, d)
    }
}

fn read_byte_array(v: Option<&Value>) -> Vec<u8> {
    let Some(v) = v else { return Vec::new() };
    let arr = v
        .get("Byte")
        .and_then(Value::as_array)
        .or_else(|| v.as_array());
    let Some(arr) = arr else { return Vec::new() };
    arr.iter()
        .filter_map(|n| n.as_u64().map(|x| x as u8))
        .collect()
}

fn read_transform(v: &Value) -> (i32, i32, i32, u8) {
    let x = v
        .pointer("/GridLocation_0/x")
        .and_then(Value::as_i64)
        .unwrap_or(0) as i32;
    let y = v
        .pointer("/GridLocation_0/y")
        .and_then(Value::as_i64)
        .unwrap_or(0) as i32;
    let h = v.get("Height_0").and_then(Value::as_i64).unwrap_or(0) as i32;
    let r = (v
        .get("GridRotation_0")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .rem_euclid(4)) as u8;
    (x, y, h, r)
}

fn read_display_name(bp: &Value) -> String {
    if let Some(s) = bp
        .pointer("/DisplayName_0/variant/None/culture_invariant")
        .and_then(Value::as_str)
    {
        if !s.trim().is_empty() {
            return s.trim().to_owned();
        }
    }
    if let Some(s) = bp
        .pointer("/DisplayName_0/variant/Base/source_string")
        .and_then(Value::as_str)
    {
        if !s.trim().is_empty() {
            return s.trim().to_owned();
        }
    }
    "导入空间站蓝图".to_owned()
}

pub fn sav_bytes_to_canonical(sav_bytes: &[u8]) -> Result<(BlueprintDocument, ConversionReport)> {
    let save = SaveReader::new()
        .error_to_raw(true)
        .read(Cursor::new(sav_bytes))
        .context("failed to parse UE 5.7 GVAS .sav file")?;
    let val = serde_json::to_value(&save).context("failed to convert GVAS Save to JSON")?;

    let save_type = val
        .pointer("/root/save_game_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    if save_type != "/Script/MainSequence.DesignSaveGame" {
        bail!("unsupported SaveGame type: '{save_type}' (expected /Script/MainSequence.DesignSaveGame)");
    }

    let bp = val
        .pointer("/root/properties/Blueprint_0")
        .context("DesignSaveGame missing Blueprint_0 property")?;

    let frame_type = bp.get("Type_0").and_then(Value::as_str).map(ToOwned::to_owned);
    let version = bp.get("Version_0").and_then(Value::as_i64);
    let name = read_display_name(bp);
    let mut warnings = Vec::new();

    // 1. Decode station modules (Blocks_0)
    let mut modules = Vec::new();
    let raw_blocks = bp
        .get("Blocks_0")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for (idx, blk) in raw_blocks.iter().enumerate() {
        let class_path = blk.get("Class_0").and_then(Value::as_str).unwrap_or("");
        let short = extract_class_short_name(class_path);
        let module_type = catalog()
            .module_id_by_class_name
            .get(short)
            .cloned()
            .unwrap_or_else(|| {
                let fallback = short.strip_suffix("_C").unwrap_or(short).to_owned();
                warnings.push(format!("未知空间站模块类 `{short}`，已按原名 `{fallback}` 保留。"));
                fallback
            });

        let tf = blk.get("Transform_0").unwrap_or(&Value::Null);
        let (bx, by, bh, rot) = read_transform(tf);
        let (wu, du) = module_rotated_size(&module_type, rot);
        let (dux, duy, z_shift) = module_native_pivot_offset(&module_type);
        let (rx, ry) = rotate_xy(dux, duy, rot);
        let gx_num = bx - rx - 2 * wu + 2;
        let gy_num = by - ry - 2 * du + 2;
        if gx_num.rem_euclid(4) != 0 || gy_num.rem_euclid(4) != 0 {
            warnings.push(format!(
                "模块 `{module_type}` 原生坐标 ({bx},{by}) 非标准 16m 对齐，已向下取整。"
            ));
        }
        let gx = gx_num.div_euclid(4);
        let gy = gy_num.div_euclid(4);
        let floor = (bh - z_shift).div_euclid(2);

        let block_id = blk.get("BlockID_0").and_then(Value::as_i64).map(|x| x as i32);
        let palette_id = blk.get("PaletteID_0").and_then(Value::as_i64).map(|x| x as i32);

        // Extract DefaultMachines & promote useful gameplay config (miningItem / dockName / dockPorts / recipeId / elevator label)
        let mut mining_item = None;
        let mut dock_name = None;
        let mut dock_ports: Option<Vec<DockPortConfig>> = None;
        let mut recipe_id = None;
        let mut label = None;
        let mut default_machines = Vec::new();

        if let Some(dms) = blk.get("DefaultMachines_0").and_then(Value::as_array) {
            let blk_half_x = bx * 8;
            let blk_half_y = by * 8;
            let blk_half_h = bh * 8;
            for dm in dms {
                let dm_cls = dm.get("Class_0").and_then(Value::as_str).unwrap_or("").to_owned();
                let (dmx, dmy, dmh, dmrot) = read_transform(dm.get("Transform_0").unwrap_or(&Value::Null));
                // Inverse-rotate world delta back to module-local relative coords
                let inv_rot = (4 - rot) % 4;
                let (rel_x, rel_y) = rotate_xy(dmx - blk_half_x, dmy - blk_half_y, inv_rot);
                let rel_height = dmh - blk_half_h;
                let rel_rotation = ((dmrot as i32 - rot as i32).rem_euclid(4)) as i32;
                let raw_cfg = read_byte_array(dm.get("SerializedMachineConfig_0"));

                if dm_cls.contains("MiningDroneBay") {
                    if let Ok(item_nat) = decode_mining_drone_bay_item(&raw_cfg) {
                        if !item_nat.is_empty() {
                            mining_item = Some(item_native_to_canonical(&item_nat));
                        }
                    }
                } else if dm_cls.contains("Dock") {
                    if let Ok(cfg) = decode_dock_config(&raw_cfg) {
                        if !cfg.display_name.is_empty() {
                            dock_name = Some(cfg.display_name);
                        }
                        let mut ports = Vec::new();
                        for (slot, f) in cfg.filters.iter().enumerate() {
                            if !f.item_native.is_empty() {
                                ports.push(DockPortConfig {
                                    port_index: slot as i32,
                                    item_id: item_native_to_canonical(&f.item_native),
                                    mode: if f.b_loading {
                                        "load".to_owned()
                                    } else {
                                        "unload".to_owned()
                                    },
                                });
                            }
                        }
                        if !ports.is_empty() {
                            dock_ports = Some(ports);
                        }
                    }
                } else if dm_cls.contains("Elevator") && !dm_cls.contains("ElevatorFiller") {
                    if label.is_none() {
                        if let Ok(Some(el)) = decode_elevator_or_teleporter_label(&raw_cfg) {
                            label = Some(el);
                        }
                    }
                } else if dm_cls.contains("DeepSpaceObservatory") {
                    if let Ok(cfg) = decode_assembler_config(&raw_cfg) {
                        if !cfg.recipe_native.is_empty() {
                            recipe_id = Some(recipe_native_to_canonical(&cfg.recipe_native));
                        }
                    }
                }

                default_machines.push(NativeDefaultMachine {
                    class_path: dm_cls,
                    rel_x,
                    rel_y,
                    rel_height,
                    rel_rotation,
                    machine_id: dm.get("MachineID_0").and_then(Value::as_i64).map(|x| x as i32),
                    palette_id: dm.get("PaletteID_0").and_then(Value::as_i64).map(|x| x as i32),
                    raw_config: raw_cfg,
                });
            }
        }

        let id = match block_id {
            Some(bid) if bid > 0 => format!("mod_{bid}"),
            _ => format!("mod_{idx}"),
        };

        modules.push(PlacedModule {
            id,
            module_type,
            gx,
            gy,
            floor,
            rotation: rot,
            label,
            recipe_id,
            dock_ports,
            palette_id: palette_id.filter(|&p| p != 0),
            mining_item,
            dock_name,
            native_meta: Some(ModuleNativeMeta {
                class_path: Some(class_path.to_owned()),
                block_id,
                default_machines,
            }),
        });
    }

    // 2. Decode interior machines (Machines_0)
    let mut buildings = Vec::new();
    let raw_machines = bp
        .get("Machines_0")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let native_machine_count = raw_machines.len();

    for (idx, mac) in raw_machines.iter().enumerate() {
        let class_path = mac.get("Class_0").and_then(Value::as_str).unwrap_or("");
        let short = extract_class_short_name(class_path);
        let building_type = catalog()
            .buildable_id_by_class_name
            .get(short)
            .cloned()
            .unwrap_or_else(|| {
                let fallback = short.strip_suffix("_C").unwrap_or(short).to_owned();
                warnings.push(format!("未知室内建筑类 `{short}`，已按原名 `{fallback}` 保留。"));
                fallback
            });

        let tf = mac.get("Transform_0").unwrap_or(&Value::Null);
        let (mx, my, mh, rot) = read_transform(tf);
        let (w, d) = buildable_rotated_size(&building_type, rot);
        let x = (mx - w + 16).div_euclid(2);
        let y = (my - d + 16).div_euclid(2);
        let floor = mh.div_euclid(16);

        let machine_id = mac.get("MachineID_0").and_then(Value::as_i64).map(|v| v as i32);
        let palette_id = mac.get("PaletteID_0").and_then(Value::as_i64).map(|v| v as i32);
        let raw_cfg = read_byte_array(mac.get("SerializedMachineConfig_0"));
        let kind = machine_config_kind(&building_type);
        let base_id = match machine_id {
            Some(mid) if mid > 0 => format!("bld_{mid}"),
            _ => format!("bld_{idx}"),
        };

        // Special case: Native UndergroundBelt is 1 object with Length -> expand to canonical (in + out) pair!
        if kind == MachineConfigKind::Underground {
            let length = decode_underground_length(&raw_cfg).unwrap_or_else(|e| {
                warnings.push(format!("地下带 `{base_id}` 配置解析失败 ({e})，已按默认长度 2 展开。"));
                2
            });
            let (dx, dy) = rot_delta(rot);
            let span = (length - 1).max(1);
            let id_in = format!("{base_id}_in");
            let id_out = format!("{base_id}_out");

            buildings.push(PlacedBuilding {
                id: id_in.clone(),
                building_type: building_type.clone(),
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
                palette_id: palette_id.filter(|&p| p != 0),
                native_meta: Some(BuildingNativeMeta {
                    class_path: Some(class_path.to_owned()),
                    machine_id,
                    ..Default::default()
                }),
            });

            buildings.push(PlacedBuilding {
                id: id_out,
                building_type,
                x: x + dx * span,
                y: y + dy * span,
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
                palette_id: palette_id.filter(|&p| p != 0),
                native_meta: None,
            });
            continue;
        }

        let mut recipe_id = None;
        let mut label = None;
        let mut disabled_ports: Option<Vec<i32>> = None;
        let mut priority_in = None;
        let mut priority_out = None;
        let mut port_filters: Option<BTreeMap<String, String>> = None;
        let mut filter_items: Option<Vec<String>> = None;
        let mut b_meta = BuildingNativeMeta {
            class_path: Some(class_path.to_owned()),
            machine_id,
            ..Default::default()
        };

        match kind {
            MachineConfigKind::Assembler => {
                match decode_assembler_config(&raw_cfg) {
                    Ok(cfg) => {
                        if !cfg.recipe_native.is_empty() {
                            recipe_id = Some(recipe_native_to_canonical(&cfg.recipe_native));
                        }
                        let dis: Vec<i32> = cfg
                            .port_states
                            .iter()
                            .enumerate()
                            .filter_map(|(i, &st)| if st == 0 { Some(i as i32) } else { None })
                            .collect();
                        if !dis.is_empty() {
                            disabled_ports = Some(dis);
                        }
                    }
                    Err(e) => {
                        warnings.push(format!("制造机 `{base_id}` 配置解析失败 ({e})，已原样保留原始字节。"));
                        b_meta.raw_config = Some(raw_cfg);
                    }
                }
            }
            MachineConfigKind::Container => {
                match decode_container_config(&raw_cfg, item_native_to_canonical) {
                    Ok(cfg) => {
                        if cfg.b_creative {
                            b_meta.b_creative = Some(true);
                        }
                        if !cfg.creative_item_native.is_empty() {
                            b_meta.creative_item = Some(item_native_to_canonical(&cfg.creative_item_native));
                        }
                        if cfg.b_creative_consume {
                            b_meta.b_creative_consume = Some(true);
                        }
                        if !cfg.logistic_filters.is_empty() {
                            let items: Vec<String> = cfg
                                .logistic_filters
                                .iter()
                                .filter(|f| !f.item_id.is_empty())
                                .map(|f| f.item_id.clone())
                                .collect();
                            if !items.is_empty() {
                                filter_items = Some(items);
                            }
                            b_meta.logistic_filters = cfg.logistic_filters;
                        }
                        let dis: Vec<i32> = cfg
                            .port_states
                            .iter()
                            .enumerate()
                            .filter_map(|(i, &st)| if st == 0 { Some(i as i32) } else { None })
                            .collect();
                        if !dis.is_empty() {
                            disabled_ports = Some(dis);
                        }
                    }
                    Err(e) => {
                        warnings.push(format!("储物箱 `{base_id}` 配置解析失败 ({e})，已保留原始字节。"));
                        b_meta.raw_config = Some(raw_cfg);
                    }
                }
            }
            MachineConfigKind::Splitter | MachineConfigKind::Balancer => {
                let out_offset: i32 = if kind == MachineConfigKind::Balancer { 2 } else { 1 };
                match decode_splitter_config(&raw_cfg) {
                    Ok(cfg) => {
                        if cfg.priority_input_index >= 0 {
                            priority_in = Some(cfg.priority_input_index);
                        }
                        if cfg.priority_output_index >= 0 {
                            priority_out = Some(cfg.priority_output_index + out_offset);
                        }
                        let mut pf = BTreeMap::new();
                        for (i, f_nat) in cfg.filters_native.iter().enumerate() {
                            if !f_nat.is_empty() {
                                pf.insert(
                                    (i as i32 + out_offset).to_string(),
                                    item_native_to_canonical(f_nat),
                                );
                            }
                        }
                        if !pf.is_empty() {
                            port_filters = Some(pf);
                        }
                        let dis: Vec<i32> = cfg
                            .port_states
                            .iter()
                            .enumerate()
                            .filter_map(|(i, &st)| {
                                if st == 0 {
                                    Some(i as i32 + out_offset)
                                } else {
                                    None
                                }
                            })
                            .collect();
                        if !dis.is_empty() {
                            disabled_ports = Some(dis);
                        }
                    }
                    Err(e) => {
                        warnings.push(format!("分流/平衡器 `{base_id}` 配置解析失败 ({e})，已保留原始字节。"));
                        b_meta.raw_config = Some(raw_cfg);
                    }
                }
            }
            MachineConfigKind::Teleporter => {
                if let Ok(lbl) = decode_elevator_or_teleporter_label(&raw_cfg) {
                    label = lbl;
                } else if !raw_cfg.is_empty() {
                    b_meta.raw_config = Some(raw_cfg);
                }
            }
            MachineConfigKind::None => {
                if !raw_cfg.is_empty() {
                    b_meta.raw_config = Some(raw_cfg);
                }
            }
            MachineConfigKind::Underground => unreachable!(),
        }

        buildings.push(PlacedBuilding {
            id: base_id,
            building_type,
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
            palette_id: palette_id.filter(|&p| p != 0),
            native_meta: Some(b_meta),
        });
    }

    let connector_count = bp
        .get("Connectors_0")
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);

    let doc = BlueprintDocument {
        format: CANONICAL_FORMAT.to_owned(),
        format_version: CANONICAL_FORMAT_VERSION,
        id: format!("bp_native_{}", modules.len() * 1000 + buildings.len()),
        name,
        description: Some("从《主星序 Main Sequence》原生 DesignSaveGame (.sav) 导入".to_owned()),
        game_data: GameDataMeta {
            build_id: GAME_BUILD_ID.to_owned(),
            catalog_version: CATALOG_VERSION,
        },
        modules,
        buildings,
        native_meta: Some(NativeDocumentMeta {
            frame_type,
            version,
            colour_palettes: bp.get("ColourPalettes_0").cloned(),
            camera_location: bp.get("CameraLocation_0").cloned(),
            camera_rotation: bp.get("CameraRotation_0").cloned(),
            header: val.get("header").cloned(),
        }),
        extra: Map::new(),
    };

    let report = ConversionReport {
        warnings,
        module_count: doc.modules.len(),
        building_count: doc.buildings.len(),
        native_machine_count,
        connector_count,
    };

    Ok((doc, report))
}

fn encode_default_machine_config(m: &PlacedModule, class_path: &str, fallback_bytes: &[u8]) -> Vec<u8> {
    if class_path.contains("MiningDroneBay") {
        let item_nat = m
            .mining_item
            .as_deref()
            .map(item_canonical_to_native)
            .unwrap_or_default();
        return encode_mining_drone_bay_item(&item_nat);
    }
    if class_path.contains("Dock") {
        let mut slot_count = dock_filter_slot_count(class_path);
        if let Ok(prev) = decode_dock_config(fallback_bytes) {
            slot_count = slot_count.max(prev.filters.len());
        }
        if let Some(ports) = &m.dock_ports {
            for p in ports {
                if p.port_index >= 0 {
                    slot_count = slot_count.max((p.port_index + 1) as usize);
                }
            }
        }
        let mut filters = vec![
            DockFilterEntry {
                item_native: String::new(),
                b_loading: false,
            };
            slot_count
        ];
        if let Some(ports) = &m.dock_ports {
            for p in ports {
                if p.port_index >= 0 && (p.port_index as usize) < filters.len() {
                    filters[p.port_index as usize] = DockFilterEntry {
                        item_native: item_canonical_to_native(&p.item_id),
                        b_loading: p.mode == "load",
                    };
                }
            }
        }
        return encode_dock_config(&DockConfig {
            display_name: m.dock_name.clone().unwrap_or_default(),
            filters,
        });
    }
    if class_path.contains("Elevator") && !class_path.contains("ElevatorFiller") {
        return encode_elevator_or_teleporter_label(m.label.as_deref());
    }
    if class_path.contains("DeepSpaceObservatory") {
        let port_states = decode_assembler_config(fallback_bytes)
            .ok()
            .map(|c| c.port_states)
            .filter(|ps| !ps.is_empty())
            .unwrap_or_else(|| vec![1u8, 1u8]);
        let recipe_native = m
            .recipe_id
            .as_deref()
            .map(recipe_canonical_to_native)
            .unwrap_or_default();
        return encode_assembler_config(&AssemblerConfig {
            recipe_native,
            port_states,
        });
    }
    fallback_bytes.to_vec()
}

pub fn canonical_to_sav_bytes(
    doc: &BlueprintDocument,
    mode: NativeExportMode,
) -> Result<(Vec<u8>, ConversionReport)> {
    let mut warnings = Vec::new();
    let mut next_id: i32 = 50_000;
    let mut used_ids: HashSet<i32> = HashSet::new();

    let mut alloc_id = |preferred: Option<i32>| -> i32 {
        if let Some(id) = preferred {
            if id > 0 && used_ids.insert(id) {
                return id;
            }
        }
        while !used_ids.insert(next_id) {
            next_id += 1;
        }
        let res = next_id;
        next_id += 1;
        res
    };

    // 1. Encode Blocks_0 (+ DefaultMachines_0)
    let mut blocks_json = Vec::with_capacity(doc.modules.len());
    for m in &doc.modules {
        let class_path = m
            .native_meta
            .as_ref()
            .and_then(|nm| nm.class_path.clone())
            .unwrap_or_else(|| module_class_path(&m.module_type));
        let (bx, by, bh, rot) = module_to_native_transform(m);
        let block_id = alloc_id(m.native_meta.as_ref().and_then(|nm| nm.block_id));
        let palette_id = m.palette_id.unwrap_or(0);

        let blk_half_x = bx * 8;
        let blk_half_y = by * 8;
        let blk_half_h = bh * 8;

        let mut dms_json = Vec::new();
        let preserved_dms = m
            .native_meta
            .as_ref()
            .map(|nm| nm.default_machines.as_slice())
            .unwrap_or(&[]);

        if !preserved_dms.is_empty() {
            for dm in preserved_dms {
                let (rx, ry) = rotate_xy(dm.rel_x, dm.rel_y, rot);
                let dm_id = alloc_id(dm.machine_id);
                let cfg_bytes = encode_default_machine_config(m, &dm.class_path, &dm.raw_config);
                dms_json.push(json!({
                    "Class_0": dm.class_path,
                    "Transform_0": {
                        "GridLocation_0": { "x": blk_half_x + rx, "y": blk_half_y + ry },
                        "Height_0": blk_half_h + dm.rel_height,
                        "GridRotation_0": (rot as i32 + dm.rel_rotation).rem_euclid(4)
                    },
                    "MachineID_0": dm_id,
                    "PaletteID_0": dm.palette_id.unwrap_or(palette_id),
                    "SerializedMachineConfig_0": { "Byte": cfg_bytes }
                }));
            }
        } else {
            for tpl in default_machines_for_module(&m.module_type) {
                let (rx, ry) = rotate_xy(tpl.rel_x, tpl.rel_y, rot);
                let dm_id = alloc_id(None);
                let cfg_bytes = encode_default_machine_config(m, tpl.class_path, tpl.default_config);

                dms_json.push(json!({
                    "Class_0": tpl.class_path,
                    "Transform_0": {
                        "GridLocation_0": { "x": blk_half_x + rx, "y": blk_half_y + ry },
                        "Height_0": blk_half_h + tpl.rel_height,
                        "GridRotation_0": (rot as i32 + tpl.rel_rotation).rem_euclid(4)
                    },
                    "MachineID_0": dm_id,
                    "PaletteID_0": palette_id,
                    "SerializedMachineConfig_0": { "Byte": cfg_bytes }
                }));
            }
        }

        blocks_json.push(json!({
            "Class_0": class_path,
            "Transform_0": {
                "GridLocation_0": { "x": bx, "y": by },
                "Height_0": bh,
                "GridRotation_0": rot as i32
            },
            "BlockID_0": block_id,
            "PaletteID_0": palette_id,
            "DefaultMachines_0": dms_json
        }));
    }

    // 2. Encode Machines_0 (folding canonical underground in+out pairs into single native entry + Length!)
    let mut bld_by_id: HashMap<&str, &PlacedBuilding> = HashMap::new();
    for b in &doc.buildings {
        bld_by_id.insert(b.id.as_str(), b);
    }
    let mut consumed_ug: HashSet<String> = HashSet::new();
    let mut machines_json = Vec::new();

    for b in &doc.buildings {
        let kind = machine_config_kind(&b.building_type);
        let rot = b.rotation % 4;
        let (w, d) = buildable_rotated_size(&b.building_type, rot);
        let mx = 2 * b.x + w - 16;
        let my = 2 * b.y + d - 16;
        let mh = b.floor * 16;
        let class_path = b
            .native_meta
            .as_ref()
            .and_then(|nm| nm.class_path.clone())
            .unwrap_or_else(|| buildable_class_path(&b.building_type));
        let palette_id = b.palette_id.unwrap_or(0);

        if kind == MachineConfigKind::Underground {
            if b.underground_mode.as_deref() == Some("out") {
                continue; // Handled when encoding its paired "in" entry
            }
            if consumed_ug.contains(&b.id) {
                continue;
            }
            let (dx, dy) = rot_delta(rot);
            let max_len = catalog()
                .buildables_by_id
                .get(&b.building_type)
                .and_then(|def| def.max_length)
                .unwrap_or(8);

            // 1) Try explicit encoded partner first
            let mut partner: Option<&PlacedBuilding> = None;
            if let Some(pid) = &b.underground_partner_id {
                if let Some(&cand) = bld_by_id.get(pid.as_str()) {
                    if cand.underground_mode.as_deref() == Some("out")
                        && cand.floor == b.floor
                        && cand.rotation % 4 == rot
                        && !consumed_ug.contains(&cand.id)
                    {
                        let vx = cand.x - b.x;
                        let vy = cand.y - b.y;
                        let along = vx * dx + vy * dy;
                        let perp = vx * dy - vy * dx;
                        if perp == 0 && along >= 1 {
                            partner = Some(cand);
                        }
                    }
                }
            }

            // 2) Fallback: nearest collinear unpaired exit of same type/rotation within max_len
            if partner.is_none() {
                let mut best_dist = i32::MAX;
                for cand in &doc.buildings {
                    if cand.building_type != b.building_type
                        || cand.underground_mode.as_deref() != Some("out")
                        || cand.floor != b.floor
                        || cand.rotation % 4 != rot
                        || consumed_ug.contains(&cand.id)
                    {
                        continue;
                    }
                    let vx = cand.x - b.x;
                    let vy = cand.y - b.y;
                    let along = vx * dx + vy * dy;
                    let perp = vx * dy - vy * dx;
                    if perp == 0 && along >= 1 && along <= max_len && along < best_dist {
                        best_dist = along;
                        partner = Some(cand);
                    }
                }
            }

            let length = if let Some(p) = partner {
                consumed_ug.insert(p.id.clone());
                let dist = (p.x - b.x) * dx + (p.y - b.y) * dy;
                dist + 1
            } else {
                warnings.push(format!(
                    "地下带入口 `{}` ({},{},L{}) 未找到配对出口，已按最小长度 2 导出。",
                    b.id, b.x, b.y, b.floor
                ));
                2
            };
            consumed_ug.insert(b.id.clone());

            let mid = alloc_id(b.native_meta.as_ref().and_then(|nm| nm.machine_id));
            machines_json.push(json!({
                "Class_0": class_path,
                "Transform_0": {
                    "GridLocation_0": { "x": mx, "y": my },
                    "Height_0": mh,
                    "GridRotation_0": rot as i32
                },
                "MachineID_0": mid,
                "PaletteID_0": palette_id,
                "SerializedMachineConfig_0": { "Byte": encode_underground_length(length) }
            }));
            continue;
        }

        let mid = alloc_id(b.native_meta.as_ref().and_then(|nm| nm.machine_id));
        let port_count = catalog()
            .buildables_by_id
            .get(&b.building_type)
            .map(|def| def.ports.len())
            .unwrap_or(0);
        let disabled_set: HashSet<i32> = b
            .disabled_ports
            .as_ref()
            .map(|v| v.iter().copied().collect())
            .unwrap_or_default();

        let cfg_bytes: Vec<u8> = if let Some(raw) = b.native_meta.as_ref().and_then(|nm| nm.raw_config.as_ref()) {
            raw.clone()
        } else {
            match kind {
                MachineConfigKind::Assembler => {
                    let recipe_native = b
                        .recipe_id
                        .as_deref()
                        .map(recipe_canonical_to_native)
                        .unwrap_or_default();
                    let mut port_states = vec![1u8; port_count];
                    for (i, st) in port_states.iter_mut().enumerate() {
                        if disabled_set.contains(&(i as i32)) {
                            *st = 0;
                        }
                    }
                    encode_assembler_config(&AssemblerConfig {
                        recipe_native,
                        port_states,
                    })
                }
                MachineConfigKind::Container => {
                    let mut port_states = vec![1u8; port_count];
                    for (i, st) in port_states.iter_mut().enumerate() {
                        if disabled_set.contains(&(i as i32)) {
                            *st = 0;
                        }
                    }
                    let nm = b.native_meta.as_ref();
                    let meta_by_item: HashMap<&str, &LogisticFilterEntry> = nm
                        .map(|n| {
                            n.logistic_filters
                                .iter()
                                .map(|lf| (lf.item_id.as_str(), lf))
                                .collect()
                        })
                        .unwrap_or_default();
                    let logistic_filters = if let Some(items) = &b.filter_items {
                        items
                            .iter()
                            .map(|it| {
                                if let Some(prev) = meta_by_item.get(it.as_str()) {
                                    (*prev).clone()
                                } else {
                                    LogisticFilterEntry {
                                        item_id: it.clone(),
                                        amount: 0,
                                        action: 0,
                                    }
                                }
                            })
                            .collect()
                    } else {
                        Vec::new()
                    };
                    encode_container_config(
                        &ContainerConfig {
                            b_creative: nm.and_then(|n| n.b_creative).unwrap_or(false),
                            creative_item_native: nm
                                .and_then(|n| n.creative_item.as_deref())
                                .map(item_canonical_to_native)
                                .unwrap_or_default(),
                            b_creative_consume: nm.and_then(|n| n.b_creative_consume).unwrap_or(false),
                            logistic_filters,
                            port_states,
                        },
                        item_canonical_to_native,
                    )
                }
                MachineConfigKind::Splitter | MachineConfigKind::Balancer => {
                    let (out_offset, out_count): (i32, usize) = if kind == MachineConfigKind::Balancer {
                        (2, 2)
                    } else {
                        (1, 3)
                    };
                    let mut filters_native = vec![String::new(); out_count];
                    if let Some(pf) = &b.port_filters {
                        for (k, item_id) in pf {
                            if let Ok(port_idx) = k.parse::<i32>() {
                                let slot = port_idx - out_offset;
                                if slot >= 0 && (slot as usize) < out_count {
                                    filters_native[slot as usize] = item_canonical_to_native(item_id);
                                }
                            }
                        }
                    }
                    let mut port_states = vec![1u8; out_count];
                    for (i, st) in port_states.iter_mut().enumerate() {
                        if disabled_set.contains(&(i as i32 + out_offset)) {
                            *st = 0;
                        }
                    }
                    let priority_output_index = b
                        .priority_out
                        .map(|p| {
                            let s = p - out_offset;
                            if s >= 0 && (s as usize) < out_count { s } else { -1 }
                        })
                        .unwrap_or(-1);
                    let priority_input_index = b.priority_in.unwrap_or(-1);
                    encode_splitter_config(&SplitterConfig {
                        filters_native,
                        priority_output_index,
                        priority_input_index,
                        port_states,
                    })
                }
                MachineConfigKind::Teleporter => {
                    encode_elevator_or_teleporter_label(b.label.as_deref())
                }
                MachineConfigKind::None => Vec::new(),
                MachineConfigKind::Underground => unreachable!(),
            }
        };

        machines_json.push(json!({
            "Class_0": class_path,
            "Transform_0": {
                "GridLocation_0": { "x": mx, "y": my },
                "Height_0": mh,
                "GridRotation_0": rot as i32
            },
            "MachineID_0": mid,
            "PaletteID_0": palette_id,
            "SerializedMachineConfig_0": { "Byte": cfg_bytes }
        }));
    }

    // Warn on any dangling unpaired underground exits
    for b in &doc.buildings {
        if machine_config_kind(&b.building_type) == MachineConfigKind::Underground
            && b.underground_mode.as_deref() == Some("out")
            && !consumed_ug.contains(&b.id)
        {
            warnings.push(format!(
                "地下带出口 `{}` ({},{},L{}) 没有配对入口，导出原生 .sav 时已跳过。",
                b.id, b.x, b.y, b.floor
            ));
        }
    }

    // 3. Build Blueprint_0 payload for STATION vs STATION_PRESET
    let connectors_json = match mode {
        NativeExportMode::Station => synthesize_connectors(&doc.modules),
        NativeExportMode::StationPreset => Vec::new(),
    };
    let connector_count = connectors_json.len();

    let bp_obj = match mode {
        NativeExportMode::Station => {
            let palettes = doc
                .native_meta
                .as_ref()
                .and_then(|nm| nm.colour_palettes.clone())
                .unwrap_or_else(default_colour_palettes);
            let cam_loc = doc
                .native_meta
                .as_ref()
                .and_then(|nm| nm.camera_location.clone())
                .unwrap_or_else(|| json!({ "x": -3000.0, "y": -2400.0, "z": 6200.0 }));
            let cam_rot = doc
                .native_meta
                .as_ref()
                .and_then(|nm| nm.camera_rotation.clone())
                .unwrap_or_else(|| json!({ "x": -55.0, "y": 4.0, "z": 0.0 }));

            json!({
                "Version_0": 1,
                "DisplayName_0": {
                    "flags": 2,
                    "variant": { "None": { "culture_invariant": doc.name } }
                },
                "Screenshot_0": render_topdown_screenshot(doc),
                "Type_0": "EBuildingFrameType::STATION",
                "CameraLocation_0": cam_loc,
                "CameraRotation_0": cam_rot,
                "ColourPalettes_0": palettes,
                "Blocks_0": blocks_json,
                "Connectors_0": connectors_json,
                "Machines_0": machines_json
            })
        }
        NativeExportMode::StationPreset => {
            json!({
                "Type_0": "EBuildingFrameType::STATION_PRESET",
                "Blocks_0": blocks_json,
                "Machines_0": machines_json
            })
        }
    };

    let header = doc
        .native_meta
        .as_ref()
        .and_then(|nm| nm.header.clone())
        .unwrap_or_else(default_gvas_header);

    let full_save_json = json!({
        "header": header,
        "schemas": default_design_save_schemas(),
        "root": {
            "save_game_type": "/Script/MainSequence.DesignSaveGame",
            "properties": {
                "Blueprint_0": bp_obj
            }
        },
        "extra": [0, 0, 0, 0]
    });

    let save: Save = serde_json::from_value(full_save_json)
        .context("failed to materialize uesave::Save from Blueprint_0 JSON")?;
    let mut out_bytes = Vec::new();
    save.write(&mut out_bytes)
        .context("failed to serialize uesave::Save into GVAS binary")?;

    let report = ConversionReport {
        warnings,
        module_count: doc.modules.len(),
        building_count: doc.buildings.len(),
        native_machine_count: machines_json.len(),
        connector_count,
    };

    Ok((out_bytes, report))
}
