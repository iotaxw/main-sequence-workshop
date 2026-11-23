import { deserializeBlueprint, serializeBlueprint } from './codec';
import type { BlueprintDocument } from './types';
import wasmUrl from '../wasm/ms_blueprint_codec.wasm?url';

export interface NativeConversionReport {
  warnings: string[];
  module_count: number;
  building_count: number;
  native_machine_count: number;
  connector_count: number;
}

interface CodecWasmExports {
  memory: WebAssembly.Memory;
  wasm_alloc(len: number): number;
  wasm_dealloc(ptr: number, len: number): void;
  wasm_result_ptr(): number;
  wasm_result_len(): number;
  wasm_error_ptr(): number;
  wasm_error_len(): number;
  wasm_sav_to_json(ptr: number, len: number): number;
  wasm_json_to_sav(ptr: number, len: number, mode: number): number;
}

let wasmPromise: Promise<CodecWasmExports> | null = null;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

async function loadWasmBytes(): Promise<ArrayBuffer> {
  // Support Node/Vitest environment directly without requiring HTTP server
  if (typeof window === 'undefined' || typeof fetch !== 'function' || wasmUrl.startsWith('/@fs/') || wasmUrl.startsWith('file:')) {
    const fsMod = await import(/* @vite-ignore */ 'node:fs');
    const urlMod = await import(/* @vite-ignore */ 'node:url');
    const fileUrl = new URL('../wasm/ms_blueprint_codec.wasm', import.meta.url);
    const buf = fsMod.readFileSync(urlMod.fileURLToPath(fileUrl));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const resp = await fetch(wasmUrl);
  if (!resp.ok) {
    throw new Error(`加载原生蓝图编解码器 WASM 失败 (HTTP ${resp.status})`);
  }
  return resp.arrayBuffer();
}

async function getCodec(): Promise<CodecWasmExports> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const bytes = await loadWasmBytes();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      return instance.exports as unknown as CodecWasmExports;
    })().catch((err) => {
      wasmPromise = null;
      throw err;
    });
  }
  return wasmPromise;
}

function readResultBytes(codec: CodecWasmExports): Uint8Array {
  const ptr = codec.wasm_result_ptr();
  const len = codec.wasm_result_len();
  return new Uint8Array(codec.memory.buffer, ptr, len).slice();
}

function readErrorText(codec: CodecWasmExports): string {
  const ptr = codec.wasm_error_ptr();
  const len = codec.wasm_error_len();
  if (len === 0) return '';
  return textDecoder.decode(new Uint8Array(codec.memory.buffer, ptr, len));
}

/**
 * Decode a native Main Sequence DesignSaveGame (`.sav`) binary into our canonical `BlueprintDocument`
 * using the shared Rust/WASM `ms-blueprint-codec` core.
 */
export async function importNativeSav(
  savBytes: Uint8Array
): Promise<{ doc: BlueprintDocument; report: NativeConversionReport }> {
  const codec = await getCodec();
  const ptr = codec.wasm_alloc(savBytes.length);
  try {
    new Uint8Array(codec.memory.buffer, ptr, savBytes.length).set(savBytes);
    const ok = codec.wasm_sav_to_json(ptr, savBytes.length);
    if (!ok) {
      throw new Error(readErrorText(codec) || '原生 .sav 解析失败');
    }
    const rawJson = textDecoder.decode(readResultBytes(codec));
    const parsed = JSON.parse(rawJson) as { doc: BlueprintDocument; report: NativeConversionReport };
    const validated = deserializeBlueprint(JSON.stringify(parsed.doc));
    if (!validated.ok) {
      throw new Error(`导入结果校验失败：${validated.error}`);
    }
    return {
      doc: validated.doc,
      report: {
        ...parsed.report,
        warnings: [...parsed.report.warnings, ...validated.warnings],
      },
    };
  } finally {
    codec.wasm_dealloc(ptr, savBytes.length);
  }
}

/**
 * Encode our canonical `BlueprintDocument` into a native Main Sequence DesignSaveGame (`.sav`) binary
 * (`station` = full standalone `Designs/*.sav`, `preset` = partial `STATION_PRESET` for Mod paste).
 */
export async function exportNativeSav(
  doc: BlueprintDocument,
  mode: 'station' | 'preset' = 'station'
): Promise<{ bytes: Uint8Array; report: NativeConversionReport }> {
  const codec = await getCodec();
  const jsonBytes = textEncoder.encode(serializeBlueprint(doc));
  const ptr = codec.wasm_alloc(jsonBytes.length);
  try {
    new Uint8Array(codec.memory.buffer, ptr, jsonBytes.length).set(jsonBytes);
    const ok = codec.wasm_json_to_sav(ptr, jsonBytes.length, mode === 'preset' ? 1 : 0);
    if (!ok) {
      throw new Error(readErrorText(codec) || '导出原生 .sav 失败');
    }
    const savBytes = readResultBytes(codec);
    const reportText = readErrorText(codec);
    const report: NativeConversionReport = reportText
      ? (JSON.parse(reportText) as NativeConversionReport)
      : { warnings: [], module_count: doc.modules.length, building_count: doc.buildings.length, native_machine_count: 0, connector_count: 0 };
    return { bytes: savBytes, report };
  } finally {
    codec.wasm_dealloc(ptr, jsonBytes.length);
  }
}
