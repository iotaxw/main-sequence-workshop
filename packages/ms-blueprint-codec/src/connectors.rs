use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use crate::canonical::{BlueprintDocument, PlacedModule};
use crate::catalog_map::catalog;

pub fn rotate_xy(x: i32, y: i32, rot: u8) -> (i32, i32) {
    match rot % 4 {
        0 => (x, y),
        1 => (-y, x),
        2 => (-x, -y),
        _ => (y, -x),
    }
}

pub fn module_rotated_size(module_type: &str, rot: u8) -> (i32, i32) {
    let (w, d) = catalog()
        .modules_by_id
        .get(module_type)
        .map(|m| (m.size_units[0], m.size_units[1]))
        .unwrap_or((1, 1));
    if rot % 2 == 1 {
        (d, w)
    } else {
        (w, d)
    }
}

pub fn module_to_native_transform(m: &PlacedModule) -> (i32, i32, i32, u8) {
    let (wu, du) = module_rotated_size(&m.module_type, m.rotation);
    let bx = 4 * m.gx + 2 * wu - 2;
    let by = 4 * m.gy + 2 * du - 2;
    let bh = if m.module_type == "BPO_StationArmour_01B" {
        (m.floor + 1) * 2
    } else {
        m.floor * 2
    };
    (bx, by, bh, m.rotation % 4)
}

/// Synthesizes exterior connector bulkhead caps (`Connectors_0`) for exposed/open module connectors,
/// matching Main Sequence's native `STATION` DesignSaveGame structure.
pub fn synthesize_connectors(modules: &[PlacedModule]) -> Vec<Value> {
    // Track horizontal connectors: (cx, cy, ch, rot) -> conn_type
    let mut horiz: HashMap<(i32, i32, i32, u8), String> = HashMap::new();
    // Track vertical connectors: (cx, cy, ch, is_top) -> conn_type
    let mut vert: HashMap<(i32, i32, i32, bool), String> = HashMap::new();

    for m in modules {
        let Some(def) = catalog().modules_by_id.get(&m.module_type) else {
            continue;
        };
        let (bx, by, bh, rot) = module_to_native_transform(m);
        for c in &def.connectors {
            let (rx, ry) = rotate_xy(c.gx, c.gy, rot);
            let cx = bx + rx;
            let cy = by + ry;
            let ch = bh + c.floor_offset * 2;
            let crot = (c.rotation + rot) % 4;
            match c.conn_type.as_str() {
                "Vertical1x1" | "Vertical2x2" => {
                    let is_top = c.floor_offset > 0;
                    vert.insert((cx, cy, ch, is_top), c.conn_type.clone());
                }
                _ => {
                    horiz.insert((cx, cy, ch, crot), c.conn_type.clone());
                }
            }
        }
    }

    let mut out = Vec::new();
    let mut emitted: HashSet<(String, i32, i32, i32, u8)> = HashSet::new();

    // Exposed horizontal connectors (no matching opposite-facing connector at same point)
    for (&(cx, cy, ch, crot), ctype) in &horiz {
        let opp = (crot + 2) % 4;
        if horiz.contains_key(&(cx, cy, ch, opp)) {
            continue;
        }
        let class_path = match ctype.as_str() {
            "Large" => "/Game/Blueprints/BuildingBlocks/BPO_LargeConnector.BPO_LargeConnector_C",
            "LargeSide" => "/Game/Blueprints/BuildingBlocks/BPO_LargeSideConnector.BPO_LargeSideConnector_C",
            // XLarge connectors (Observatory / ShipyardCore_02) or other special types
            _ => continue,
        };
        if emitted.insert((class_path.to_owned(), cx, cy, ch, crot)) {
            out.push(make_connector_entry(class_path, cx, cy, ch, crot));
        }
    }

    // Exposed vertical elevator caps (bottom cap when no top cap meets it; top cap when no bottom cap meets it)
    for (&(cx, cy, ch, is_top), ctype) in &vert {
        if vert.contains_key(&(cx, cy, ch, !is_top)) {
            continue;
        }
        let class_path = match (ctype.as_str(), is_top) {
            ("Vertical1x1", false) => "/Game/Blueprints/BuildingBlocks/BPO_Connector_08B.BPO_Connector_08B_C",
            ("Vertical1x1", true) => "/Game/Blueprints/BuildingBlocks/BPO_Connector_08T.BPO_Connector_08T_C",
            ("Vertical2x2", false) => "/Game/Blueprints/BuildingBlocks/BPO_Connector_07B.BPO_Connector_07B_C",
            ("Vertical2x2", true) => "/Game/Blueprints/BuildingBlocks/BPO_Connector_07T.BPO_Connector_07T_C",
            _ => continue,
        };
        if emitted.insert((class_path.to_owned(), cx, cy, ch, 0)) {
            out.push(make_connector_entry(class_path, cx, cy, ch, 0));
        }
    }

    // Stable deterministic order
    out.sort_by(|a, b| {
        let key = |v: &Value| {
            (
                v["Class_0"].as_str().unwrap_or("").to_owned(),
                v["Transform_0"]["Height_0"].as_i64().unwrap_or(0),
                v["Transform_0"]["GridLocation_0"]["x"].as_i64().unwrap_or(0),
                v["Transform_0"]["GridLocation_0"]["y"].as_i64().unwrap_or(0),
                v["Transform_0"]["GridRotation_0"].as_i64().unwrap_or(0),
            )
        };
        key(a).cmp(&key(b))
    });

    out
}

