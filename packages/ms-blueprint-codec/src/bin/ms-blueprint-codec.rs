use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use ms_blueprint_codec::{
    canonical_to_sav_bytes, extract_section_from_sav, sav_bytes_to_canonical, transform_section,
    BlueprintDocument, ExtractSectionOptions, NativeExportMode, SectionTransform,
};
use serde::Serialize;
use serde_json::json;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

#[derive(Parser, Debug)]
#[command(
    name = "ms-blueprint-codec",
    version,
    about = "Main Sequence native .sav <-> Canonical Blueprint JSON codec"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(ValueEnum, Clone, Copy, Debug)]
enum ExportModeArg {
    Station,
    Preset,
}

#[derive(ValueEnum, Clone, Copy, Debug)]
enum DocumentFormatArg {
    Json,
    Sav,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Convert a native Main Sequence DesignSaveGame (.sav) to Canonical Blueprint JSON
    ToJson {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    /// Convert a Canonical Blueprint JSON to a native Main Sequence DesignSaveGame (.sav)
    ToSav {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, value_enum, default_value = "station")]
        mode: ExportModeArg,
    },
    /// Extract selected station blocks and their fully contained machines as a STATION_PRESET section
    ExtractSection {
        #[arg(long)]
        input: PathBuf,
        #[arg(long, value_delimiter = ',', num_args = 1..)]
        blocks: Vec<i32>,
        #[arg(long)]
        include_machines: bool,
        #[arg(long)]
        anchor_block: Option<i32>,
        #[arg(long)]
        no_normalize_origin: bool,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        output_sav: Option<PathBuf>,
        #[arg(long)]
        output_json: Option<PathBuf>,
    },
    /// Rotate and translate a section, optionally emitting native placement steps
    TransformSection {
        #[arg(long)]
        input: PathBuf,
        #[arg(long, allow_hyphen_values = true)]
        dx: i32,
        #[arg(long, allow_hyphen_values = true)]
        dy: i32,
        #[arg(long, allow_hyphen_values = true)]
        dfloor: i32,
        #[arg(long, value_parser = clap::value_parser!(u8).range(0..=3))]
        drot: u8,
        #[arg(long, value_enum)]
        format: Option<DocumentFormatArg>,
        #[arg(long)]
        output_json: Option<PathBuf>,
        #[arg(long)]
        output_sav: Option<PathBuf>,
        #[arg(long)]
        output_plan: Option<PathBuf>,
    },
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("missing output parent directory")?;
    fs::create_dir_all(parent).context("failed to create output directory")?;
    let tmp = path.with_extension("tmp");
    let res = (|| -> Result<()> {
        let f = File::create(&tmp).context("failed to create temp output")?;
        let mut w = BufWriter::new(f);
        w.write_all(bytes)?;
        w.flush()?;
        drop(w);
        fs::rename(&tmp, path).context("failed to finalize output file")?;
        Ok(())
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let text = serde_json::to_string_pretty(value)? + "\n";
    atomic_write(path, text.as_bytes())
}

fn check_output_path(input: &Path, output: Option<&PathBuf>) -> Result<()> {
    if output.map(|path| path.as_path()) == Some(input) {
        bail!("input and output paths must differ");
    }
    Ok(())
}

fn read_transform_document(
    input: &Path,
    format: Option<DocumentFormatArg>,
) -> Result<(BlueprintDocument, Vec<String>)> {
    let detected = match format {
        Some(format) => format,
        None => match input
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("json") => DocumentFormatArg::Json,
            Some("sav") => DocumentFormatArg::Sav,
            _ => bail!(
                "cannot detect input format from extension; use --format json or --format sav"
            ),
        },
    };
    match detected {
        DocumentFormatArg::Json => {
            let text = fs::read_to_string(input)
                .with_context(|| format!("failed to read {}", input.display()))?;
            let document = serde_json::from_str(&text).with_context(|| {
                format!("invalid canonical blueprint JSON: {}", input.display())
            })?;
            Ok((document, Vec::new()))
        }
        DocumentFormatArg::Sav => {
            let raw =
                fs::read(input).with_context(|| format!("failed to read {}", input.display()))?;
            let (document, report) = sav_bytes_to_canonical(&raw)?;
            Ok((document, report.warnings))
        }
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::ToJson { input, output } => {
            if input == output {
                bail!("input and output paths must differ");
            }
            let raw =
                fs::read(&input).with_context(|| format!("failed to read {}", input.display()))?;
            let (doc, report) = sav_bytes_to_canonical(&raw)?;
            let text = serde_json::to_string_pretty(&doc)? + "\n";
            atomic_write(&output, text.as_bytes())?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Commands::ToSav {
            input,
            output,
            mode,
        } => {
            if input == output {
                bail!("input and output paths must differ");
            }
            let text = fs::read_to_string(&input)
                .with_context(|| format!("failed to read {}", input.display()))?;
            let doc: BlueprintDocument = serde_json::from_str(&text).with_context(|| {
                format!("invalid canonical blueprint JSON: {}", input.display())
            })?;
            let export_mode = match mode {
                ExportModeArg::Station => NativeExportMode::Station,
                ExportModeArg::Preset => NativeExportMode::StationPreset,
            };
            let (sav_bytes, report) = canonical_to_sav_bytes(&doc, export_mode)?;
            atomic_write(&output, &sav_bytes)?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Commands::ExtractSection {
            input,
            blocks,
            include_machines,
            anchor_block,
            no_normalize_origin,
            name,
            output_sav,
            output_json,
        } => {
            check_output_path(&input, output_sav.as_ref())?;
            check_output_path(&input, output_json.as_ref())?;
            let raw =
                fs::read(&input).with_context(|| format!("failed to read {}", input.display()))?;
            let result = extract_section_from_sav(
                &raw,
                &ExtractSectionOptions {
                    selected_block_ids: blocks,
                    include_machines,
                    normalize_origin: !no_normalize_origin,
                    anchor_block_id: anchor_block,
                    name,
                },
            )?;
            if let Some(output) = output_json {
                atomic_write_json(&output, &result.document)?;
            }
            if let Some(output) = output_sav {
                let (sav_bytes, _) =
                    canonical_to_sav_bytes(&result.document, NativeExportMode::StationPreset)?;
                atomic_write(&output, &sav_bytes)?;
            }
            println!("{}", serde_json::to_string(&result.report)?);
        }
        Commands::TransformSection {
            input,
            dx,
            dy,
            dfloor,
            drot,
            format,
            output_json,
            output_sav,
            output_plan,
        } => {
            check_output_path(&input, output_json.as_ref())?;
            check_output_path(&input, output_sav.as_ref())?;
            check_output_path(&input, output_plan.as_ref())?;
            let (document, mut warnings) = read_transform_document(&input, format)?;
            let transformed = transform_section(
                &document,
                &SectionTransform {
                    dgx: dx,
                    dgy: dy,
                    dfloor,
                    drot,
                },
            )?;
            if let Some(output) = output_json {
                atomic_write_json(&output, &transformed.document)?;
            }
            if let Some(output) = output_plan {
                atomic_write_json(&output, &transformed.machine_build_plan)?;
            }
            if let Some(output) = output_sav {
                let (sav_bytes, report) =
                    canonical_to_sav_bytes(&transformed.document, NativeExportMode::StationPreset)?;
                atomic_write(&output, &sav_bytes)?;
                warnings.extend(report.warnings);
            }
            println!(
                "{}",
                serde_json::to_string(&json!({
                    "module_count": transformed.document.modules.len(),
                    "canonical_building_count": transformed.document.buildings.len(),
                    "machine_build_plan_count": transformed.machine_build_plan.len(),
                    "dx": dx,
                    "dy": dy,
                    "dfloor": dfloor,
                    "drot": drot,
                    "warnings": warnings,
                }))?
            );
        }
    }
    Ok(())
}

fn main() {
    if let Err(err) = run() {
        eprintln!("ms-blueprint-codec: {err:#}");
        std::process::exit(1);
    }
}
