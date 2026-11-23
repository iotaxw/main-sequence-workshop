use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

const CATALOG_JSON: &str = include_str!("../data/catalog-26639889.json");

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogConnector {
    #[serde(rename = "type")]
    pub conn_type: String,
    pub gx: i32,
    pub gy: i32,
    #[serde(rename = "floorOffset")]
    pub floor_offset: i32,
    pub rotation: u8,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogModule {
    pub id: String,
    #[serde(rename = "sizeUnits")]
    pub size_units: [i32; 3],
    pub connectors: Vec<CatalogConnector>,
    #[serde(rename = "sourceAsset")]
    pub source_asset: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogPort {
    #[allow(dead_code)]
    pub index: i32,
    #[allow(dead_code)]
    pub role: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogBuildable {
    pub id: String,
    #[serde(rename = "objectClass")]
    pub object_class: String,
    pub kind: String,
    pub size: [i32; 2],
    pub ports: Vec<CatalogPort>,
    #[serde(rename = "maxLength")]
    pub max_length: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogRecipeIo {
    #[serde(rename = "itemId")]
    pub item_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogRecipe {
    pub id: String,
    pub inputs: Vec<CatalogRecipeIo>,
    pub outputs: Vec<CatalogRecipeIo>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawCatalog {
    #[serde(rename = "stationModules")]
    station_modules: Vec<CatalogModule>,
    buildables: Vec<CatalogBuildable>,
    recipes: Vec<CatalogRecipe>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MachineConfigKind {
    None,
    Assembler,
    Container,
    Splitter,
    Balancer,
    Underground,
    Teleporter,
}

#[derive(Debug, Clone)]
pub struct DefaultMachineTemplate {
    pub class_path: &'static str,
    pub rel_x: i32,
    pub rel_y: i32,
    pub rel_height: i32,
    pub rel_rotation: i32,
    pub default_config: &'static [u8],
}

pub struct CatalogIndex {
    pub modules_by_id: HashMap<String, CatalogModule>,
    pub module_id_by_class_name: HashMap<String, String>,
    pub buildables_by_id: HashMap<String, CatalogBuildable>,
    pub buildable_id_by_class_name: HashMap<String, String>,
    pub recipe_native_to_canonical: HashMap<String, String>,
    pub recipe_canonical_to_native: HashMap<String, String>,
    pub item_native_to_canonical: HashMap<String, String>,
    pub item_canonical_to_native: HashMap<String, String>,
}

static CATALOG_INDEX: OnceLock<CatalogIndex> = OnceLock::new();

pub fn catalog() -> &'static CatalogIndex {
    CATALOG_INDEX.get_or_init(build_catalog_index)
}

const RECIPE_SPECIAL_OVERRIDES: &[(&str, &str)] = &[
    // Audited across 100% of all 83 recipes in Build 26639889 PAKs!
    ("REC_MageticCoils", "magneticcoils"),
    ("REC_MagneticCoilsAlt1", "magneticcoils2"),
    ("REC_ReinforcedPlates", "reinforcedplate"),
    ("REC_ReinforcedPlatesAlt", "reinforcedplatealt"),
    ("REC_Enzyme", "Enzyme"),
    ("REC_BackpackMk1", "backpack1"),
    ("REC_BackpackMk2", "backpack2"),
    ("REC_BackpackMk3", "backpack3"),
    ("REC_ExoskeletonMk1", "exoskeleton1"),
    ("REC_ExoskeletonMk2", "exoskeleton2"),
    ("REC_ExoskeletonMk3", "exoskeleton3"),
    ("REC_JetpackMk1", "jetpack1"),
    ("REC_JetpackMk2", "jetpack2"),
    ("REC_JetpackMk3", "jetpack3"),
    ("REC_SpacesuitMk1", "spacesuit1"),
    ("REC_SpacesuitMk2", "spacesuit2"),
    ("REC_SpacesuitMk3", "spacesuit3"),
    ("REC_Battery_01", "battery1"),
    ("REC_Battery_02", "battery2"),
    ("REC_FuelCell_01", "fuelcell1"),
];

const ITEM_SPECIAL_OVERRIDES: &[(&str, &str)] = &[
    // Audited across 100% of all 81 items in Build 26639889 PAKs!
    ("ITEM_ReinforcedPlates", "reinforcedplate"),
    ("ITEM_AdvancedPlates", "Advancedplates"),
    ("ITEM_AlphaProtein", "AlphaProtein"),
    ("ITEM_BetaProtein", "BetaProtein"),
    ("ITEM_Biolattice", "Biolattice"),
    ("ITEM_ChitinComposite", "ChitinComposite"),
    ("ITEM_EmptySimulationMatrix", "EmptySimulationMatrix"),
    ("ITEM_EncodedSimulationMatrix", "EncodedSimulationMatrix"),
    ("ITEM_Enzyme", "Enzyme"),
    ("ITEM_StellarSurveyData", "StellarSurveyData"),
    ("ITEM_Xenoarchaea", "Xenoarchaea"),
    ("ITEM_BackpackMk1", "backpack1"),
    ("ITEM_BackpackMk2", "backpack2"),
    ("ITEM_BackpackMk3", "backpack3"),
    ("ITEM_ExoskeletonMk1", "exoskeleton1"),
    ("ITEM_ExoskeletonMk2", "exoskeleton2"),
    ("ITEM_ExoskeletonMk3", "exoskeleton3"),
    ("ITEM_Battery_01", "battery1"),
    ("ITEM_Battery_02", "battery2"),
    ("ITEM_FuelCell_01", "fuelcell1"),
    ("ITEM_Relic_01", "relic1"),
    ("ITEM_Relic_02", "relic2"),
    ("ITEM_Relic_03", "relic3"),
    ("ITEM_Relic_04", "relic4"),
    ("ITEM_Relic_05", "relic5"),
    ("DAT_ConveyorBelt", "conveyor1"),
    ("DAT_Splitter", "splitter1"),
    ("DAT_Container", "container1"),
    ("DAT_Refinery", "Refinery"),
    ("DAT_Assembler", "Assembler"),
    ("DAT_EnrichmentChamber", "EnrichmentChamber"),
    ("DAT_MatSciLab", "matscilab"),
    ("DAT_CompSciLab", "compscilab"),
];

fn build_catalog_index() -> CatalogIndex {
    let raw: RawCatalog =
        serde_json::from_str(CATALOG_JSON).expect("embedded catalog-26639889.json must be valid");

    let mut modules_by_id = HashMap::new();
    let mut module_id_by_class_name = HashMap::new();
    for m in raw.station_modules {
        let cls_c = format!("{}_C", m.id);
        module_id_by_class_name.insert(cls_c, m.id.clone());
        module_id_by_class_name.insert(m.id.clone(), m.id.clone());
        modules_by_id.insert(m.id.clone(), m);
    }

    let mut buildables_by_id = HashMap::new();
    let mut buildable_id_by_class_name = HashMap::new();
    for b in raw.buildables {
        let cls_c = format!("{}_C", b.object_class);
        buildable_id_by_class_name.insert(cls_c, b.id.clone());
        buildable_id_by_class_name.insert(b.object_class.clone(), b.id.clone());
        buildables_by_id.insert(b.id.clone(), b);
    }

    let mut recipe_native_to_canonical = HashMap::new();
    let mut recipe_canonical_to_native = HashMap::new();
    let mut item_native_to_canonical = HashMap::new();
    let mut item_canonical_to_native = HashMap::new();

    for r in &raw.recipes {
        let default_native = r
            .id
            .strip_prefix("REC_")
            .unwrap_or(&r.id)
            .to_ascii_lowercase();
        recipe_native_to_canonical.insert(default_native.clone(), r.id.clone());
        recipe_canonical_to_native.insert(r.id.clone(), default_native);

        for io in r.inputs.iter().chain(r.outputs.iter()) {
            let default_item_native = io
                .item_id
                .strip_prefix("ITEM_")
                .or_else(|| io.item_id.strip_prefix("DAT_"))
                .unwrap_or(&io.item_id)
                .to_ascii_lowercase();
            item_native_to_canonical
                .entry(default_item_native.clone())
                .or_insert_with(|| io.item_id.clone());
            item_canonical_to_native
                .entry(io.item_id.clone())
                .or_insert(default_item_native);
        }
    }

    for &(canon, native) in RECIPE_SPECIAL_OVERRIDES {
        recipe_native_to_canonical.insert(native.to_ascii_lowercase(), canon.to_owned());
        recipe_canonical_to_native.insert(canon.to_owned(), native.to_owned());
    }
    for &(canon, native) in ITEM_SPECIAL_OVERRIDES {
        item_native_to_canonical.insert(native.to_ascii_lowercase(), canon.to_owned());
        item_canonical_to_native.insert(canon.to_owned(), native.to_owned());
    }

    CatalogIndex {
        modules_by_id,
        module_id_by_class_name,
        buildables_by_id,
        buildable_id_by_class_name,
        recipe_native_to_canonical,
        recipe_canonical_to_native,
        item_native_to_canonical,
        item_canonical_to_native,
    }
}

pub fn extract_class_short_name(class_path: &str) -> &str {
    class_path.rsplit('.').next().unwrap_or(class_path)
}

pub fn module_class_path(module_id: &str) -> String {
    if let Some(def) = catalog().modules_by_id.get(module_id) {
        format!("{}.{}_C", def.source_asset, def.id)
    } else {
        format!("/Game/Blueprints/BuildingBlocks/{module_id}.{module_id}_C")
    }
}

pub fn buildable_class_path(buildable_id: &str) -> String {
    if let Some(def) = catalog().buildables_by_id.get(buildable_id) {
        let obj = &def.object_class;
        match buildable_id {
            "DAT_Chair" | "DAT_CoffeeTable" | "DAT_Plant_01" => {
                format!("/Game/Blueprints/Decorations/{obj}.{obj}_C")
            }
            _ => format!("/Game/Blueprints/Machines/{obj}.{obj}_C"),
        }
    } else {
        format!("/Game/Blueprints/Machines/{buildable_id}.{buildable_id}_C")
    }
}

pub fn machine_config_kind(buildable_id: &str) -> MachineConfigKind {
    match catalog().buildables_by_id.get(buildable_id).map(|b| b.kind.as_str()) {
        Some("crafter") => MachineConfigKind::Assembler,
        Some("container") => MachineConfigKind::Container,
        Some("splitter") => MachineConfigKind::Splitter,
        Some("balancer") => MachineConfigKind::Balancer,
        Some("underground") => MachineConfigKind::Underground,
        Some("teleporter") => MachineConfigKind::Teleporter,
        _ => MachineConfigKind::None,
    }
}

pub fn recipe_native_to_canonical(native: &str) -> String {
    let trimmed = native.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(found) = catalog()
        .recipe_native_to_canonical
        .get(&trimmed.to_ascii_lowercase())
    {
        return found.clone();
    }
    trimmed.to_owned()
}

pub fn recipe_canonical_to_native(canonical: &str) -> String {
    let trimmed = canonical.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(found) = catalog().recipe_canonical_to_native.get(trimmed) {
        return found.clone();
    }
    trimmed
        .strip_prefix("REC_")
        .unwrap_or(trimmed)
        .to_ascii_lowercase()
}

pub fn item_native_to_canonical(native: &str) -> String {
    let trimmed = native.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(found) = catalog()
        .item_native_to_canonical
        .get(&trimmed.to_ascii_lowercase())
    {
        return found.clone();
    }
    trimmed.to_owned()
}

pub fn item_canonical_to_native(canonical: &str) -> String {
    let trimmed = canonical.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(found) = catalog().item_canonical_to_native.get(trimmed) {
        return found.clone();
    }
    trimmed
        .strip_prefix("ITEM_")
        .or_else(|| trimmed.strip_prefix("DAT_"))
        .unwrap_or(trimmed)
        .to_ascii_lowercase()
}

const EMPTY_ELEVATOR_CONFIG: &[u8] = &[1, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0];
const EMPTY_MINING_CONFIG: &[u8] = &[1, 0, 0, 0, 0, 0];
const EMPTY_DOCK_CONFIG: &[u8] = &[1, 0, 0, 0, 0, 0, 0, 0, 0, 0];

pub fn default_machines_for_module(module_id: &str) -> &'static [DefaultMachineTemplate] {
    match module_id {
        "BPO_ElevatorBlock_03" => &[DefaultMachineTemplate {
            class_path: "/Game/Blueprints/Machines/BPO_Elevator_02.BPO_Elevator_02_C",
            rel_x: 0,
            rel_y: 0,
            rel_height: 0,
            rel_rotation: 0,
            default_config: EMPTY_ELEVATOR_CONFIG,
        }],
        "BPO_ElevatorBlock_02A" => &[
            DefaultMachineTemplate {
                class_path: "/Game/Blueprints/Machines/BPO_Elevator.BPO_Elevator_C",
                rel_x: -18,
                rel_y: 0,
                rel_height: 0,
                rel_rotation: 0,
                default_config: EMPTY_ELEVATOR_CONFIG,
            },
            DefaultMachineTemplate {
                class_path: "/Game/Blueprints/Machines/BPO_Elevator.BPO_Elevator_C",
                rel_x: 0,
                rel_y: -18,
                rel_height: 0,
                rel_rotation: 1,
                default_config: EMPTY_ELEVATOR_CONFIG,
            },
            DefaultMachineTemplate {
                class_path: "/Game/Blueprints/Machines/BPO_Elevator.BPO_Elevator_C",
                rel_x: 18,
                rel_y: 0,
                rel_height: 0,
                rel_rotation: 2,
                default_config: EMPTY_ELEVATOR_CONFIG,
            },
            DefaultMachineTemplate {
                class_path: "/Game/Blueprints/Machines/BPO_Elevator.BPO_Elevator_C",
                rel_x: 0,
                rel_y: 18,
                rel_height: 0,
                rel_rotation: 3,
                default_config: EMPTY_ELEVATOR_CONFIG,
            },
            DefaultMachineTemplate {
                class_path: "/Game/Blueprints/Machines/BPO_ElevatorFiller.BPO_ElevatorFiller_C",
                rel_x: -18,
                rel_y: 0,
                rel_height: 16,
                rel_rotation: 0,
                default_config: &[],
            },
            DefaultMachineTemplate {
                class_path: "/Game/Blueprints/Machines/BPO_ElevatorFiller.BPO_ElevatorFiller_C",
                rel_x: 0,
                rel_y: -18,
                rel_height: 16,
                rel_rotation: 1,
                default_config: &[],
            },
            DefaultMachineTemplate {
                class_path: "/Game/Blueprints/Machines/BPO_ElevatorFiller.BPO_ElevatorFiller_C",
                rel_x: 18,
                rel_y: 0,
                rel_height: 16,
                rel_rotation: 2,
                default_config: &[],
            },
            DefaultMachineTemplate {
                class_path: "/Game/Blueprints/Machines/BPO_ElevatorFiller.BPO_ElevatorFiller_C",
                rel_x: 0,
                rel_y: 18,
                rel_height: 16,
                rel_rotation: 3,
                default_config: &[],
            },
        ],
        "BPO_StationTurretBlock_01" => &[
            DefaultMachineTemplate {
                class_path: "/Game/Blueprints/Machines/Weapons/BPO_StationTurret_01.BPO_StationTurret_01_C",
                rel_x: 0,
                rel_y: 0,
                rel_height: 12,
                rel_rotation: 0,
                default_config: &[],
            },
            DefaultMachineTemplate {
                class_path: "/Game/Blueprints/Machines/Weapons/BPO_StationTurret_01B.BPO_StationTurret_01B_C",
                rel_x: 0,
                rel_y: 0,
                rel_height: -8,
                rel_rotation: 0,
                default_config: &[],
            },
        ],
        "BPO_Dock" => &[DefaultMachineTemplate {
            class_path: "/Game/Blueprints/Machines/Docks/BPO_StationBlockDock.BPO_StationBlockDock_C",
            rel_x: 16,
            rel_y: 0,
            rel_height: 0,
            rel_rotation: 2,
            default_config: EMPTY_DOCK_CONFIG,
        }],
        "BPO_Dock_2" => &[DefaultMachineTemplate {
            class_path: "/Game/Blueprints/Machines/Docks/BPO_IndustrialDock.BPO_IndustrialDock_C",
            rel_x: 64,
            rel_y: 0,
            rel_height: 0,
            rel_rotation: 2,
            default_config: EMPTY_DOCK_CONFIG,
        }],
        "BPO_MiningDroneBayBlock" => &[DefaultMachineTemplate {
            class_path: "/Game/Blueprints/Machines/BPO_MiningDroneBay.BPO_MiningDroneBay_C",
            rel_x: 0,
            rel_y: 0,
            rel_height: 0,
            rel_rotation: 0,
            default_config: EMPTY_MINING_CONFIG,
        }],
        "BPO_MiningDroneBayBlock_2" => &[DefaultMachineTemplate {
            class_path: "/Game/Blueprints/Machines/BPO_MiningDroneBay_2.BPO_MiningDroneBay_2_C",
            rel_x: 0,
            rel_y: 0,
            rel_height: 0,
            rel_rotation: 0,
            default_config: EMPTY_MINING_CONFIG,
        }],
        "BPO_SolarPanelBlock" => &[DefaultMachineTemplate {
            class_path: "/Game/Blueprints/Machines/BPO_SolarPanel.BPO_SolarPanel_C",
            rel_x: 0,
            rel_y: 0,
            rel_height: 0,
            rel_rotation: 0,
            default_config: &[],
        }],
        "BPO_SolarPanelBlock_02" => &[DefaultMachineTemplate {
            class_path: "/Game/Blueprints/Machines/BPO_SolarPanel_02.BPO_SolarPanel_02_C",
            rel_x: 0,
            rel_y: 0,
            rel_height: 0,
            rel_rotation: 0,
            default_config: &[],
        }],
        "BPO_SolarPanelBlock_03" => &[DefaultMachineTemplate {
            class_path: "/Game/Blueprints/Machines/BPO_SolarPanel_03.BPO_SolarPanel_03_C",
            rel_x: 0,
            rel_y: 0,
            rel_height: 0,
            rel_rotation: 0,
            default_config: &[],
        }],
        "BPO_DeepSpaceObservatory" => &[DefaultMachineTemplate {
            class_path: "/Game/Blueprints/Machines/BPO_DeepSpaceObservatoryMachine.BPO_DeepSpaceObservatoryMachine_C",
            rel_x: -32,
            rel_y: 0,
            rel_height: 0,
            rel_rotation: 0,
            default_config: &[],
        }],
        "BPO_ShipyardCore" => &[DefaultMachineTemplate {
            class_path: "/Game/Blueprints/Machines/Docks/BPO_ShipyardBlockDock.BPO_ShipyardBlockDock_C",
            rel_x: 16,
            rel_y: 0,
            rel_height: 0,
            rel_rotation: 2,
            default_config: EMPTY_DOCK_CONFIG,
        }],
        "BPO_ShipyardCore_02" => &[DefaultMachineTemplate {
            class_path: "/Game/Blueprints/Machines/Docks/BPO_ShipyardBlockDock_02.BPO_ShipyardBlockDock_02_C",
            rel_x: 32,
            rel_y: 0,
            rel_height: 0,
            rel_rotation: 2,
            default_config: EMPTY_DOCK_CONFIG,
        }],
        _ => &[],
    }
}
