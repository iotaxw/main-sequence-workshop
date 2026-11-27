use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::canonical::{
    BlueprintDocument, BuildingNativeMeta, LogisticFilterEntry, PlacedBuilding, PlacedModule,
};
use crate::catalog_map::{
    buildable_class_path, catalog, machine_config_kind, CatalogFloorSurface, MachineConfigKind,
};
use crate::config_codec::encode_underground_length;
use crate::convert::encode_building_config;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractSectionOptions {
    pub selected_block_ids: Vec<i32>,
    pub include_machines: bool,
    pub normalize_origin: bool,
    pub anchor_block_id: Option<i32>,
    pub name: Option<String>,
}

impl Default for ExtractSectionOptions {
    fn default() -> Self {
        Self {
            selected_block_ids: Vec::new(),
            include_machines: false,
            normalize_origin: true,
            anchor_block_id: None,
            name: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExcludedBuildingInfo {
    pub id: String,
    pub building_type: String,
    pub x: i32,
    pub y: i32,
    pub floor: i32,
    pub reason: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionExtractReport {
    pub selected_blocks: Vec<i32>,
    pub kept_machines: usize,
    pub excluded_cross_boundary: usize,
    pub excluded_outside: usize,
    pub excluded_unpaired: usize,
    pub excluded_details: Vec<ExcludedBuildingInfo>,
    pub anchor_block_id: Option<i32>,
    pub origin_gx: i32,
    pub origin_gy: i32,
    pub origin_floor: i32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractSectionResult {
    pub document: BlueprintDocument,
    pub report: SectionExtractReport,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SectionTransform {
    pub dgx: i32,
    pub dgy: i32,
    pub dfloor: i32,
    pub drot: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeSplitterBuildConfig {
    pub priority_in: Option<i32>,
    pub priority_out: Option<i32>,
    pub port_filters: Option<std::collections::BTreeMap<String, String>>,
    pub disabled_ports: Option<Vec<i32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeContainerBuildConfig {
    pub b_creative: bool,
    pub creative_item: Option<String>,
    pub b_creative_consume: bool,
    pub logistic_filters: Vec<LogisticFilterEntry>,
    pub filter_items: Option<Vec<String>>,
    pub disabled_ports: Option<Vec<i32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeMachineBuildStep {
    pub id: String,
    pub building_type: String,
    pub object_class: String,
    pub native_x: i32,
    pub native_y: i32,
    pub native_height: i32,
    pub native_rotation: u8,
    pub palette_id: Option<i32>,
    pub underground_length: Option<i32>,
    pub recipe_id: Option<String>,
    pub config_kind: MachineConfigKind,
    pub raw_config_hex: String,
    pub splitter: Option<NativeSplitterBuildConfig>,
    pub container: Option<NativeContainerBuildConfig>,
    pub teleporter_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformedSectionPlan {
    pub document: BlueprintDocument,
    pub machine_build_plan: Vec<NativeMachineBuildStep>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct FloorCell {
    x: i32,
    y: i32,
    floor: i32,
}

#[derive(Debug, Clone, Copy)]
struct DoorwayCell {
    cell: FloorCell,
    module_index: usize,
    side: u8,
}

struct SelectionGeometry<'a> {
    modules: Vec<&'a PlacedModule>,
    cells: HashSet<FloorCell>,
}

fn rotate_vec_f64(x: f64, y: f64, rotation: u8) -> (f64, f64) {
    match rotation % 4 {
        0 => (x, y),
        1 => (-y, x),
        2 => (-x, -y),
        _ => (y, -x),
    }
}

fn rotation_delta(rotation: u8) -> (i32, i32) {
    match rotation % 4 {
        0 => (1, 0),
        1 => (0, 1),
        2 => (-1, 0),
        _ => (0, -1),
    }
}

fn side_rotation(side: &str) -> Option<u8> {
    match side {
        "E" => Some(0),
        "S" => Some(1),
        "W" => Some(2),
        "N" => Some(3),
        _ => None,
    }
}

fn local_cell_on_base_surface(lx: f64, ly: f64, surface: &CatalogFloorSurface) -> bool {
    if lx < surface.min_x || lx > surface.max_x || ly < surface.min_y || ly > surface.max_y {
        return false;
    }

    if surface.shape == "ring" {
        if let (Some(hole_min_x), Some(hole_max_x), Some(hole_min_y), Some(hole_max_y)) = (
            surface.hole_min_x,
            surface.hole_max_x,
            surface.hole_min_y,
            surface.hole_max_y,
        ) {
            if lx > hole_min_x && lx < hole_max_x && ly > hole_min_y && ly < hole_max_y {
                return false;
            }
        }
        return true;
    }

    if surface.shape == "corner-ws" {
        return lx - ly <= 3.0;
    }

    true
}

fn local_cell_doorway_side(
    lx: f64,
    ly: f64,
    surface: &CatalogFloorSurface,
    half_w: f64,
    half_d: f64,
    module_rotation: u8,
) -> Option<u8> {
    for doorway in &surface.doorways {
        let local_side = side_rotation(&doorway.side)?;
        let in_threshold = match doorway.side.as_str() {
            "E" => lx >= surface.max_x && lx <= half_w && ly >= doorway.start && ly <= doorway.end,
            "W" => lx <= surface.min_x && lx >= -half_w && ly >= doorway.start && ly <= doorway.end,
            "S" => ly >= surface.max_y && ly <= half_d && lx >= doorway.start && lx <= doorway.end,
            "N" => ly <= surface.min_y && ly >= -half_d && lx >= doorway.start && lx <= doorway.end,
            _ => false,
        };
        if in_threshold {
            return Some((local_side + module_rotation) % 4);
        }
    }
    None
}

impl<'a> SelectionGeometry<'a> {
    fn build(modules: Vec<&'a PlacedModule>) -> Result<Self> {
        let mut cells = HashSet::new();
        let mut doorway_cells = Vec::new();

        for (module_index, module) in modules.iter().enumerate() {
            let def = catalog()
                .modules_by_id
                .get(&module.module_type)
                .with_context(|| {
                    format!(
                        "unknown selected station module type `{}`",
                        module.module_type
                    )
                })?;
            if !def.has_factory_floor {
                continue;
            }
            let (wu, du) = if module.rotation % 2 == 1 {
                (def.size_units[1], def.size_units[0])
            } else {
                (def.size_units[0], def.size_units[1])
            };
            let center_x = (module.gx as f64 + wu as f64 / 2.0) * 16.0;
            let center_y = (module.gy as f64 + du as f64 / 2.0) * 16.0;
            let half_w = def.size_units[0] as f64 * 8.0;
            let half_d = def.size_units[1] as f64 * 8.0;
            let inverse_rotation = (4 - module.rotation % 4) % 4;

            for surface in &def.floors {
                if surface.floor_offset < 0 || surface.floor_offset >= def.size_units[2] {
                    continue;
                }
                let floor = module.floor + surface.floor_offset;
                for x in module.gx * 16..(module.gx + wu) * 16 {
                    for y in module.gy * 16..(module.gy + du) * 16 {
                        let (lx, ly) = rotate_vec_f64(
                            x as f64 + 0.5 - center_x,
                            y as f64 + 0.5 - center_y,
                            inverse_rotation,
                        );
                        let cell = FloorCell { x, y, floor };
                        if local_cell_on_base_surface(lx, ly, surface) {
                            cells.insert(cell);
                        }
                        if let Some(side) = local_cell_doorway_side(
                            lx,
                            ly,
                            surface,
                            half_w,
                            half_d,
                            module.rotation,
                        ) {
                            doorway_cells.push(DoorwayCell {
                                cell,
                                module_index,
                                side,
                            });
                        }
                    }
                }
            }
        }

        let mut doorway_by_cell: HashMap<FloorCell, Vec<(usize, u8)>> = HashMap::new();
        for doorway in &doorway_cells {
            doorway_by_cell
                .entry(doorway.cell)
                .or_default()
                .push((doorway.module_index, doorway.side));
        }
        for doorway in &doorway_cells {
            let (dx, dy) = rotation_delta(doorway.side);
            let neighbor = FloorCell {
                x: doorway.cell.x + dx,
                y: doorway.cell.y + dy,
                floor: doorway.cell.floor,
            };
            let aligned = doorway_by_cell
                .get(&neighbor)
                .map(|candidates| {
                    candidates.iter().any(|&(module_index, side)| {
                        module_index != doorway.module_index && side == (doorway.side + 2) % 4
                    })
                })
                .unwrap_or(false);
            if aligned {
                cells.insert(doorway.cell);
                cells.insert(neighbor);
            }
        }

        Ok(Self { modules, cells })
    }

    fn contains(&self, x: i32, y: i32, floor: i32) -> bool {
        self.cells.contains(&FloorCell { x, y, floor })
    }

    fn within_selected_module_bounds(&self, x: i32, y: i32, floor: i32) -> bool {
        self.modules.iter().any(|module| {
            let Some(def) = catalog().modules_by_id.get(&module.module_type) else {
                return false;
            };
            let (wu, du) = if module.rotation % 2 == 1 {
                (def.size_units[1], def.size_units[0])
            } else {
                (def.size_units[0], def.size_units[1])
            };
            floor >= module.floor
                && floor < module.floor + def.size_units[2]
                && x >= module.gx * 16
                && x < (module.gx + wu) * 16
                && y >= module.gy * 16
                && y < (module.gy + du) * 16
        })
    }
}

fn selected_modules<'a>(
    doc: &'a BlueprintDocument,
    opts: &ExtractSectionOptions,
) -> Result<Vec<&'a PlacedModule>> {
    if opts.selected_block_ids.is_empty() {
        bail!("selected_block_ids must not be empty");
    }
    let mut requested = HashSet::new();
    for id in &opts.selected_block_ids {
        if *id <= 0 {
            bail!("selected block ID {id} is invalid; block IDs must be positive");
        }
        if !requested.insert(*id) {
            bail!("duplicate selected block ID {id}");
        }
    }
    if let Some(anchor) = opts.anchor_block_id {
        if !requested.contains(&anchor) {
            bail!("anchor block ID {anchor} is not in selected_block_ids");
        }
    }

    let mut by_block_id = HashMap::new();
    for (index, module) in doc.modules.iter().enumerate() {
        if let Some(block_id) = module.native_meta.as_ref().and_then(|meta| meta.block_id) {
            if by_block_id.insert(block_id, index).is_some() {
                bail!("source Blocks_0 contains duplicate block ID {block_id}");
            }
        }
    }
    let missing: Vec<i32> = opts
        .selected_block_ids
        .iter()
        .copied()
        .filter(|id| !by_block_id.contains_key(id))
        .collect();
    if !missing.is_empty() {
        bail!("selected block IDs not found in source Blocks_0/native_meta.block_id: {missing:?}");
    }

    Ok(doc
        .modules
        .iter()
        .filter(|module| {
            module
                .native_meta
                .as_ref()
                .and_then(|meta| meta.block_id)
                .map(|id| requested.contains(&id))
                .unwrap_or(false)
        })
        .collect())
}

fn buildable_size(building_type: &str, rotation: u8) -> Result<(i32, i32)> {
    let def = catalog()
        .buildables_by_id
        .get(building_type)
        .with_context(|| format!("unknown building type `{building_type}`"))?;
    Ok(if rotation % 2 == 1 {
        (def.size[1], def.size[0])
    } else {
        (def.size[0], def.size[1])
    })
}

fn footprint_membership(
    building: &PlacedBuilding,
    geometry: &SelectionGeometry<'_>,
) -> Result<(usize, usize)> {
    let (w, d) = buildable_size(&building.building_type, building.rotation)?;
    let mut inside = 0;
    for x in building.x..building.x + w {
        for y in building.y..building.y + d {
            if geometry.contains(x, y, building.floor) {
                inside += 1;
            }
        }
    }
    Ok((inside, (w * d) as usize))
}

#[derive(Debug, Clone, Copy)]
struct UndergroundPair {
    entry: usize,
    exit: usize,
}

fn inline_underground_valid(buildings: &[PlacedBuilding], entry: usize, exit: usize) -> bool {
    let input = &buildings[entry];
    let output = &buildings[exit];
    if entry == exit
        || input.floor != output.floor
        || input.rotation % 4 != output.rotation % 4
        || input.underground_mode.as_deref() == Some("out")
        || output.underground_mode.as_deref() != Some("out")
    {
        return false;
    }
    let max_length = catalog()
        .buildables_by_id
        .get(&input.building_type)
        .and_then(|def| def.max_length)
        .unwrap_or(8);
    let (dx, dy) = rotation_delta(input.rotation);
    let rx = output.x - input.x;
    let ry = output.y - input.y;
    let along = rx * dx + ry * dy;
    let perpendicular = (rx * dy - ry * dx).abs();
    perpendicular == 0 && along >= 1 && along <= max_length
}

fn resolve_underground_pairs(
    buildings: &[PlacedBuilding],
) -> Result<(Vec<UndergroundPair>, Vec<usize>)> {
    let undergrounds: Vec<usize> = buildings
        .iter()
        .enumerate()
        .filter_map(|(index, building)| {
            (machine_config_kind(&building.building_type) == MachineConfigKind::Underground)
                .then_some(index)
        })
        .collect();
    let mut by_id = HashMap::new();
    for &index in &undergrounds {
        if by_id.insert(buildings[index].id.as_str(), index).is_some() {
            bail!(
                "duplicate underground building ID `{}`",
                buildings[index].id
            );
        }
    }
    let mut used = HashSet::new();
    let mut pairs = Vec::new();

    for &entry in &undergrounds {
        if used.contains(&entry) || buildings[entry].underground_mode.as_deref() == Some("out") {
            continue;
        }
        let Some(partner_id) = buildings[entry].underground_partner_id.as_deref() else {
            continue;
        };
        let Some(&exit) = by_id.get(partner_id) else {
            continue;
        };
        if used.contains(&exit) || !inline_underground_valid(buildings, entry, exit) {
            continue;
        }
        used.insert(entry);
        used.insert(exit);
        pairs.push(UndergroundPair { entry, exit });
    }

    for &entry in &undergrounds {
        if used.contains(&entry) || buildings[entry].underground_mode.as_deref() == Some("out") {
            continue;
        }
        let input = &buildings[entry];
        let input_tier = catalog()
            .buildables_by_id
            .get(&input.building_type)
            .map(|def| def.tier);
        let mut best: Option<(usize, bool, i32)> = None;
        for &candidate in &undergrounds {
            if candidate == entry || used.contains(&candidate) {
                continue;
            }
            if buildings[candidate]
                .underground_partner_id
                .as_deref()
                .map(|id| by_id.contains_key(id))
                .unwrap_or(false)
            {
                continue;
            }
            if !inline_underground_valid(buildings, entry, candidate) {
                continue;
            }
            let candidate_tier = catalog()
                .buildables_by_id
                .get(&buildings[candidate].building_type)
                .map(|def| def.tier);
            let same_tier = candidate_tier == input_tier;
            let (dx, dy) = rotation_delta(input.rotation);
            let along =
                (buildings[candidate].x - input.x) * dx + (buildings[candidate].y - input.y) * dy;
            let replace = best
                .map(|(_, best_same_tier, best_distance)| {
                    (same_tier && !best_same_tier)
                        || (same_tier == best_same_tier && along < best_distance)
                })
                .unwrap_or(true);
            if replace {
                best = Some((candidate, same_tier, along));
            }
        }
        if let Some((exit, _, _)) = best {
            used.insert(entry);
            used.insert(exit);
            pairs.push(UndergroundPair { entry, exit });
        }
    }

    pairs.sort_by_key(|pair| pair.entry);
    let unpaired = undergrounds
        .into_iter()
        .filter(|index| !used.contains(index))
        .collect();
    Ok((pairs, unpaired))
}

fn excluded_info(building: &PlacedBuilding, reason: &str, detail: String) -> ExcludedBuildingInfo {
    ExcludedBuildingInfo {
        id: building.id.clone(),
        building_type: building.building_type.clone(),
        x: building.x,
        y: building.y,
        floor: building.floor,
        reason: reason.to_owned(),
        detail,
    }
}

pub fn extract_section_from_sav(
    sav_bytes: &[u8],
    opts: &ExtractSectionOptions,
) -> Result<ExtractSectionResult> {
    let (doc, conversion_report) = crate::convert::sav_bytes_to_canonical(sav_bytes)?;
    let mut result = extract_section_from_doc(&doc, opts)?;
    result
        .report
        .warnings
        .splice(0..0, conversion_report.warnings);
    Ok(result)
}

pub fn extract_section_from_doc(
    doc: &BlueprintDocument,
    opts: &ExtractSectionOptions,
) -> Result<ExtractSectionResult> {
    let modules = selected_modules(doc, opts)?;
    let anchor_id = if opts.normalize_origin {
        Some(opts.anchor_block_id.unwrap_or(opts.selected_block_ids[0]))
    } else {
        opts.anchor_block_id
    };
    let (origin_gx, origin_gy, origin_floor) = if opts.normalize_origin {
        let anchor = modules
            .iter()
            .find(|module| module.native_meta.as_ref().and_then(|meta| meta.block_id) == anchor_id)
            .context("normalization anchor disappeared from selected modules")?;
        (anchor.gx, anchor.gy, anchor.floor)
    } else {
        (0, 0, 0)
    };

    let mut document = doc.clone();
    document.modules = modules.iter().map(|module| (*module).clone()).collect();
    document.buildings.clear();
    if let Some(name) = &opts.name {
        document.name = name.clone();
    }

    let mut report = SectionExtractReport {
        selected_blocks: opts.selected_block_ids.clone(),
        kept_machines: 0,
        excluded_cross_boundary: 0,
        excluded_outside: 0,
        excluded_unpaired: 0,
        excluded_details: Vec::new(),
        anchor_block_id: anchor_id,
        origin_gx,
        origin_gy,
        origin_floor,
        warnings: Vec::new(),
    };

    if opts.include_machines {
        let geometry = SelectionGeometry::build(modules)?;
        let (pairs, unpaired) = resolve_underground_pairs(&doc.buildings)?;
        let mut keep = vec![false; doc.buildings.len()];

        for (index, building) in doc.buildings.iter().enumerate() {
            let kind = machine_config_kind(&building.building_type);
            if kind == MachineConfigKind::Underground {
                continue;
            }
            let (inside, total) = footprint_membership(building, &geometry)?;
            if inside == total {
                keep[index] = true;
                report.kept_machines += 1;
            } else if inside > 0 {
                report.excluded_cross_boundary += 1;
                report.excluded_details.push(excluded_info(
                    building,
                    "cross_boundary_footprint",
                    format!(
                        "{inside} of {total} footprint cells are inside selected factory floors"
                    ),
                ));
            } else {
                report.excluded_outside += 1;
                report.excluded_details.push(excluded_info(
                    building,
                    "outside_selection",
                    "no footprint cells are inside selected factory floors".to_owned(),
                ));
            }
        }

        for pair in &pairs {
            let input = &doc.buildings[pair.entry];
            let output = &doc.buildings[pair.exit];
            let (input_inside, input_total) = footprint_membership(input, &geometry)?;
            let (output_inside, output_total) = footprint_membership(output, &geometry)?;
            let pair_detail = format!("underground pair `{}` <-> `{}`", input.id, output.id);

            if input_inside == 0 && output_inside == 0 {
                report.excluded_outside += 1;
                for building in [input, output] {
                    report.excluded_details.push(excluded_info(
                        building,
                        "outside_selection",
                        format!(
                            "{pair_detail}: both endpoints are outside selected factory floors"
                        ),
                    ));
                }
                continue;
            }

            let mut crossing_detail = None;
            if input_inside != input_total || output_inside != output_total {
                crossing_detail = Some(format!(
                    "{pair_detail}: endpoint footprints are not both strictly inside selected factory floors"
                ));
            } else {
                let (dx, dy) = rotation_delta(input.rotation);
                let distance = (output.x - input.x) * dx + (output.y - input.y) * dy;
                for step in 1..distance {
                    let x = input.x + dx * step;
                    let y = input.y + dy * step;
                    if !geometry.contains(x, y, input.floor)
                        && !geometry.within_selected_module_bounds(x, y, input.floor)
                    {
                        crossing_detail = Some(format!(
                            "{pair_detail}: intermediate cell ({x},{y},L{}) crosses unselected space",
                            input.floor
                        ));
                        break;
                    }
                }
            }

            if let Some(detail) = crossing_detail {
                report.excluded_cross_boundary += 1;
                for building in [input, output] {
                    report.excluded_details.push(excluded_info(
                        building,
                        "cross_boundary_underground",
                        detail.clone(),
                    ));
                }
            } else {
                keep[pair.entry] = true;
                keep[pair.exit] = true;
                report.kept_machines += 1;
            }
        }

        for index in unpaired {
            let building = &doc.buildings[index];
            report.excluded_unpaired += 1;
            report.excluded_details.push(excluded_info(
                building,
                "unpaired_underground",
                "no valid collinear in/out partner was found".to_owned(),
            ));
        }

        document.buildings = doc
            .buildings
            .iter()
            .enumerate()
            .filter(|(index, _)| keep[*index])
            .map(|(_, building)| building.clone())
            .collect();
    } else if !doc.buildings.is_empty() {
        report
            .warnings
            .push("machines omitted because include_machines is false".to_owned());
    }

    if opts.normalize_origin {
        let building_dx = origin_gx
            .checked_mul(16)
            .context("origin X normalization overflow")?;
        let building_dy = origin_gy
            .checked_mul(16)
            .context("origin Y normalization overflow")?;
        for module in &mut document.modules {
            module.gx = module
                .gx
                .checked_sub(origin_gx)
                .context("module X normalization overflow")?;
            module.gy = module
                .gy
                .checked_sub(origin_gy)
                .context("module Y normalization overflow")?;
            module.floor = module
                .floor
                .checked_sub(origin_floor)
                .context("module floor normalization overflow")?;
        }
        for building in &mut document.buildings {
            building.x = building
                .x
                .checked_sub(building_dx)
                .context("building X normalization overflow")?;
            building.y = building
                .y
                .checked_sub(building_dy)
                .context("building Y normalization overflow")?;
            building.floor = building
                .floor
                .checked_sub(origin_floor)
                .context("building floor normalization overflow")?;
        }
    }

    Ok(ExtractSectionResult { document, report })
}

fn rotate_footprint(x: i32, y: i32, w: i32, d: i32, span: i32, rotation: u8) -> (i32, i32) {
    match rotation {
        0 => (x, y),
        1 => (span - y - d, x),
        2 => (span - x - w, span - y - d),
        3 => (y, span - x - w),
        _ => unreachable!(),
    }
}

fn native_building_transform(building: &PlacedBuilding) -> Result<(i32, i32, i32, u8)> {
    let (w, d) = buildable_size(&building.building_type, building.rotation)?;
    Ok((
        2 * building.x + w - 16,
        2 * building.y + d - 16,
        building.floor * 16,
        building.rotation % 4,
    ))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn object_class(building: &PlacedBuilding) -> String {
    building
        .native_meta
        .as_ref()
        .and_then(|meta| meta.class_path.clone())
        .unwrap_or_else(|| buildable_class_path(&building.building_type))
}

fn regular_build_step(building: &PlacedBuilding) -> Result<NativeMachineBuildStep> {
    let (native_x, native_y, native_height, native_rotation) = native_building_transform(building)?;
    let config_kind = machine_config_kind(&building.building_type);
    let empty_meta = BuildingNativeMeta::default();
    let meta = building.native_meta.as_ref().unwrap_or(&empty_meta);
    let splitter = matches!(
        config_kind,
        MachineConfigKind::Splitter | MachineConfigKind::Balancer
    )
    .then(|| NativeSplitterBuildConfig {
        priority_in: building.priority_in,
        priority_out: building.priority_out,
        port_filters: building.port_filters.clone(),
        disabled_ports: building.disabled_ports.clone(),
    });
    let container =
        (config_kind == MachineConfigKind::Container).then(|| NativeContainerBuildConfig {
            b_creative: meta.b_creative.unwrap_or(false),
            creative_item: meta.creative_item.clone(),
            b_creative_consume: meta.b_creative_consume.unwrap_or(false),
            logistic_filters: meta.logistic_filters.clone(),
            filter_items: building.filter_items.clone(),
            disabled_ports: building.disabled_ports.clone(),
        });
    let raw_config = encode_building_config(building, config_kind);
    Ok(NativeMachineBuildStep {
        id: building.id.clone(),
        building_type: building.building_type.clone(),
        object_class: object_class(building),
        native_x,
        native_y,
        native_height,
        native_rotation,
        palette_id: building.palette_id,
        underground_length: None,
        recipe_id: building.recipe_id.clone(),
        config_kind,
        raw_config_hex: hex_encode(&raw_config),
        splitter,
        container,
        teleporter_label: (config_kind == MachineConfigKind::Teleporter)
            .then(|| building.label.clone())
            .flatten(),
    })
}

fn underground_build_step(
    input: &PlacedBuilding,
    output: &PlacedBuilding,
) -> Result<NativeMachineBuildStep> {
    let (native_x, native_y, native_height, native_rotation) = native_building_transform(input)?;
    let (dx, dy) = rotation_delta(input.rotation);
    let length = (output.x - input.x) * dx + (output.y - input.y) * dy + 1;
    if length < 2 {
        bail!(
            "underground pair `{}` <-> `{}` has invalid Length {length}",
            input.id,
            output.id
        );
    }
    Ok(NativeMachineBuildStep {
        id: input.id.clone(),
        building_type: input.building_type.clone(),
        object_class: object_class(input),
        native_x,
        native_y,
        native_height,
        native_rotation,
        palette_id: input.palette_id.or(output.palette_id),
        underground_length: Some(length),
        recipe_id: input.recipe_id.clone(),
        config_kind: MachineConfigKind::Underground,
        raw_config_hex: hex_encode(&encode_underground_length(length)),
        splitter: None,
        container: None,
        teleporter_label: None,
    })
}

pub fn transform_section(
    doc: &BlueprintDocument,
    tf: &SectionTransform,
) -> Result<TransformedSectionPlan> {
    if tf.drot > 3 {
        bail!("drot must be in 0..=3, got {}", tf.drot);
    }
    let (pairs, unpaired) = resolve_underground_pairs(&doc.buildings)?;
    if !unpaired.is_empty() {
        let ids: Vec<&str> = unpaired
            .iter()
            .map(|&index| doc.buildings[index].id.as_str())
            .collect();
        bail!("cannot transform unpaired underground buildings: {ids:?}");
    }

    let mut document = doc.clone();
    for module in &mut document.modules {
        let def = catalog()
            .modules_by_id
            .get(&module.module_type)
            .with_context(|| format!("unknown station module type `{}`", module.module_type))?;
        let (wu, du) = if module.rotation % 2 == 1 {
            (def.size_units[1], def.size_units[0])
        } else {
            (def.size_units[0], def.size_units[1])
        };
        let (gx, gy) = rotate_footprint(module.gx, module.gy, wu, du, 1, tf.drot);
        module.gx = gx
            .checked_add(tf.dgx)
            .context("module X transform overflow")?;
        module.gy = gy
            .checked_add(tf.dgy)
            .context("module Y transform overflow")?;
        module.floor = module
            .floor
            .checked_add(tf.dfloor)
            .context("module floor transform overflow")?;
        module.rotation = (module.rotation + tf.drot) % 4;
    }
    for building in &mut document.buildings {
        let (w, d) = buildable_size(&building.building_type, building.rotation)?;
        let (x, y) = rotate_footprint(building.x, building.y, w, d, 16, tf.drot);
        building.x = x
            .checked_add(
                tf.dgx
                    .checked_mul(16)
                    .context("building X translation overflow")?,
            )
            .context("building X transform overflow")?;
        building.y = y
            .checked_add(
                tf.dgy
                    .checked_mul(16)
                    .context("building Y translation overflow")?,
            )
            .context("building Y transform overflow")?;
        building.floor = building
            .floor
            .checked_add(tf.dfloor)
            .context("building floor transform overflow")?;
        building.rotation = (building.rotation + tf.drot) % 4;
    }

    let pair_by_entry: HashMap<usize, usize> =
        pairs.iter().map(|pair| (pair.entry, pair.exit)).collect();
    let paired_exits: HashSet<usize> = pairs.iter().map(|pair| pair.exit).collect();
    let mut machine_build_plan = Vec::new();
    for (index, building) in document.buildings.iter().enumerate() {
        if machine_config_kind(&building.building_type) == MachineConfigKind::Underground {
            if paired_exits.contains(&index) {
                continue;
            }
            let exit = pair_by_entry
                .get(&index)
                .context("internal underground pairing inconsistency")?;
            machine_build_plan.push(underground_build_step(
                building,
                &document.buildings[*exit],
            )?);
        } else {
            machine_build_plan.push(regular_build_step(building)?);
        }
    }

    Ok(TransformedSectionPlan {
        document,
        machine_build_plan,
    })
}
