use ms_blueprint_codec::canonical::BlueprintDocument;
use ms_blueprint_codec::section::{NativeMachineBuildStep, SectionExtractReport};
use ms_blueprint_codec::{canonical_to_sav_bytes, sav_bytes_to_canonical, NativeExportMode};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

struct Cleanup(PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run_cli(mut command: Command) -> Output {
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "CLI failed\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

#[test]
fn extract_and_transform_section_cli_roundtrip() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("section-cli-smoke");
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).unwrap();
    let _cleanup = Cleanup(directory.clone());
    let whole_sav = directory.join("whole.sav");
    let section_json = directory.join("section.json");
    let section_sav = directory.join("section.sav");
    let transformed_json = directory.join("transformed.json");
    let transformed_sav = directory.join("transformed.sav");
    let plan_json = directory.join("plan.json");

    let doc: BlueprintDocument = serde_json::from_value(json!({
        "format": "station-blueprint-designer",
        "formatVersion": 2,
        "id": "cli_section_smoke",
        "name": "CLI section smoke",
        "gameData": { "buildId": "26639889", "catalogVersion": 1 },
        "modules": [{
            "id": "mod_1",
            "type": "BPO_Station_01",
            "gx": 2,
            "gy": 3,
            "floor": 1,
            "rotation": 0,
            "paletteId": 5,
            "nativeMeta": { "block_id": 1 }
        }],
        "buildings": [{
            "id": "machine",
            "type": "DAT_ConveyorBelt",
            "x": 34,
            "y": 50,
            "floor": 1,
            "rotation": 0,
            "paletteId": 3
        }]
    }))
    .unwrap();
    let (sav, _) = canonical_to_sav_bytes(&doc, NativeExportMode::Station).unwrap();
    fs::write(&whole_sav, sav).unwrap();
    let binary = env!("CARGO_BIN_EXE_ms-blueprint-cli");

    let extracted = run_cli({
        let mut command = Command::new(binary);
        command
            .arg("extract-section")
            .arg("--input")
            .arg(&whole_sav)
            .arg("--blocks")
            .arg("1")
            .arg("--include-machines")
            .arg("--name")
            .arg("CLI extracted")
            .arg("--output-sav")
            .arg(&section_sav)
            .arg("--output-json")
            .arg(&section_json);
        command
    });
    let report: SectionExtractReport = serde_json::from_slice(&extracted.stdout).unwrap();
    assert_eq!(report.selected_blocks, vec![1]);
    assert_eq!(report.kept_machines, 1);
    assert_eq!(
        (report.origin_gx, report.origin_gy, report.origin_floor),
        (2, 3, 1)
    );
    let section: BlueprintDocument =
        serde_json::from_slice(&fs::read(&section_json).unwrap()).unwrap();
    assert_eq!(section.name, "CLI extracted");
    assert_eq!(section.modules[0].palette_id, Some(5));
    assert_eq!((section.buildings[0].x, section.buildings[0].y), (2, 2));

    let transformed = run_cli({
        let mut command = Command::new(binary);
        command
            .arg("transform-section")
            .arg("--input")
            .arg(&section_sav)
            .arg("--dx")
            .arg("1")
            .arg("--dy")
            .arg("-2")
            .arg("--dfloor")
            .arg("1")
            .arg("--drot")
            .arg("1")
            .arg("--output-json")
            .arg(&transformed_json)
            .arg("--output-sav")
            .arg(&transformed_sav)
            .arg("--output-plan")
            .arg(&plan_json);
        command
    });
    let summary: Value = serde_json::from_slice(&transformed.stdout).unwrap();
    assert_eq!(summary["module_count"], 1);
    assert_eq!(summary["machine_build_plan_count"], 1);
    let transformed_doc: BlueprintDocument =
        serde_json::from_slice(&fs::read(&transformed_json).unwrap()).unwrap();
    assert_eq!(
        (
            transformed_doc.modules[0].gx,
            transformed_doc.modules[0].gy,
            transformed_doc.modules[0].floor,
            transformed_doc.modules[0].rotation
        ),
        (1, -2, 1, 1)
    );
    assert_eq!(
        (
            transformed_doc.buildings[0].x,
            transformed_doc.buildings[0].y,
            transformed_doc.buildings[0].floor,
            transformed_doc.buildings[0].rotation
        ),
        (29, -30, 1, 1)
    );
    let plan: Vec<NativeMachineBuildStep> =
        serde_json::from_slice(&fs::read(&plan_json).unwrap()).unwrap();
    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].palette_id, Some(3));
    assert_eq!(
        (plan[0].native_x, plan[0].native_y, plan[0].native_height),
        (43, -75, 16)
    );
    let (roundtrip, _) = sav_bytes_to_canonical(&fs::read(&transformed_sav).unwrap()).unwrap();
    assert_eq!(
        (
            roundtrip.modules[0].gx,
            roundtrip.modules[0].gy,
            roundtrip.modules[0].floor,
            roundtrip.modules[0].rotation
        ),
        (1, -2, 1, 1)
    );
    assert_eq!(
        (
            roundtrip.buildings[0].x,
            roundtrip.buildings[0].y,
            roundtrip.buildings[0].floor,
            roundtrip.buildings[0].rotation
        ),
        (29, -30, 1, 1)
    );
}
