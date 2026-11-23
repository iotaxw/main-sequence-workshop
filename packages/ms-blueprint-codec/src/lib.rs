#![recursion_limit = "256"]

pub mod canonical;
pub mod catalog_map;
pub mod config_codec;
pub mod connectors;
pub mod convert;
pub mod gvas_template;

#[cfg(target_arch = "wasm32")]
pub mod wasm_api;

pub use canonical::{BlueprintDocument, ConversionReport, NativeExportMode};
pub use convert::{canonical_to_sav_bytes, sav_bytes_to_canonical};
