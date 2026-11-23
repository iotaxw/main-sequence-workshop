//! Zero-dependency raw WASM C-ABI bindings (`target_arch = "wasm32"`).
//! Caller allocates input buffer via `wasm_alloc`, invokes `wasm_sav_to_json` or `wasm_json_to_sav`,
//! reads output via `wasm_result_ptr`/`wasm_result_len` (or error via `wasm_error_ptr`/`wasm_error_len`),
//! and frees input via `wasm_dealloc`.

use std::cell::RefCell;

use crate::canonical::{BlueprintDocument, NativeExportMode};
use crate::convert::{canonical_to_sav_bytes, sav_bytes_to_canonical};

thread_local! {
    static RESULT_BUF: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static ERROR_BUF: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_result(bytes: Vec<u8>) {
    RESULT_BUF.with(|b| *b.borrow_mut() = bytes);
    ERROR_BUF.with(|e| e.borrow_mut().clear());
}

fn set_error(msg: String) {
    RESULT_BUF.with(|b| b.borrow_mut().clear());
    ERROR_BUF.with(|e| *e.borrow_mut() = msg.into_bytes());
}

#[no_mangle]
pub extern "C" fn wasm_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let ptr = v.as_mut_ptr();
    std::mem::forget(v);
    ptr
}

#[no_mangle]
pub unsafe extern "C" fn wasm_dealloc(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        let _ = Vec::from_raw_parts(ptr, 0, len);
    }
}

#[no_mangle]
pub extern "C" fn wasm_result_ptr() -> *const u8 {
    RESULT_BUF.with(|b| b.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_result_len() -> usize {
    RESULT_BUF.with(|b| b.borrow().len())
}

#[no_mangle]
pub extern "C" fn wasm_error_ptr() -> *const u8 {
    ERROR_BUF.with(|e| e.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_error_len() -> usize {
    ERROR_BUF.with(|e| e.borrow().len())
}

/// Converts native `.sav` GVAS bytes into UTF-8 JSON `{ "doc": BlueprintDocument, "report": ConversionReport }`.
/// Returns 1 on success, 0 on error.
#[no_mangle]
pub unsafe extern "C" fn wasm_sav_to_json(ptr: *const u8, len: usize) -> i32 {
    let input = std::slice::from_raw_parts(ptr, len);
    match sav_bytes_to_canonical(input) {
        Ok((doc, report)) => {
            let payload = serde_json::json!({ "doc": doc, "report": report });
            match serde_json::to_vec(&payload) {
                Ok(bytes) => {
                    set_result(bytes);
                    1
                }
                Err(e) => {
                    set_error(format!("json encode failed: {e}"));
                    0
                }
            }
        }
        Err(e) => {
            set_error(format!("{e:#}"));
            0
        }
    }
}

/// Converts canonical BlueprintDocument UTF-8 JSON bytes into native `.sav` GVAS bytes.
/// `mode`: 0 = STATION (full standalone Designs/*.sav), 1 = STATION_PRESET (partial preset).
/// Returns 1 on success (result buffer holds raw `.sav` bytes, error buffer holds JSON ConversionReport), 0 on error.
#[no_mangle]
pub unsafe extern "C" fn wasm_json_to_sav(ptr: *const u8, len: usize, mode: i32) -> i32 {
    let input = std::slice::from_raw_parts(ptr, len);
    let doc: BlueprintDocument = match serde_json::from_slice(input) {
        Ok(d) => d,
        Err(e) => {
            set_error(format!("invalid canonical blueprint JSON: {e}"));
            return 0;
        }
    };
    let export_mode = if mode == 1 {
        NativeExportMode::StationPreset
    } else {
        NativeExportMode::Station
    };
    match canonical_to_sav_bytes(&doc, export_mode) {
        Ok((sav_bytes, report)) => {
            RESULT_BUF.with(|b| *b.borrow_mut() = sav_bytes);
            // Store report JSON in ERROR_BUF on success so caller can inspect warnings!
            let rep_bytes = serde_json::to_vec(&report).unwrap_or_default();
            ERROR_BUF.with(|e| *e.borrow_mut() = rep_bytes);
            1
        }
        Err(e) => {
            set_error(format!("{e:#}"));
            0
        }
    }
}
