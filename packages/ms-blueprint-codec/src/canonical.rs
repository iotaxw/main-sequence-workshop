use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub const CANONICAL_FORMAT: &str = "station-blueprint-designer";
pub const CANONICAL_FORMAT_VERSION: i64 = 2;
pub const GAME_BUILD_ID: &str = "26639889";
pub const CATALOG_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameDataMeta {
    #[serde(rename = "buildId")]
    pub build_id: String,
    #[serde(rename = "catalogVersion")]
    pub catalog_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeDefaultMachine {
    pub class_path: String,
    pub rel_x: i32,
    pub rel_y: i32,
    pub rel_height: i32,
    pub rel_rotation: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub raw_config: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModuleNativeMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub default_machines: Vec<NativeDefaultMachine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlacedModule {
    pub id: String,
    #[serde(rename = "type")]
    pub module_type: String,
    pub gx: i32,
    pub gy: i32,
    pub floor: i32,
    pub rotation: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, rename = "paletteId", skip_serializing_if = "Option::is_none")]
    pub palette_id: Option<i32>,
    #[serde(default, rename = "miningItem", skip_serializing_if = "Option::is_none")]
    pub mining_item: Option<String>,
    #[serde(default, rename = "dockName", skip_serializing_if = "Option::is_none")]
    pub dock_name: Option<String>,
    #[serde(default, rename = "nativeMeta", skip_serializing_if = "Option::is_none")]
    pub native_meta: Option<ModuleNativeMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogisticFilterEntry {
    #[serde(rename = "itemId")]
    pub item_id: String,
    pub amount: i32,
    pub action: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BuildingNativeMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b_creative: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creative_item: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b_creative_consume: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub logistic_filters: Vec<LogisticFilterEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_config: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlacedBuilding {
    pub id: String,
    #[serde(rename = "type")]
    pub building_type: String,
    pub x: i32,
    pub y: i32,
    pub floor: i32,
    pub rotation: u8,
    #[serde(default, rename = "recipeId", skip_serializing_if = "Option::is_none")]
    pub recipe_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, rename = "disabledPorts", skip_serializing_if = "Option::is_none")]
    pub disabled_ports: Option<Vec<i32>>,
    #[serde(default, rename = "undergroundMode", skip_serializing_if = "Option::is_none")]
    pub underground_mode: Option<String>,
    #[serde(default, rename = "undergroundPartnerId", skip_serializing_if = "Option::is_none")]
    pub underground_partner_id: Option<String>,
    #[serde(default, rename = "priorityIn", skip_serializing_if = "Option::is_none")]
    pub priority_in: Option<i32>,
    #[serde(default, rename = "priorityOut", skip_serializing_if = "Option::is_none")]
    pub priority_out: Option<i32>,
    #[serde(default, rename = "portFilters", skip_serializing_if = "Option::is_none")]
    pub port_filters: Option<BTreeMap<String, String>>,
    #[serde(default, rename = "filterItems", skip_serializing_if = "Option::is_none")]
    pub filter_items: Option<Vec<String>>,
    #[serde(default, rename = "paletteId", skip_serializing_if = "Option::is_none")]
    pub palette_id: Option<i32>,
    #[serde(default, rename = "nativeMeta", skip_serializing_if = "Option::is_none")]
    pub native_meta: Option<BuildingNativeMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeDocumentMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colour_palettes: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_location: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_rotation: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlueprintDocument {
    pub format: String,
    #[serde(rename = "formatVersion")]
    pub format_version: i64,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "gameData")]
    pub game_data: GameDataMeta,
    pub modules: Vec<PlacedModule>,
    pub buildings: Vec<PlacedBuilding>,
    #[serde(default, rename = "nativeMeta", skip_serializing_if = "Option::is_none")]
    pub native_meta: Option<NativeDocumentMeta>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeExportMode {
    Station,
    StationPreset,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversionReport {
    pub warnings: Vec<String>,
    pub module_count: usize,
    pub building_count: usize,
    pub native_machine_count: usize,
    pub connector_count: usize,
}
