# ms-blueprint-codec

Shared Rust + WebAssembly blueprint codec for *Main Sequence* (`Build 26639889`), providing lossless bidirectional conversion between:

- **Main Sequence native GVAS `.sav` design files** (`STATION` full designs and `STATION_PRESET` partial payloads)
- **Canonical Blueprint JSON (`station-blueprint-designer` formatVersion 2)** shared across the offline web workbench (`apps/station-blueprint-designer`) and in-game Mod ecosystem (`apps/station-section-blueprints`).

## Features

- **100% Catalog Coverage**: Maps all 27 station modules (× 4 rotations), all 36 interior buildables/logistics pieces (× 4 rotations), all 83 recipes, and all 81 items verified against `Build 26639889`.
- **Full Native Machine Binary Configs**: Encodes and decodes all 7 `SerializedMachineConfig` binary layouts with 2-hop fixed-point stability (crafter & Deep Space Observatory recipes, splitter port toggles/priorities/filters, balancer lane priorities/filters, container filters & creative metadata, 2/8-slot dock port filters & names, mining drone targets, elevator/teleporter labels, underground belt lengths & partner pairs).
- **Dual Target**:
  - Native CLI binary (`ms-blueprint-cli`) for local batch conversion and Mod integration.
  - Zero-dependency `wasm32-unknown-unknown` module (`ms_blueprint_codec.wasm`) bundled directly into the offline browser workbench.

## Build & Test

Run full deterministic coverage & round-trip tests:

```bash
cargo test --manifest-path packages/ms-blueprint-codec/Cargo.toml
```

Build the WebAssembly bundle for `apps/station-blueprint-designer`:

```bash
rustup target add wasm32-unknown-unknown
cargo build --manifest-path packages/ms-blueprint-codec/Cargo.toml --target wasm32-unknown-unknown --release --no-default-features --features wasm
```

## CLI Usage

```bash
# Decode a native Main Sequence .sav file into Canonical JSON
cargo run --manifest-path packages/ms-blueprint-codec/Cargo.toml -- to-json --input input.sav --output output.json

# Encode Canonical JSON into a native .sav file (station or preset)
cargo run --manifest-path packages/ms-blueprint-codec/Cargo.toml -- to-sav --input input.json --output output.sav --mode station
```

## License & Notice

Original Rust source code in this package is licensed under the repository root [MIT License](../../LICENSE). Game identifiers, item/recipe names, and catalog metadata in `data/catalog-26639889.json` are third-party game data excluded from MIT; see [NOTICE](../../NOTICE).