fn make_connector_entry(class_path: &str, x: i32, y: i32, height: i32, rot: u8) -> Value {
    json!({
        "Class_0": class_path,
        "Transform_0": {
            "GridLocation_0": { "x": x, "y": y },
            "Height_0": height,
            "GridRotation_0": rot as i32
        },
        "BlockID_0": 0,
        "PaletteID_0": 0,
        "DefaultMachines_0": []
    })
}

/// Renders a crisp 256x256 top-down greyscale preview thumbnail (`BlueprintScreenshot`) for the native Designs browser.
pub fn render_topdown_screenshot(doc: &BlueprintDocument) -> Value {
    const W: usize = 256;
    const H: usize = 256;
    let mut pixels = vec![14i32; W * H];

    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;

    for m in &doc.modules {
        let (wu, du) = module_rotated_size(&m.module_type, m.rotation);
        let x0 = (m.gx * 16) as f64;
        let y0 = (m.gy * 16) as f64;
        min_x = min_x.min(x0);
        max_x = max_x.max(x0 + (wu * 16) as f64);
        min_y = min_y.min(y0);
        max_y = max_y.max(y0 + (du * 16) as f64);
    }
    for b in &doc.buildings {
        let (bw, bd) = catalog()
            .buildables_by_id
            .get(&b.building_type)
            .map(|d| if b.rotation % 2 == 1 { (d.size[1], d.size[0]) } else { (d.size[0], d.size[1]) })
            .unwrap_or((1, 1));
        min_x = min_x.min(b.x as f64);
        max_x = max_x.max((b.x + bw) as f64);
        min_y = min_y.min(b.y as f64);
        max_y = max_y.max((b.y + bd) as f64);
    }

    if !min_x.is_finite() {
        return json!({
            "Dimensions_0": { "x": W as i32, "y": H as i32 },
            "GreyscaleValues_0": pixels
        });
    }

    let span_x = (max_x - min_x).max(16.0);
    let span_y = (max_y - min_y).max(16.0);
    let span = span_x.max(span_y) * 1.16;
    let cx = (min_x + max_x) * 0.5;
    let cy = (min_y + max_y) * 0.5;
    let scale = (W as f64) / span;

    let mut fill_rect = |x0: f64, y0: f64, x1: f64, y1: f64, val: i32, border: i32| {
        let px0 = (((x0 - cx) * scale + (W as f64) * 0.5).floor() as isize).clamp(0, (W - 1) as isize) as usize;
        let px1 = (((x1 - cx) * scale + (W as f64) * 0.5).ceil() as isize).clamp(0, (W - 1) as isize) as usize;
        let py0 = (((y0 - cy) * scale + (H as f64) * 0.5).floor() as isize).clamp(0, (H - 1) as isize) as usize;
        let py1 = (((y1 - cy) * scale + (H as f64) * 0.5).ceil() as isize).clamp(0, (H - 1) as isize) as usize;
        for py in py0..=py1 {
            for px in px0..=px1 {
                let is_edge = px == px0 || px == px1 || py == py0 || py == py1;
                let c = if is_edge { border } else { val };
                let idx = py * W + px;
                if c > pixels[idx] {
                    pixels[idx] = c;
                }
            }
        }
    };

    for m in &doc.modules {
        let (wu, du) = module_rotated_size(&m.module_type, m.rotation);
        let x0 = (m.gx * 16) as f64 + 0.5;
        let y0 = (m.gy * 16) as f64 + 0.5;
        let x1 = (m.gx * 16 + wu * 16) as f64 - 0.5;
        let y1 = (m.gy * 16 + du * 16) as f64 - 0.5;
        fill_rect(x0, y0, x1, y1, 88, 165);
    }

    for b in &doc.buildings {
        let (bw, bd) = catalog()
            .buildables_by_id
            .get(&b.building_type)
            .map(|d| if b.rotation % 2 == 1 { (d.size[1], d.size[0]) } else { (d.size[0], d.size[1]) })
            .unwrap_or((1, 1));
        let is_belt = b.building_type.contains("Belt") || b.building_type.contains("Splitter");
        fill_rect(
            b.x as f64,
            b.y as f64,
            (b.x + bw) as f64,
            (b.y + bd) as f64,
            if is_belt { 170 } else { 225 },
            248,
        );
    }

    json!({
        "Dimensions_0": { "x": W as i32, "y": H as i32 },
        "GreyscaleValues_0": pixels
    })
}
