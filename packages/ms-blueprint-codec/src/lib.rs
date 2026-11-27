#![recursion_limit = "256"]

pub mod canonical;
pub mod catalog_map;
pub mod config_codec;
pub mod connectors;
pub mod convert;
pub mod gvas_template;
pub mod section;

#[cfg(target_arch = "wasm32")]
pub mod wasm_api;

pub use canonical::{BlueprintDocument, ConversionReport, NativeExportMode};
pub use convert::{canonical_to_sav_bytes, sav_bytes_to_canonical};
pub use section::{
    extract_section_from_doc, extract_section_from_sav, transform_section, ExcludedBuildingInfo,
    ExtractSectionOptions, ExtractSectionResult, NativeContainerBuildConfig, NativeMachineBuildStep,
    NativeSplitterBuildConfig, SectionExtractReport, SectionTransform, TransformedSectionPlan,
};
