use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use ms_blueprint_codec::{
    canonical_to_sav_bytes, sav_bytes_to_canonical, BlueprintDocument, NativeExportMode,
};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

#[derive(Parser, Debug)]
#[command(name = "ms-blueprint-codec", version, about = "Main Sequence native .sav <-> Canonical Blueprint JSON codec")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(ValueEnum, Clone, Copy, Debug)]
enum ExportModeArg {
    Station,
    Preset,
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

fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::ToJson { input, output } => {
            if input == output {
                bail!("input and output paths must differ");
            }
            let raw = fs::read(&input).with_context(|| format!("failed to read {}", input.display()))?;
            let (doc, report) = sav_bytes_to_canonical(&raw)?;
            let text = serde_json::to_string_pretty(&doc)? + "\n";
            atomic_write(&output, text.as_bytes())?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Commands::ToSav { input, output, mode } => {
            if input == output {
                bail!("input and output paths must differ");
            }
            let text = fs::read_to_string(&input)
                .with_context(|| format!("failed to read {}", input.display()))?;
            let doc: BlueprintDocument = serde_json::from_str(&text)
                .with_context(|| format!("invalid canonical blueprint JSON: {}", input.display()))?;
            let export_mode = match mode {
                ExportModeArg::Station => NativeExportMode::Station,
                ExportModeArg::Preset => NativeExportMode::StationPreset,
            };
            let (sav_bytes, report) = canonical_to_sav_bytes(&doc, export_mode)?;
            atomic_write(&output, &sav_bytes)?;
            println!("{}", serde_json::to_string(&report)?);
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
